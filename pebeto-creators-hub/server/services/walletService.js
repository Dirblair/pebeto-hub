/**
 * Wallet Service for Pebeto Creator's Hub
 * 
 * Core wallet operations including:
 * - Wallet creation and retrieval
 * - Credit/debit operations with optimistic locking
 * - Transaction recording
 * - Admin profit wallet management
 * - Tip processing with fee calculation
 * 
 * @module services/walletService
 */

const { v4: uuidv4 } = require('uuid');
const mongoose = require('mongoose');
const Wallet = require('../models/Wallet');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const { AppError } = require('../utils/errors');
const { roundUsd, calculateTip } = require('../services/feeService');
const logger = require('../utils/logger');

// ============================================
// Constants
// ============================================

const WALLET_TYPES = {
  STANDARD: 'standard',
  PROFIT: 'profit',
  ESCROW: 'escrow',
};

const TRANSACTION_TYPES = {
  DEPOSIT: 'deposit',
  WITHDRAWAL: 'withdrawal',
  TIP: 'tip',
  PLATFORM_FEE: 'platform_fee',
  ESCROW_RELEASE: 'escrow_release',
  ESCROW_FUND: 'escrow_fund',
  ESCROW_REFUND: 'escrow_refund',
  ADJUSTMENT: 'adjustment',
};

const TRANSACTION_STATUS = {
  PENDING: 'pending',
  COMPLETED: 'completed',
  FAILED: 'failed',
  REVERSED: 'reversed',
};

// ============================================
// Wallet Creation & Retrieval
// ============================================

/**
 * Get or create a wallet for a user
 * @param {string} userId - User ID
 * @param {string} walletType - Type of wallet (standard, profit, escrow)
 * @returns {Promise<Object>} Wallet document
 */
async function getOrCreateWallet(userId, walletType = WALLET_TYPES.STANDARD) {
  if (!userId) {
    throw new AppError('User ID is required', 400);
  }

  // First, attempt to find the existing wallet
  let wallet = await Wallet.findOne({ userId, walletType });

  // If it exists, return it immediately
  if (wallet) {
    return wallet;
  }

  // If it doesn't exist, try to create one
  try {
    wallet = await Wallet.create({
      userId,
      walletType,
      currency: 'USD',
      balances: { available: 0, escrow: 0, tips: 0, pending: 0 },
      version: 0,
    });
    
    logger.debug('Wallet created', { userId, walletType, walletId: wallet._id });
    return wallet;
  } catch (err) {
    // If someone else created it in the millisecond between find and create,
    // the duplicate key error (11000) will fire. Catch it and perform one final find.
    if (err.code === 11000) {
      wallet = await Wallet.findOne({ userId, walletType });
      if (wallet) return wallet;
    }
    logger.error('Failed to create wallet', { userId, walletType, error: err.message });
    throw new AppError('Failed to create wallet', 500);
  }
}

/**
 * Get or create admin profit wallet
 * @returns {Promise<Object>} { admin, wallet }
 */
async function getAdminProfitWallet() {
  const admin = await User.findOne({ role: 'admin' });
  if (!admin) {
    throw new AppError('Admin account not configured. Please create an admin user first.', 500);
  }

  const wallet = await Wallet.findOneAndUpdate(
    { userId: admin._id, walletType: WALLET_TYPES.PROFIT },
    {
      $setOnInsert: {
        userId: admin._id,
        walletType: WALLET_TYPES.PROFIT,
        currency: 'USD',
        balances: { available: 0, escrow: 0, tips: 0, pending: 0 },
        version: 0,
      },
    },
    { new: true, upsert: true }
  );

  return { admin, wallet };
}

/**
 * Get wallet balance with optional user population
 * @param {string} userId - User ID
 * @param {boolean} populateUser - Whether to populate user details
 * @returns {Promise<Object>} Wallet with balances
 */
async function getWalletBalance(userId, populateUser = false) {
  const query = Wallet.findOne({ userId, walletType: WALLET_TYPES.STANDARD });
  
  if (populateUser) {
    query.populate('userId', 'email uniqueCode role profile.displayName profile.stageName profile.companyName');
  }
  
  const wallet = await query;
  
  if (!wallet) {
    // Return zero balance wallet if not found
    return {
      balances: { available: 0, pending: 0, escrow: 0, tips: 0 },
      currency: 'USD',
      updatedAt: new Date(),
    };
  }
  
  return wallet;
}

