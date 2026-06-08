/**
 * Wallet Controller for Pebeto Creator's Hub
 * 
 * Handles all wallet-related operations including:
 * - Tips (creator support)
 * - Withdrawals
 * - Balance inquiries
 * - Transaction history
 * 
 * @module controllers/walletController
 */

const { validationResult } = require('express-validator');
const { processTip, getTipStats } = require('../services/walletService');
const { AppError } = require('../middleware/errorHandler');
const { FEE_RATES, MIN_WITHDRAWAL_USD } = require('../constants');
const logger = require('../utils/logger');

// ============================================
// Tip Controllers
// ============================================

/**
 * Send a tip from a fan to a creator
 * 
 * @route POST /api/wallet/tip
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
const sendTip = async (req, res, next) => {
  const requestId = req.id || Math.random().toString(36).substring(7);
  
  try {
    // Validate request body using express-validator
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array().map(e => ({ field: e.param, message: e.msg }))
      });
    }

    const { recipientUsername, recipientUniqueCode, amount, idempotencyKey } = req.body;
    const senderId = req.user._id;
    const senderRole = req.user.role;

    // Check if user is trying to tip themselves
    if (recipientUsername === req.user.username || recipientUniqueCode === req.user.uniqueCode) {
      return res.status(400).json({
        success: false,
        message: 'You cannot tip yourself'
      });
    }

    // Validate amount
    const tipAmount = parseFloat(amount);
    if (isNaN(tipAmount) || tipAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Tip amount must be a positive number'
      });
    }

    // Set tip limits
    const MIN_TIP_AMOUNT = 1; // Minimum $1 USD
    const MAX_TIP_AMOUNT = 500; // Maximum $500 USD per tip

    if (tipAmount < MIN_TIP_AMOUNT) {
      return res.status(400).json({
        success: false,
        message: `Minimum tip amount is $${MIN_TIP_AMOUNT} USD`
      });
    }

    if (tipAmount > MAX_TIP_AMOUNT) {
      return res.status(400).json({
        success: false,
        message: `Maximum tip amount is $${MAX_TIP_AMOUNT} USD per transaction`
      });
    }

    // Check idempotency (prevent duplicate processing)
    if (idempotencyKey) {
      const isProcessed = await checkIdempotencyKey(idempotencyKey, 'tip');
      if (isProcessed) {
        return res.status(409).json({
          success: false,
          message: 'This transaction has already been processed',
          idempotencyKey
        });
      }
    }

    // Process the tip with fee calculation
    const result = await processTip(
      senderId, 
      recipientUsername || recipientUniqueCode, 
      tipAmount,
      { idempotencyKey, requestId }
    );

    // Log successful tip
    logger.info('Tip processed successfully', {
      requestId,
      senderId,
      recipientId: result.recipientId,
      recipientUniqueCode: result.uniqueCode,
      grossAmount: result.grossAmount,
      feeAmount: result.feeAmount,
      netAmount: result.netAmount,
      idempotencyKey
    });

    // Return masked response to client
    res.json({
      success: true,
      data: {
        message: `Successfully tipped ${result.recipientName || result.username || 'creator'} $${result.netAmount.toFixed(2)} (after 5% platform fee)`,
        grossAmount: result.grossAmount,
        feeAmount: result.feeAmount,
        netAmount: result.netAmount,
        recipient: {
          uniqueCode: result.uniqueCode,
          stageName: result.stageName
        },
        transactionId: result.transactionId,
        timestamp: result.timestamp
      }
    });

  } catch (error) {
    logger.error('Tip processing failed', {
      requestId,
      error: error.message,
      stack: error.stack,
      userId: req.user?._id
    });
    next(error);
  }
};

/**
 * Get tip statistics for a user
 * 
 * @route GET /api/wallet/tips/stats
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
const getTipStats = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const { period = 'all' } = req.query; // 'day', 'week', 'month', 'year', 'all'
    
    const stats = await getTipStats(userId, period);
    
    res.json({
      success: true,
      data: {
        totalTipsReceived: stats.totalReceived,
        totalTipsSent: stats.totalSent,
        totalFeesPaid: stats.totalFees,
        averageTipAmount: stats.averageAmount,
        tipCount: stats.count,
        period,
        lastTipAt: stats.lastTipAt,
        topSupporters: stats.topSupporters
      }
    });
  } catch (error) {
    next(error);
  }
};

// ============================================
// Withdrawal Controllers
// ============================================

/**
 * Request a withdrawal from wallet
 * 
 * @route POST /api/wallet/withdraw
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
const requestWithdrawal = async (req, res, next) => {
  const requestId = req.id || Math.random().toString(36).substring(7);
  
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { amountUsd, amountLocal, currency, payoutMethod, payoutDetails, idempotencyKey } = req.body;
    const userId = req.user._id;
    
    // Determine withdrawal amount in USD
    let withdrawalAmountUsd = amountUsd;
    if (amountLocal && currency) {
      const rate = await getExchangeRate(currency);
      withdrawalAmountUsd = amountLocal / rate;
    }
    
    // Validate minimum withdrawal
    if (withdrawalAmountUsd < MIN_WITHDRAWAL_USD) {
      return res.status(400).json({
        success: false,
        message: `Minimum withdrawal amount is $${MIN_WITHDRAWAL_USD} USD`
      });
    }
    
    // Check idempotency
    if (idempotencyKey) {
      const isProcessed = await checkIdempotencyKey(idempotencyKey, 'withdrawal');
      if (isProcessed) {
        return res.status(409).json({
          success: false,
          message: 'This withdrawal request has already been processed'
        });
      }
    }
    
    // Validate payout details based on method
    const validationResult = validatePayoutDetails(payoutMethod, payoutDetails);
    if (!validationResult.valid) {
      return res.status(400).json({
        success: false,
        message: validationResult.message
      });
    }
    
    // Process withdrawal
    const result = await processWithdrawal(userId, withdrawalAmountUsd, {
      payoutMethod,
      payoutDetails,
      idempotencyKey,
      requestId
    });
    
    logger.info('Withdrawal processed', {
      requestId,
      userId,
      amount: withdrawalAmountUsd,
      method: payoutMethod,
      transactionId: result.transactionId
    });
    
    res.json({
      success: true,
      data: {
        message: `Withdrawal request submitted for $${withdrawalAmountUsd.toFixed(2)} via ${payoutMethod}`,
        amount: withdrawalAmountUsd,
        fee: result.fee,
        netAmount: result.netAmount,
        transactionId: result.transactionId,
        status: result.status,
        estimatedProcessingTime: result.estimatedTime
      }
    });
    
  } catch (error) {
    logger.error('Withdrawal failed', {
      requestId,
      error: error.message,
      userId: req.user?._id
    });
    next(error);
  }
};

/**
 * Get withdrawal history
 * 
 * @route GET /api/wallet/withdrawals
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
const getWithdrawalHistory = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const { limit = 50, offset = 0, status } = req.query;
    
    const history = await getWithdrawals(userId, {
      limit: Math.min(parseInt(limit), 100),
      offset: parseInt(offset),
      status
    });
    
    res.json({
      success: true,
      data: {
        withdrawals: history.withdrawals,
        pagination: {
          total: history.total,
          limit: parseInt(limit),
          offset: parseInt(offset),
          hasMore: history.hasMore
        }
      }
    });
  } catch (error) {
    next(error);
  }
};

// ============================================
// Balance Controllers
// ============================================

/**
 * Get wallet balance
 * 
 * @route GET /api/wallet/balance
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
const getBalance = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const userIdParam = req.query.userId;
    
    // Check if admin requesting another user's balance
    let targetUserId = userId;
    if (userIdParam && req.user.role === 'admin') {
      targetUserId = userIdParam;
    }
    
    const balance = await getWalletBalance(targetUserId);
    
    // Get exchange rates for local currency display
    const preferredCurrency = req.user.preferredCurrency || 'USD';
    const rates = await getExchangeRates();
    const localBalance = balance.available * (rates[preferredCurrency] || 1);
    
    res.json({
      success: true,
      data: {
        balances: {
          available: balance.available,
          escrow: balance.escrow,
          pending: balance.pending,
          total: balance.available + balance.escrow
        },
        display: {
          currency: preferredCurrency,
          available: localBalance.toFixed(2),
          escrow: (balance.escrow * (rates[preferredCurrency] || 1)).toFixed(2)
        },
        lastUpdated: balance.lastUpdated
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get transaction history
 * 
 * @route GET /api/wallet/transactions
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
const getTransactionHistory = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const { 
      limit = 50, 
      offset = 0, 
      type, // 'deposit', 'withdrawal', 'tip', 'campaign_fund', 'campaign_payment'
      startDate,
      endDate 
    } = req.query;
    
    const transactions = await getTransactions(userId, {
      limit: Math.min(parseInt(limit), 100),
      offset: parseInt(offset),
      type,
      startDate: startDate ? new Date(startDate) : null,
      endDate: endDate ? new Date(endDate) : null
    });
    
    res.json({
      success: true,
      data: {
        transactions: transactions.items,
        pagination: {
          total: transactions.total,
          limit: parseInt(limit),
          offset: parseInt(offset),
          hasMore: transactions.hasMore
        }
      }
    });
  } catch (error) {
    next(error);
  }
};

// ============================================
// Preview / Calculation Controllers
// ============================================

/**
 * Preview tip amount (calculate fee)
 * 
 * @route POST /api/wallet/tip/preview
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const previewTip = (req, res) => {
  try {
    const { amount } = req.body;
    const tipAmount = parseFloat(amount);
    
    if (isNaN(tipAmount) || tipAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid amount'
      });
    }
    
    const feeRate = FEE_RATES.TIP; // 5%
    const fee = tipAmount * feeRate;
    const netToCreator = tipAmount - fee;
    
    res.json({
      success: true,
      preview: {
        grossAmount: tipAmount,
        feeAmount: fee,
        feePercentage: feeRate * 100,
        netToCreator: netToCreator,
        creatorReceives: `${(1 - feeRate) * 100}% of tip`
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

/**
 * Preview withdrawal (calculate fees)
 * 
 * @route POST /api/wallet/withdraw/preview
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const previewWithdrawal = (req, res) => {
  try {
    const { amountUsd, amountLocal, currency } = req.body;
    
    let grossAmount = amountUsd;
    if (amountLocal && currency) {
      // Would need exchange rate here
      grossAmount = amountLocal / 130; // Placeholder rate
    }
    
    const feeRate = FEE_RATES.WITHDRAWAL; // 3%
    const fee = grossAmount * feeRate;
    const netAmount = grossAmount - fee;
    
    res.json({
      success: true,
      preview: {
        grossUsd: grossAmount,
        feeUsd: fee,
        feePercentage: feeRate * 100,
        netToUserUsd: netAmount,
        meetsMinimum: grossAmount >= MIN_WITHDRAWAL_USD,
        minimumRequired: MIN_WITHDRAWAL_USD
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// ============================================
// Helper Functions
// ============================================

/**
 * Validate payout details based on method
 * @param {string} method - Payout method (mpesa, paypal, swift)
 * @param {Object} details - Payout details object
 * @returns {Object} Validation result
 */
