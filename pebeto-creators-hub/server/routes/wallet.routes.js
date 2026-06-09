/**
 * Wallet Routes for Pebeto Creator's Hub
 * 
 * Handles wallet operations including deposits, withdrawals,
 * balance inquiries, transactions, and tips.
 * 
 * @module routes/wallet
 */

const express = require('express');
const crypto = require('crypto');
const { body, query, validationResult } = require('express-validator');
const { authenticate, authorize } = require('../middleware/auth');
const { attachFeeService } = require('../services/feeService');
const { AppError } = require('../utils/errors');
const { catchAsync } = require('../middleware/errorHandler');
const { getWalletBalance, getTransactionHistory } = require('../services/walletService');
const { previewWithdrawal, getWithdrawalHistory } = require('../services/withdrawalService');
const { previewDeposit } = require('../services/depositService');
const { sendTip } = require('../controllers/wallet.controller');
const { getRatesMap, convertUsdToLocal, convertLocalToUsd } = require('../services/exchangeRateService');
const { MIN_WITHDRAWAL_USD, FEE_RATES } = require('../services/feeService');
const Transaction = require('../models/Transaction');
const logger = require('../utils/logger');

const router = express.Router();
const publicRouter = express.Router();

// ============================================
// Validation Rules
// ============================================

const depositPreviewValidation = [
  body('intentUsd')
    .optional()
    .isFloat({ min: 1 })
    .withMessage('Intent amount must be at least $1'),
];

const withdrawalPreviewValidation = [
  body('amountUsd')
    .optional()
    .isFloat({ min: 0.01 })
    .withMessage('Amount must be at least $0.01'),
  body('amountLocal')
    .optional()
    .isFloat({ min: 0.01 })
    .withMessage('Local amount must be positive'),
  body('currency')
    .optional()
    .isString()
    .isLength({ min: 3, max: 3 }),
];

const tipValidation = [
  body('recipientUsername')
    .optional()
    .isString()
    .trim(),
  body('recipientUniqueCode')
    .optional()
    .isString()
    .trim(),
  body('amount')
    .isFloat({ min: 1 })
    .withMessage('Tip amount must be at least $1'),
];

const balanceValidation = [
  query('userId')
    .optional()
    .isMongoId()
    .withMessage('Invalid user ID'),
];

const transactionsValidation = [
  query('page')
    .optional()
    .isInt({ min: 1 })
    .withMessage('Page must be a positive integer')
    .toInt(),
  query('limit')
    .optional()
    .isInt({ min: 1, max: 100 })
    .withMessage('Limit must be between 1 and 100')
    .toInt(),
  query('type')
    .optional()
    .isIn(['deposit', 'withdrawal', 'tip', 'platform_fee', 'escrow_release'])
    .withMessage('Invalid transaction type'),
];

// ============================================
// Protected Routes (Require Authentication)
// ============================================

router.use(authenticate);
router.use(attachFeeService);

/**
 * GET /api/wallet/balance
 * Get user's wallet balance
 */
router.get('/balance', balanceValidation, catchAsync(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    throw new AppError(errors.array()[0].msg, 400);
  }

  const { userId } = req.query;
  let targetUserId = req.user._id;

  if (userId && req.user.role === 'admin') {
    targetUserId = userId;
  } else if (userId && req.user.role !== 'admin') {
    throw new AppError('Forbidden: Cannot view other users balances', 403);
  }

  const wallet = await getWalletBalance(targetUserId);
  const rates = await getRatesMap();
  const preferredCurrency = req.user.preferredCurrency || 'USD';
  const localBalance = convertUsdToLocal(wallet.balances.available, preferredCurrency, rates);

  res.json({
    success: true,
    data: {
      balances: {
        available: wallet.balances.available,
        pending: wallet.balances.pending || 0,
        escrow: wallet.balances.escrow,
        tips: wallet.balances.tips || 0,
        total: (wallet.balances.available || 0) + (wallet.balances.escrow || 0) + (wallet.balances.tips || 0),
      },
      display: {
        currency: preferredCurrency,
        available: localBalance.toFixed(2),
        escrow: convertUsdToLocal(wallet.balances.escrow || 0, preferredCurrency, rates).toFixed(2),
        tips: convertUsdToLocal(wallet.balances.tips || 0, preferredCurrency, rates).toFixed(2),
      },
      lastUpdated: wallet.updatedAt,
    },
  });
}));

/**
 * GET /api/wallet/exchange-rates
 * Get current exchange rates
 */
router.get('/exchange-rates', catchAsync(async (req, res) => {
  const rates = await getRatesMap();
  
  res.json({
    success: true,
    data: {
      base: 'USD',
      rates,
      timestamp: new Date().toISOString(),
    },
  });
}));

/**
 * POST /api/wallet/deposit/preview
 * Preview deposit fees
 */
router.post('/deposit/preview', depositPreviewValidation, catchAsync(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    throw new AppError(errors.array()[0].msg, 400);
  }

  const { intentUsd } = req.body;
  const preview = await previewDeposit(intentUsd);

  res.json({
    success: true,
    data: preview,
  });
}));

/**
 * POST /api/wallet/withdraw/preview
 * Preview withdrawal fees
 */
router.post('/withdraw/preview', withdrawalPreviewValidation, catchAsync(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    throw new AppError(errors.array()[0].msg, 400);
  }

  const { amountUsd, amountLocal, currency } = req.body;
  let usdAmount = amountUsd;

  if (amountLocal && currency) {
    const rates = await getRatesMap();
    usdAmount = convertLocalToUsd(amountLocal, currency, rates);
  }

  const preview = await previewWithdrawal(usdAmount, req.user.role);

  res.json({
    success: true,
    data: preview,
  });
}));