// ============================================
// Core Wallet Operations
// ============================================

/**
 * Credit funds to a wallet (with optimistic locking)
 * @param {string} walletId - Wallet ID
 * @param {string} field - Balance field to credit ('available', 'pending', 'escrow', 'tips')
 * @param {number} amount - Amount to credit
 * @param {Object} session - Mongoose session (optional)
 * @returns {Promise<Object>} Updated wallet
 */
async function creditWallet(walletId, field, amount, session = null) {
  const validFields = ['available', 'pending', 'escrow', 'tips'];
  if (!validFields.includes(field)) {
    throw new AppError(`Invalid balance field: ${field}`, 400);
  }

  const roundedAmount = roundUsd(amount);
  if (roundedAmount <= 0) {
    throw new AppError('Credit amount must be positive', 400);
  }

  const update = { $inc: { [`balances.${field}`]: roundedAmount } };
  const options = { new: true };
  if (session) options.session = session;

  const wallet = await Wallet.findByIdAndUpdate(walletId, update, options);
  
  if (!wallet) {
    throw new AppError('Wallet not found', 404);
  }

  logger.debug('Wallet credited', { walletId, field, amount: roundedAmount, newBalance: wallet.balances[field] });
  return wallet;
}

/**
 * Debit funds from a wallet (with optimistic locking and balance check)
 * @param {string} walletId - Wallet ID
 * @param {string} field - Balance field to debit ('available', 'pending', 'escrow', 'tips')
 * @param {number} amount - Amount to debit
 * @param {Object} session - Mongoose session (optional)
 * @returns {Promise<Object>} Updated wallet
 */
async function debitWallet(walletId, field, amount, session = null) {
  const validFields = ['available', 'pending', 'escrow', 'tips'];
  if (!validFields.includes(field)) {
    throw new AppError(`Invalid balance field: ${field}`, 400);
  }

  const roundedAmount = roundUsd(amount);
  if (roundedAmount <= 0) {
    throw new AppError('Debit amount must be positive', 400);
  }

  // Find wallet with current version for optimistic locking
  const wallet = await Wallet.findById(walletId).session(session);
  if (!wallet) {
    throw new AppError('Wallet not found', 404);
  }

  // Check sufficient balance
  if (wallet.balances[field] < roundedAmount) {
    throw new AppError(
      `Insufficient ${field} balance. Available: ${wallet.balances[field]}, Requested: ${roundedAmount}`,
      400
    );
  }

  // Perform update with version check
  const updated = await Wallet.findOneAndUpdate(
    { _id: walletId, version: wallet.version },
    {
      $inc: { [`balances.${field}`]: -roundedAmount, version: 1 },
    },
    { new: true, session }
  );

  if (!updated) {
    throw new AppError('Concurrency conflict: Wallet was modified. Please retry.', 409);
  }

  logger.debug('Wallet debited', { walletId, field, amount: roundedAmount, newBalance: updated.balances[field] });
  return updated;
}

/**
 * Debit from available balance first, then tips balance
 * @param {string} walletId - Wallet ID
 * @param {number} amount - Amount to debit
 * @param {Object} session - Mongoose session (optional)
 * @returns {Promise<Object>} Updated wallet
 */
