/**
 * Tip Service for Pebeto Creator's Hub
 * 
 * Handles creator tips including:
 * - Processing tip transactions
 * - Fee calculation (5% platform fee)
 * - Wallet updates (sender, creator, admin profit wallet)
 * - Transaction recording
 * 
 * @module services/tipService
 */

const { calculateTip } = require('../services/feeService');
const {
  getOrCreateWallet,
  getAdminProfitWallet,
  recordTransaction,
  debitWallet,
  creditWallet,
  runInTransaction,
} = require('./walletService');
const { AppError } = require('../utils/errors');
const logger = require('../utils/logger');

// ============================================
// Constants
// ============================================

const MIN_TIP_AMOUNT = 1; // $1 USD minimum tip
const MAX_TIP_AMOUNT = 500; // $500 USD maximum tip per transaction
const DAILY_TIP_LIMIT = 5000; // $5000 USD max tips per day per user

// ============================================
// Main Tip Processing Function
// ============================================

/**
 * Process a tip from a user to a creator
 * 
 * @param {Object} params - Tip parameters
 * @param {Object} params.fromUser - User sending the tip (must have sufficient balance)
 * @param {string} params.toCreatorId - ID of the creator receiving the tip
 * @param {number} params.grossUsd - Gross tip amount in USD (before fee)
 * @param {string} params.idempotencyKey - Optional key to prevent duplicate tips
 * @returns {Promise<Object>} Transaction result with breakdown
 * @throws {AppError} If validation fails or insufficient funds
 */
async function processTip({ fromUser, toCreatorId, grossUsd, idempotencyKey = null }) {
  // ============================================
  // Input Validation
  // ============================================
  
  if (!fromUser || !fromUser._id) {
    throw new AppError('Sender information is required', 400);
  }
  
  if (!toCreatorId) {
    throw new AppError('Recipient creator ID is required', 400);
  }
  
  if (!grossUsd || grossUsd <= 0) {
    throw new AppError('Tip amount must be a positive number', 400);
  }
  
  // Prevent self-tipping
  if (String(fromUser._id) === String(toCreatorId)) {
    throw new AppError('You cannot tip yourself', 400);
  }
  
  // Validate tip amount limits
  if (grossUsd < MIN_TIP_AMOUNT) {
    throw new AppError(`Minimum tip amount is $${MIN_TIP_AMOUNT} USD`, 400);
  }
  
  if (grossUsd > MAX_TIP_AMOUNT) {
    throw new AppError(`Maximum tip amount is $${MAX_TIP_AMOUNT} USD per transaction`, 400);
  }
  
  // ============================================
  // Calculate Fee Breakdown
  // ============================================
  
  const breakdown = calculateTip(grossUsd);
  
  logger.debug('Tip calculation', {
    fromUserId: fromUser._id,
    toCreatorId,
    grossUsd,
    feeUsd: breakdown.feeUsd,
    netToCreatorUsd: breakdown.netToCreatorUsd,
    feeRate: breakdown.feeRate,
  });
  
  // ============================================
  // Get Wallets
  // ============================================
  
  const senderWallet = await getOrCreateWallet(fromUser._id);
  const creatorWallet = await getOrCreateWallet(toCreatorId);
  const { admin, wallet: profitWallet } = await getAdminProfitWallet();
  
  // ============================================
  // Check Balance
  // ============================================
  
  if (!profitWallet) {
    throw new AppError('Platform wallet not configured', 500);
  }
  
  if (senderWallet.balances.available < breakdown.grossUsd) {
    throw new AppError(
      `Insufficient balance. Need $${breakdown.grossUsd}. Available: $${senderWallet.balances.available}`,
      400
    );
  }
  
  // ============================================
  // Check Daily Tip Limit (Optional)
  // ============================================
  
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const todayTips = await getTodayTipTotal(fromUser._id, today);
  if (todayTips + grossUsd > DAILY_TIP_LIMIT) {
    throw new AppError(
      `Daily tip limit of $${DAILY_TIP_LIMIT} USD exceeded. You have tipped $${todayTips} today.`,
      400
    );
  }
  
  // ============================================
  // Check for Duplicate Transaction (Idempotency)
  // ============================================
  
  if (idempotencyKey) {
    const existingTx = await checkExistingTip(idempotencyKey);
    if (existingTx) {
      logger.warn('Duplicate tip attempt blocked', {
        idempotencyKey,
        fromUserId: fromUser._id,
        toCreatorId,
      });
      return {
        tipTx: existingTx,
        breakdown,
        isDuplicate: true,
        message: 'This tip has already been processed',
      };
    }
  }
  
  // ============================================
  // Execute Transaction
  // ============================================
  
  let tipTx;
  let feeTx;
  
  await runInTransaction(async (session) => {
    // Debit sender's available balance
    await debitWallet(senderWallet._id, 'available', breakdown.grossUsd, session);
    
    // Credit creator's tips balance
    await creditWallet(creatorWallet._id, 'tips', breakdown.netToCreatorUsd, session);
    
    // Credit platform fee to admin profit wallet
    await creditWallet(profitWallet._id, 'available', breakdown.feeUsd, session);
    
    // Record tip transaction (from sender to creator)
    tipTx = await recordTransaction(
      {
        type: 'tip',
        status: 'completed',
        fromUserId: fromUser._id,
        toUserId: toCreatorId,
        fromWalletId: senderWallet._id,
        toWalletId: creatorWallet._id,
        grossAmount: breakdown.grossUsd,
        feeAmount: breakdown.feeUsd,
        netAmount: breakdown.netToCreatorUsd,
        feeRate: breakdown.feeRate,
        feeSource: breakdown.feeSource,
        feeRecipient: admin._id,
        metadata: {
          idempotencyKey,
          timestamp: new Date().toISOString(),
        },
      },
      session
    );
    
    // Record platform fee transaction
    feeTx = await recordTransaction(
      {
        type: 'platform_fee',
        status: 'completed',
        fromUserId: fromUser._id,
        toUserId: admin._id,
        fromWalletId: senderWallet._id,
        toWalletId: profitWallet._id,
        grossAmount: breakdown.feeUsd,
        feeAmount: breakdown.feeUsd,
        netAmount: breakdown.feeUsd,
        feeRate: breakdown.feeRate,
        feeSource: 'tip',
        feeRecipient: admin._id,
        metadata: {
          idempotencyKey: idempotencyKey ? `${idempotencyKey}-fee` : null,
          parentTransactionId: tipTx._id,
        },
      },
      session
    );
  });
  
  // ============================================
  // Log Success
  // ============================================
  
  logger.info('Tip processed successfully', {
    tipTransactionId: tipTx._id,
    fromUserId: fromUser._id,
    toCreatorId,
    grossAmount: breakdown.grossUsd,
    feeAmount: breakdown.feeUsd,
    netAmount: breakdown.netToCreatorUsd,
  });
  
  // ============================================
  // Return Result
  // ============================================
  
  return {
    tipTx,
    feeTx,
    breakdown,
    isDuplicate: false,
    message: `Successfully tipped $${breakdown.netToCreatorUsd} to creator`,
  };
}