function validatePayoutDetails(method, details) {
  if (!details) {
    return { valid: false, message: 'Payout details are required' };
  }
  
  switch (method) {
    case 'mpesa':
      if (!details.phoneNumber) {
        return { valid: false, message: 'Phone number is required for M-Pesa' };
      }
      // Basic Kenyan phone number validation
      const phoneRegex = /^(254|\+254|0)[7-9][0-9]{8}$/;
      if (!phoneRegex.test(details.phoneNumber)) {
        return { valid: false, message: 'Invalid M-Pesa phone number format' };
      }
      break;
      
    case 'paypal':
      if (!details.paypalEmail) {
        return { valid: false, message: 'PayPal email is required' };
      }
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(details.paypalEmail)) {
        return { valid: false, message: 'Invalid email format for PayPal' };
      }
      break;
      
    case 'swift':
    case 'bank':
      if (!details.bankName) {
        return { valid: false, message: 'Bank name is required' };
      }
      if (!details.accountNumber) {
        return { valid: false, message: 'Account number is required' };
      }
      if (!details.accountHolderName) {
        return { valid: false, message: 'Account holder name is required' };
      }
      if (!details.swiftCode && method === 'swift') {
        return { valid: false, message: 'SWIFT/BIC code is required for international transfers' };
      }
      break;
      
    default:
      return { valid: false, message: `Unsupported payout method: ${method}` };
  }
  
  return { valid: true };
}

