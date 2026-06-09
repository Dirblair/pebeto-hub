/**
 * Wallet Routes for Pebeto Creator's Hub
 * 
 * Handles wallet operations including deposits, withdrawals,
 * balance inquiries, transactions, and tips.
 * 
 * @module routes/wallet
 */

const express = require('express');
const { body, query, validationResult } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const { attachFeeService } = require('../services/feeService');
const { AppError } = require('../utils/errors');
const { catchAsync } = require('../middleware/errorHandler');
const { getOrCreateWallet, getWalletBalance, getTransactionHistory } = require('../services/walletService');
const { processWithdrawal, previewWithdrawal, getWithdrawalHistory } = require('../services/withdrawalService');
const { processDeposit, initiateMpesaDeposit, previewDeposit } = require('../services/depositService');
const { sendTip } = require('../controllers/wallet.controller');
const { getRatesMap, convertUsdToLocal, convertLocalToUsd } = require('../services/exchangeRateService');
const { MIN_WITHDRAWAL_USD, FEE_RATES } = require('../services/feeService');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const logger = require('../utils/logger');

const router = express.Router();
const publicRouter = express.Router();

// ============================================
// Validation Rules
// ============================================

const depositValidation = [
  body('method')
    .isIn(['mpesa', 'paypal', 'bank', 'card'])
    .withMessage('Invalid payment method'),
  body('intentUsd')
    .optional()
    .isFloat({ min: 1 })
    .withMessage('Intent amount must be at least $1'),
  body('intentLocal')
    .optional()
    .isFloat({ min: 1 })
    .withMessage('Local amount must be positive'),
  body('currency')
    .optional()
    .isString()
    .isLength({ min: 3, max: 3 }),
  body('phoneNumber')
    .if(body('method').equals('mpesa'))
    .notEmpty()
    .withMessage('Phone number required for M-Pesa')
    .matches(/^(254|\+254|0)[7-9][0-9]{8}$/)
    .withMessage('Invalid Kenyan phone number format'),
  body('campaignId')
    .optional()
    .isMongoId()
    .withMessage('Invalid campaign ID'),
  body('idempotencyKey')
    .optional()
    .isString(),
];

const depositPreviewValidation = [
  body('intentUsd')
    .optional()
    .isFloat({ min: 1 })
    .withMessage('Intent amount must be at least $1'),
  body('intentLocal')
    .optional()
    .isFloat({ min: 1 })
    .withMessage('Local amount must be positive'),
  body('currency')
    .optional()
    .isString()
    .isLength({ min: 3, max: 3 }),
];

const withdrawalValidation = [
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
  body('payoutMethod')
    .isIn(['mpesa', 'paypal', 'swift', 'bank_transfer'])
    .withMessage('Invalid payout method'),
  body('payoutDetails')
    .isObject()
    .withMessage('Payout details are required'),
  body('idempotencyKey')
    .optional()
    .isString(),
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
  body('idempotencyKey')
    .optional()
    .isString(),
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
  query('startDate')
    .optional()
    .isISO8601()
    .withMessage('Invalid start date'),
  query('endDate')
    .optional()
    .isISO8601()
    .withMessage('Invalid end date'),
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
router.get('/balance', balanceValidation, catchAsync(async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    throw new AppError(errors.array()[0].msg, 400);
  }

  const { userId } = req.query;
  let targetUserId = req.user._id;

  // Admin can view other users' balances
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
        pending: wallet.balances.pending,
        escrow: wallet.balances.escrow,
        tips: wallet.balances.tips,
        total: wallet.balances.available + wallet.balances.escrow + wallet.balances.tips,
      },
      display: {
        currency: preferredCurrency,
        available: localBalance.toFixed(2),
        escrow: convertUsdToLocal(wallet.balances.escrow, preferredCurrency, rates).toFixed(2),
        tips: convertUsdToLocal(wallet.balances.tips, preferredCurrency, rates).toFixed(2),
      },
      lastUpdated: wallet.updatedAt,
    },
  });
}));