// ============================================
// Tip Preview Function
// ============================================

/**
 * Preview tip amount and fees (does not process)
 * 
 * @param {number} grossUsd - Gross tip amount in USD
 * @returns {Object} Preview breakdown
 */
function previewTip(grossUsd) {
  if (!grossUsd || grossUsd <= 0) {
    throw new AppError('Tip amount must be a positive number', 400);
  }
  
  const breakdown = calculateTip(grossUsd);
  
  return {
    grossAmount: breakdown.grossUsd,
    feeAmount: breakdown.feeUsd,
    feePercentage: breakdown.feePercentage,
    netToCreator: breakdown.netToCreatorUsd,
    creatorReceivesPercentage: breakdown.creatorReceivesPercentage,
    message: `Creator will receive $${breakdown.netToCreatorUsd} after ${breakdown.feePercentage} platform fee.`,
  };
}

// ============================================
// Helper Functions
// ============================================

/**
 * Get total tip amount sent by user today
 * 
 * @param {string} userId - User ID
 * @param {Date} startOfDay - Start of day timestamp
 * @returns {Promise<number>} Total tips today
 */
async function getTodayTipTotal(userId, startOfDay) {
  const Transaction = require('../models/Transaction');
  
  const result = await Transaction.aggregate([
    {
      $match: {
        fromUserId: userId,
        type: 'tip',
        status: 'completed',
        createdAt: { $gte: startOfDay },
      },
    },
    {
      $group: {
        _id: null,
        total: { $sum: '$grossAmount' },
      },
    },
  ]);
  
  return result.length > 0 ? result[0].total : 0;
}

/**
 * Check if a tip with given idempotency key already exists
 * 
 * @param {string} idempotencyKey - Idempotency key to check
 * @returns {Promise<Object|null>} Existing transaction or null
 */