/**
 * Check idempotency key to prevent duplicate processing
 * @param {string} key - Idempotency key
 * @param {string} type - Transaction type
 * @returns {Promise<boolean>} True if already processed
 */
async function checkIdempotencyKey(key, type) {
  // This would typically use Redis or a database table
  // Placeholder implementation
  return false;
}

/**
 * Get exchange rate for currency
 * @param {string} currency - Currency code
 * @returns {Promise<number>} Exchange rate
 */
async function getExchangeRate(currency) {
  // This would fetch from cache or external API
  const rates = { USD: 1, KES: 130, EUR: 0.92, GBP: 0.79 };
  return rates[currency] || 1;
}

/**
 * Get all exchange rates
 * @returns {Promise<Object>} Exchange rates object
 */
async function getExchangeRates() {
  return { USD: 1, KES: 130, EUR: 0.92, GBP: 0.79 };
}

/**
 * Get wallet balance for a user
 * @param {string} userId - User ID
 * @returns {Promise<Object>} Balance object
 */
async function getWalletBalance(userId) {
  // This would call the wallet service
  return { available: 0, escrow: 0, pending: 0, lastUpdated: new Date() };
}

/**
 * Process withdrawal request
 * @param {string} userId - User ID
 * @param {number} amount - Amount in USD
 * @param {Object} options - Withdrawal options
 * @returns {Promise<Object>} Withdrawal result
 */