async function debitWithdrawable(walletId, amount, session = null) {
  const roundedAmount = roundUsd(amount);
  if (roundedAmount <= 0) {
    throw new AppError('Debit amount must be positive', 400);
  }

  const wallet = await Wallet.findById(walletId).session(session);
  if (!wallet) {
    throw new AppError('Wallet not found', 404);
  }

  const totalWithdrawable = wallet.balances.available + wallet.balances.tips;
  if (totalWithdrawable < roundedAmount) {
    throw new AppError(
      `Insufficient withdrawable balance. Available: ${totalWithdrawable}, Requested: ${roundedAmount}`,
      400
    );
  }

  let remaining = roundedAmount;
  let fromAvailable = 0;
  let fromTips = 0;

  // First, deduct from available balance
  if (wallet.balances.available > 0) {
    fromAvailable = Math.min(wallet.balances.available, remaining);
    remaining -= fromAvailable;
  }

  // Then, deduct from tips balance if needed
  if (remaining > 0) {
    fromTips = remaining;
  }

  // Perform update with version check
  const updated = await Wallet.findOneAndUpdate(
    { _id: walletId, version: wallet.version },
    {
      $inc: {
        'balances.available': -fromAvailable,
        'balances.tips': -fromTips,
        version: 1,
      },
    },
    { new: true, session }
  );

  if (!updated) {
    throw new AppError('Concurrency conflict: Wallet was modified. Please retry.', 409);
  }

  logger.debug('Withdrawable debited', {
    walletId,
    amount: roundedAmount,
    fromAvailable,
    fromTips,
    newAvailable: updated.balances.available,
    newTips: updated.balances.tips,
  });

  return updated;
}

// ============================================
// Transaction Recording
// ============================================

/**
 * Record a transaction
 * @param {Object} entry - Transaction data
 * @param {Object} session - Mongoose session (optional)
 * @returns {Promise<Object>} Created transaction
 */
async function recordTransaction(entry, session = null) {
  const requiredFields = ['type', 'status', 'grossAmount', 'netAmount'];
  for (const field of requiredFields) {
    if (entry[field] === undefined) {
      throw new AppError(`Missing required transaction field: ${field}`, 400);
    }
  }

  const transaction = {
    transactionId: uuidv4(),
    ...entry,
    createdAt: new Date(),
  };

  const opts = session ? { session } : {};
  const [created] = await Transaction.create([transaction], opts);
  
  logger.debug('Transaction recorded', { transactionId: created.transactionId, type: created.type });
  return created;
}

/**
 * Get transaction by ID
 * @param {string} transactionId - Transaction ID
 * @returns {Promise<Object>} Transaction document
 */
async function getTransaction(transactionId) {
  const transaction = await Transaction.findOne({ transactionId })
    .populate('fromUserId', 'email uniqueCode role')
    .populate('toUserId', 'email uniqueCode role');
  
  if (!transaction) {
    throw new AppError('Transaction not found', 404);
  }
  
  return transaction;
}

/**
 * Get transaction history for a user
 * @param {string} userId - User ID
 * @param {Object} options - Pagination and filter options
 * @returns {Promise<Object>} Transactions with pagination
 */