async function checkExistingTip(idempotencyKey) {
  const Transaction = require('../models/Transaction');
  
  const existing = await Transaction.findOne({
    'metadata.idempotencyKey': idempotencyKey,
    type: 'tip',
  });
  
  return existing;
}

/**
 * Get tip statistics for a creator
 * 
 * @param {string} creatorId - Creator user ID
 * @param {string} period - Time period ('day', 'week', 'month', 'all')
 * @returns {Promise<Object>} Tip statistics
 */
async function getCreatorTipStats(creatorId, period = 'all') {
  const Transaction = require('../models/Transaction');
  
  let dateFilter = {};
  const now = new Date();
  
  if (period === 'day') {
    const startOfDay = new Date(now.setHours(0, 0, 0, 0));
    dateFilter = { createdAt: { $gte: startOfDay } };
  } else if (period === 'week') {
    const startOfWeek = new Date(now.setDate(now.getDate() - 7));
    dateFilter = { createdAt: { $gte: startOfWeek } };
  } else if (period === 'month') {
    const startOfMonth = new Date(now.setMonth(now.getMonth() - 1));
    dateFilter = { createdAt: { $gte: startOfMonth } };
  }
  
  const stats = await Transaction.aggregate([
    {
      $match: {
        toUserId: creatorId,
        type: 'tip',
        status: 'completed',
        ...dateFilter,
      },
    },
    {
      $group: {
        _id: null,
        totalReceived: { $sum: '$netAmount' },
        totalGross: { $sum: '$grossAmount' },
        totalFees: { $sum: '$feeAmount' },
        tipCount: { $sum: 1 },
        averageTip: { $avg: '$netAmount' },
        largestTip: { $max: '$netAmount' },
      },
    },
  ]);
  
  // Get top supporters
  const topSupporters = await Transaction.aggregate([
    {
      $match: {
        toUserId: creatorId,
        type: 'tip',
        status: 'completed',
        ...dateFilter,
      },
    },
    {
      $group: {
        _id: '$fromUserId',
        totalAmount: { $sum: '$netAmount' },
        tipCount: { $sum: 1 },
      },
    },
    { $sort: { totalAmount: -1 } },
    { $limit: 10 },
    {
      $lookup: {
        from: 'users',
        localField: '_id',
        foreignField: '_id',
        as: 'user',
      },
    },
    {
      $project: {
        userId: '$_id',
        totalAmount: 1,
        tipCount: 1,
        userEmail: { $arrayElemAt: ['$user.email', 0] },
        userUniqueCode: { $arrayElemAt: ['$user.uniqueCode', 0] },
      },
    },
  ]);
  
  const defaultStats = {
    totalReceived: 0,
    totalGross: 0,
    totalFees: 0,
    tipCount: 0,
    averageTip: 0,
    largestTip: 0,
  };
  
  return {
    period,
    ...(stats[0] || defaultStats),
    topSupporters,
  };
}

/**
 * Get tip history for a user (sent or received)
 * 
 * @param {string} userId - User ID
 * @param {Object} options - Pagination options
 * @returns {Promise<Object>} Tip history with pagination
 */
async function getTipHistory(userId, options = {}) {
  const Transaction = require('../models/Transaction');
  const { page = 1, limit = 20, direction = 'both' } = options;
  const skip = (page - 1) * limit;
  const effectiveLimit = Math.min(limit, 100);
  
  let match = { type: 'tip', status: 'completed' };
  
  if (direction === 'sent') {
    match.fromUserId = userId;
  } else if (direction === 'received') {
    match.toUserId = userId;
  } else {
    match.$or = [{ fromUserId: userId }, { toUserId: userId }];
  }
  
  const [transactions, total] = await Promise.all([
    Transaction.find(match)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(effectiveLimit)
      .populate('fromUserId', 'email uniqueCode profile.stageName profile.companyName')
      .populate('toUserId', 'email uniqueCode profile.stageName profile.companyName')
      .lean(),
    Transaction.countDocuments(match),
  ]);
  
  return {
    tips: transactions,
    pagination: {
      page,
      limit: effectiveLimit,
      total,
      pages: Math.ceil(total / effectiveLimit),
      hasMore: skip + transactions.length < total,
    },
  };
}

// ============================================
// Exports
// ============================================

module.exports = {
  processTip,
  previewTip,
  getCreatorTipStats,
  getTipHistory,
  getTodayTipTotal,
  checkExistingTip,
  MIN_TIP_AMOUNT,
  MAX_TIP_AMOUNT,
  DAILY_TIP_LIMIT,
};