/**
 * GET /api/wallet/transactions
 * Get user's transaction history
 */
router.get('/transactions', transactionsValidation, catchAsync(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    throw new AppError(errors.array()[0].msg, 400);
  }

  const page = parseInt(req.query.page) || 1;
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const { type, startDate, endDate } = req.query;

  const result = await getTransactionHistory(req.user._id, {
    page,
    limit,
    type,
    startDate: startDate ? new Date(startDate) : null,
    endDate: endDate ? new Date(endDate) : null,
  });

  const rates = await getRatesMap();
  const preferredCurrency = req.user.preferredCurrency || 'USD';

  const enrichedTransactions = (result.transactions || []).map(tx => ({
    ...tx,
    formattedAmount: convertUsdToLocal(tx.grossAmount || 0, preferredCurrency, rates).toFixed(2),
    displayCurrency: preferredCurrency,
  }));

  res.json({
    success: true,
    data: {
      transactions: enrichedTransactions,
      pagination: result.pagination,
    },
  });
}));

/**
 * GET /api/wallet/withdrawals
 * Get user's withdrawal history
 */
router.get('/withdrawals', transactionsValidation, catchAsync(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    throw new AppError(errors.array()[0].msg, 400);
  }

  const page = parseInt(req.query.page) || 1;
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const { startDate, endDate } = req.query;

  const result = await getWithdrawalHistory(req.user._id, {
    page,
    limit,
    startDate: startDate ? new Date(startDate) : null,
    endDate: endDate ? new Date(endDate) : null,
  });

  res.json({
    success: true,
    data: {
      withdrawals: result.withdrawals || [],
      pagination: result.pagination,
      summary: result.summary,
    },
  });
}));

/**
 * POST /api/wallet/tip
 * Send a tip to a creator
 */
router.post('/tip', tipValidation, catchAsync(async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    throw new AppError(errors.array()[0].msg, 400);
  }

  req.body.recipientUsername = req.body.recipientUsername || req.body.recipientUniqueCode;
  await sendTip(req, res, next);
}));

/**
 * POST /api/wallet/tip/preview
 * Preview tip amount and fees
 */
router.post('/tip/preview', catchAsync(async (req, res) => {
  const { amount } = req.body;
  
  if (!amount || amount <= 0) {
    throw new AppError('Amount must be a positive number', 400);
  }

  const feeRate = FEE_RATES.TIP;
  const fee = amount * feeRate;
  const netToCreator = amount - fee;

  res.json({
    success: true,
    data: {
      grossAmount: amount,
      feeAmount: fee,
      feePercentage: feeRate * 100,
      netToCreator: netToCreator,
      message: `Creator will receive ${netToCreator} after ${feeRate * 100}% platform fee`,
    },
  });
}));

// ============================================
// Public Routes (No Authentication)
// ============================================

/**
 * POST /api/wallet/mpesa-callback
 * M-Pesa payment callback endpoint (public)
 */
publicRouter.post('/mpesa-callback', catchAsync(async (req, res) => {
  try {
    const callbackData = req.body.Body?.stkCallback;
    
    if (!callbackData) {
      logger.warn('M-Pesa callback received with no stkCallback data');
      return res.status(200).json({ ResultCode: 0, ResultDesc: "Success" });
    }

    const { ResultCode, ResultDesc, CheckoutRequestID } = callbackData;

    logger.info('M-Pesa callback received', {
      checkoutRequestId: CheckoutRequestID,
      resultCode: ResultCode,
      resultDesc: ResultDesc,
    });

    const transaction = await Transaction.findOne({ 'metadata.checkoutRequestId': CheckoutRequestID });
    
    if (transaction) {
      if (ResultCode === 0) {
        transaction.status = 'completed';
      } else {
        transaction.status = 'failed';
        transaction.errorMessage = ResultDesc;
      }
      transaction.completedAt = new Date();
      await transaction.save();
    }

    res.status(200).json({ ResultCode: 0, ResultDesc: "Success" });
  } catch (err) {
    logger.error('M-Pesa callback error:', err);
    res.status(200).json({ ResultCode: 0, ResultDesc: "Success" });
  }
}));

/**
 * GET /api/wallet/payment-methods
 * Get available payment methods (public)
 */
publicRouter.get('/payment-methods', catchAsync(async (req, res) => {
  const methods = [
    {
      id: 'mpesa',
      name: 'M-Pesa',
      region: 'Kenya',
      type: 'mobile_money',
      minAmount: 1,
      maxAmount: 1150,
      feePercentage: 10,
      processingTime: 'Instant',
      enabled: true,
    },
    {
      id: 'paypal',
      name: 'PayPal',
      region: 'Global',
      type: 'digital_wallet',
      minAmount: 1,
      maxAmount: 10000,
      feePercentage: 10,
      processingTime: 'Instant',
      enabled: false,
    },
    {
      id: 'wire',
      name: 'Wire Transfer',
      region: 'International',
      type: 'bank_transfer',
      minAmount: 100,
      maxAmount: 50000,
      feePercentage: 10,
      processingTime: '2-5 business days',
      enabled: false,
    },
  ];

  res.json({
    success: true,
    data: methods,
  });
}));

// ============================================
// Exports
// ============================================

module.exports = { router, publicRouter };