/**
 * GET /api/wallet/exchange-rates
 * Get current exchange rates
 */
router.get('/exchange-rates', catchAsync(async (req, res, next) => {
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
 * Preview deposit fees before making deposit
 */
router.post('/deposit/preview', depositPreviewValidation, catchAsync(async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    throw new AppError(errors.array()[0].msg, 400);
  }

  if (req.user.role !== 'business') {
    throw new AppError('Only businesses can preview deposits', 403);
  }

  const { intentUsd, intentLocal, currency } = req.body;
  let usdAmount = intentUsd;

  if (intentLocal && currency) {
    const rates = await getRatesMap();
    usdAmount = convertLocalToUsd(intentLocal, currency, rates);
  }

  const preview = await previewDeposit(usdAmount);

  res.json({
    success: true,
    data: preview,
  });
}));

/**
 * POST /api/wallet/deposit
 * Make a deposit to wallet
 */
router.post('/deposit', depositValidation, catchAsync(async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    throw new AppError(errors.array()[0].msg, 400);
  }

  if (req.user.role !== 'business') {
    throw new AppError('Only businesses can deposit funds', 403);
  }

  const { method, intentUsd, intentLocal, currency, campaignId, phoneNumber, idempotencyKey } = req.body;
  const businessUser = req.user;

  // Determine USD amount
  let usdAmount = intentUsd;
  if (intentLocal && currency) {
    const rates = await getRatesMap();
    usdAmount = convertLocalToUsd(intentLocal, currency, rates);
  }

  logger.info('Deposit request received', {
    userId: businessUser._id,
    method,
    usdAmount,
    campaignId,
  });

  // Handle M-Pesa deposit (async, requires callback)
  if (method === 'mpesa') {
    const result = await initiateMpesaDeposit({
      businessUser,
      amount: usdAmount,
      phoneNumber,
      campaignId,
      idempotencyKey,
    });

    return res.status(200).json({
      success: true,
      data: {
        status: 'pending',
        message: 'M-Pesa STK push sent. Check your phone for the prompt.',
        checkoutRequestId: result.checkoutRequestId,
        amount: usdAmount,
      },
    });
  }

  // Handle other deposit methods (instant)
  const result = await processDeposit({
    businessUser,
    intentUsd: usdAmount,
    campaignId,
    idempotencyKey,
    paymentMethod: method,
  });

  res.status(200).json({
    success: true,
    data: {
      status: 'completed',
      message: `Successfully deposited ${usdAmount} USD`,
      transactionId: result.transactionId,
      breakdown: result.breakdown,
    },
  });
}));

/**
 * POST /api/wallet/withdraw/preview
 * Preview withdrawal fees before withdrawing
 */