async function getTransactionHistory(userId, options = {}) {
  const { page = 1, limit = 20, type, startDate, endDate, status = 'completed' } = options;
  const skip = (page - 1) * limit;
  const effectiveLimit = Math.min(limit, 100);

  const match = {
    $or: [{ fromUserId: userId }, { toUserId: userId }],
    status,
  };

  if (type) match.type = type;
  if (startDate) match.createdAt = { ...match.createdAt, $gte: new Date(startDate) };
  if (endDate) match.createdAt = { ...match.createdAt, $lte: new Date(endDate) };

  const [transactions, total] = await Promise.all([
    Transaction.find(match)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(effectiveLimit)
      .populate('fromUserId', 'email uniqueCode role profile.displayName')
      .populate('toUserId', 'email uniqueCode role profile.displayName')
      .lean(),
    Transaction.countDocuments(match),
  ]);

  return {
    transactions,
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
// Tip Processing
// ============================================

/**
 * Process a tip from a fan to a creator
 * @param {string} senderId - Sender user ID
 * @param {string} recipientId - Recipient creator ID
 * @param {number} amount - Tip amount in USD
 * @param {string} idempotencyKey - Optional idempotency key
 * @returns {Promise<Object>} Tip result
 */
async function processTip(senderId, recipientId, amount, idempotencyKey = null) {
  // Validate inputs
  if (!senderId || !recipientId) {
    throw new AppError('Sender and recipient are required', 400);
  }
  
  if (String(senderId) === String(recipientId)) {
    throw new AppError('You cannot tip yourself', 400);
  }
  
  const roundedAmount = roundUsd(amount);
  if (roundedAmount <= 0) {
    throw new AppError('Tip amount must be positive', 400);
  }

  // Calculate fee breakdown
  const breakdown = calculateTip(roundedAmount);

  // Get wallets
  const senderWallet = await getOrCreateWallet(senderId);
  const recipientWallet = await getOrCreateWallet(recipientId);
  const { admin, wallet: profitWallet } = await getAdminProfitWallet();

  // Check sufficient balance
  const totalWithdrawable = senderWallet.balances.available + senderWallet.balances.tips;
  if (totalWithdrawable < breakdown.grossUsd) {
    throw new AppError(
      `Insufficient balance. Need $${breakdown.grossUsd}. Available: $${totalWithdrawable}`,
      400
    );
  }

  // Process in transaction
  let tipTx, feeTx;

  await runInTransaction(async (session) => {
    // Debit sender (from available first, then tips)
    await debitWithdrawable(senderWallet._id, breakdown.grossUsd, session);

    // Credit recipient's tips balance
    await creditWallet(recipientWallet._id, 'tips', breakdown.netToCreatorUsd, session);

    // Credit platform fee to admin profit wallet
    await creditWallet(profitWallet._id, 'available', breakdown.feeUsd, session);

    // Record tip transaction
    tipTx = await recordTransaction(
      {
        type: TRANSACTION_TYPES.TIP,
        status: TRANSACTION_STATUS.COMPLETED,
        fromUserId: senderId,
        toUserId: recipientId,
        fromWalletId: senderWallet._id,
        toWalletId: recipientWallet._id,
        grossAmount: breakdown.grossUsd,
        feeAmount: breakdown.feeUsd,
        netAmount: breakdown.netToCreatorUsd,
        feeRate: breakdown.feeRate,
        feeSource: breakdown.feeSource,
        feeRecipient: admin._id,
        metadata: {
          idempotencyKey,
          tipBreakdown: breakdown,
        },
      },
      session
    );

    // Record platform fee transaction
    feeTx = await recordTransaction(
      {
        type: TRANSACTION_TYPES.PLATFORM_FEE,
        status: TRANSACTION_STATUS.COMPLETED,
        fromUserId: senderId,
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

  logger.info('Tip processed', {
    tipTransactionId: tipTx._id,
    fromUserId: senderId,
    toUserId: recipientId,
    amount: breakdown.grossUsd,
    fee: breakdown.feeUsd,
    netToCreator: breakdown.netToCreatorUsd,
  });

  return {
    success: true,
    tipTx,
    feeTx,
    breakdown,
    message: `Successfully tipped $${breakdown.netToCreatorUsd} to creator`,
  };
}

// ============================================
// Transaction Management
// ============================================

/**
 * Run a function within a database transaction
 * @param {Function} fn - Async function to run with session
 * @returns {Promise<any>} Result of the function
 */
async function runInTransaction(fn) {
  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    const result = await fn(session);
    await session.commitTransaction();
    return result;
  } catch (err) {
    await session.abortTransaction();
    logger.error('Transaction aborted', { error: err.message });
    throw err;
  } finally {
    session.endSession();
  }
}

/**
 * Get platform-wide wallet statistics
 * @returns {Promise<Object>} Statistics
 */
async function getPlatformWalletStats() {
  const stats = await Wallet.aggregate([
    {
      $group: {
        _id: '$walletType',
        totalAvailable: { $sum: '$balances.available' },
        totalEscrow: { $sum: '$balances.escrow' },
        totalTips: { $sum: '$balances.tips' },
        totalPending: { $sum: '$balances.pending' },
        walletCount: { $sum: 1 },
      },
    },
  ]);

  return stats;
}

// ============================================
// Exports
// ============================================

module.exports = {
  // Constants
  WALLET_TYPES,
  TRANSACTION_TYPES,
  TRANSACTION_STATUS,
  
  // Wallet operations
  getOrCreateWallet,
  getAdminProfitWallet,
  getWalletBalance,
  creditWallet,
  debitWallet,
  debitWithdrawable,
  
  // Transaction operations
  recordTransaction,
  getTransaction,
  getTransactionHistory,
  runInTransaction,
  
  // Tip processing
  processTip,
  
  // Admin/stats
  getPlatformWalletStats,
};