async function processWithdrawal(userId, amount, options) {
  // This would call the wallet service
  const fee = amount * FEE_RATES.WITHDRAWAL;
  return {
    transactionId: `txn_${Date.now()}`,
    amount,
    fee,
    netAmount: amount - fee,
    status: 'pending',
    estimatedTime: '1-3 business days'
  };
}

/**
 * Get withdrawals for a user
 * @param {string} userId - User ID
 * @param {Object} options - Query options
 * @returns {Promise<Object>} Withdrawals result
 */
async function getWithdrawals(userId, options) {
  return { withdrawals: [], total: 0, hasMore: false };
}

/**
 * Get transactions for a user
 * @param {string} userId - User ID
 * @param {Object} options - Query options
 * @returns {Promise<Object>} Transactions result
 */
async function getTransactions(userId, options) {
  return { items: [], total: 0, hasMore: false };
}

// ============================================
// Exports
// ============================================

module.exports = {
  // Tips
  sendTip,
  getTipStats,
  previewTip,
  
  // Withdrawals
  requestWithdrawal,
  getWithdrawalHistory,
  previewWithdrawal,
  
  // Balance
  getBalance,
  getTransactionHistory,
  
  // Helpers (for testing)
  validatePayoutDetails,
  checkIdempotencyKey
};