router.post('/withdraw/preview', withdrawalPreviewValidation, catchAsync(async (req, res, next) => {
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
 * POST /api/wallet/withdraw
 * Request a withdrawal from wallet
 */
router.post('/withdraw', withdrawalValidation, catchAsync(async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    throw new AppError(errors.array()[0].msg, 400);
  }

  const { amountUsd, amountLocal, currency, payoutMethod, payoutDetails, idempotencyKey } = req.body;
  
  // Determine USD amount
  let usdAmount = amountUsd;
  if (amountLocal && currency) {
    const rates = await getRatesMap();
    usdAmount = convertLocalToUsd(amountLocal, currency, rates);
  }

  // Check minimum withdrawal
  if (usdAmount < MIN_WITHDRAWAL_USD && req.user.role !== 'admin') {
    throw new AppError(`Minimum withdrawal amount is $${MIN_WITHDRAWAL_USD} USD`, 400);
  }

  const result = await processWithdrawal({
    userId: req.user._id,
    amountUsd: usdAmount,
    payoutMethod,
    payoutDetails,
    idempotencyKey,
    role: req.user.role,
  });

  logger.info('Withdrawal processed', {
    userId: req.user._id,
    amountUsd,
    payoutMethod,
    transactionId: result.transactionId,
  });

  res.json({
    success: true,
    data: {
      message: `Withdrawal request submitted for ${usdAmount} USD via ${payoutMethod}`,
      transactionId: result.transactionId,
      amount: usdAmount,
      fee: result.fee,
      netAmount: result.netAmount,
      status: result.status,
    },
  });
}));

/**
 * GET /api/wallet/transactions
 * Get user's transaction history
 */
router.get('/transactions', transactionsValidation, catchAsync(async (req, res, next) => {
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

  // Get exchange rates for display
  const rates = await getRatesMap();
  const preferredCurrency = req.user.preferredCurrency || 'USD';

  // Add formatted amounts to transactions
  const enrichedTransactions = result.transactions.map(tx => ({
    ...tx,
    formattedAmount: convertUsdToLocal(tx.grossAmount, preferredCurrency, rates).toFixed(2),
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
router.get('/withdrawals', transactionsValidation, catchAsync(async (req, res, next) => {
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
      withdrawals: result.withdrawals,
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

  const { recipientUsername, recipientUniqueCode, amount, idempotencyKey } = req.body;
  
  // Call the tip controller
  req.body.recipientUsername = recipientUsername || recipientUniqueCode;
  await sendTip(req, res, next);
}));

/**
 * GET /api/wallet/tip/preview
 * Preview tip amount and fees
 */
router.post('/tip/preview', catchAsync(async (req, res, next) => {
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
      logger.warn('M-Pesa callback received with no stkCallback data', { body: req.body });
      return res.status(200).json({ ResultCode: 0, ResultDesc: "Success" });
    }

    const { ResultCode, ResultDesc, CheckoutRequestID, CallbackMetadata } = callbackData;

    logger.info('M-Pesa callback received', {
      checkoutRequestId: CheckoutRequestID,
      resultCode: ResultCode,
      resultDesc: ResultDesc,
    });

    if (ResultCode === 0 && CallbackMetadata) {
      // Find transaction by checkoutRequestId
      const transaction = await Transaction.findOne({ 'metadata.checkoutRequestId': CheckoutRequestID });
      
      if (transaction) {
        // Extract receipt number from metadata
        const receiptItem = CallbackMetadata.Item?.find(item => item.Name === 'MpesaReceiptNumber');
        const receiptNumber = receiptItem?.Value;
        
        // Update transaction status
        transaction.status = 'completed';
        if (receiptNumber) {
          transaction.referenceId = receiptNumber;
          transaction.metadata.mpesaReceiptNumber = receiptNumber;
        }
        transaction.completedAt = new Date();
        await transaction.save();

        logger.info('M-Pesa transaction completed', {
          transactionId: transaction._id,
          checkoutRequestId: CheckoutRequestID,
          receiptNumber,
        });
      } else {
        logger.warn('M-Pesa callback: Transaction not found', { checkoutRequestId: CheckoutRequestID });
      }
    } else if (ResultCode !== 0) {
      // Payment failed
      const transaction = await Transaction.findOne({ 'metadata.checkoutRequestId': CheckoutRequestID });
      
      if (transaction) {
        transaction.status = 'failed';
        transaction.errorMessage = ResultDesc;
        await transaction.save();

        logger.warn('M-Pesa payment failed', {
          transactionId: transaction._id,
          checkoutRequestId: CheckoutRequestID,
          error: ResultDesc,
        });
      }
    }

    res.status(200).json({ ResultCode: 0, ResultDesc: "Success" });
  } catch (err) {
    logger.error('M-Pesa callback error:', err);
    res.status(500).json({ ResultCode: 1, ResultDesc: "Internal Error" });
  }
}));

// ============================================
// Exports
// ============================================

module.exports = { router, publicRouter };
