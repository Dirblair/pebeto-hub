/**
 * Wallet Routes for Pebeto Creator's Hub
 * 
 * Handles wallet operations including deposits, withdrawals,
 * balance inquiries, transactions, and tips.
 * Supports M-PESA (Kenya), PayPal (Global), and Wire Transfers (International)
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
const { getOrCreateWallet, getWalletBalance, getTransactionHistory } = require('../services/walletService');
const { processWithdrawal, previewWithdrawal, getWithdrawalHistory } = require('../services/withdrawalService');
const { 
  processDeposit, 
  initiateMpesaDeposit, 
  initiatePayPalDeposit,
  completePayPalDeposit,
  getPayPalOrderDetails,
  initiateWireDeposit,
  confirmWireDeposit,
  previewDeposit 
} = require('../services/depositService');
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
    .isIn(['mpesa', 'paypal', 'wire', 'bank', 'card', 'wallet'])
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
  body('method')
    .optional()
    .isIn(['mpesa', 'paypal', 'wire', 'wallet'])
    .withMessage('Invalid payment method'),
];

const paypalInitiateValidation = [
  body('amount')
    .isFloat({ min: 1, max: 10000 })
    .withMessage('Amount must be between $1 and $10,000 USD'),
  body('campaignId')
    .optional()
    .isMongoId()
    .withMessage('Invalid campaign ID'),
  body('returnUrl')
    .isURL()
    .withMessage('Valid return URL required'),
  body('cancelUrl')
    .isURL()
    .withMessage('Valid cancel URL required'),
];

const paypalCompleteValidation = [
  body('orderId')
    .notEmpty()
    .withMessage('Order ID required'),
  body('payerId')
    .notEmpty()
    .withMessage('Payer ID required'),
  body('transactionId')
    .optional()
    .isMongoId()
    .withMessage('Invalid transaction ID'),
];

const wireInitiateValidation = [
  body('amount')
    .isFloat({ min: 100, max: 50000 })
    .withMessage('Wire transfer amount must be between $100 and $50,000 USD'),
  body('campaignId')
    .optional()
    .isMongoId()
    .withMessage('Invalid campaign ID'),
];

const wireConfirmValidation = [
  body('transactionId')
    .isMongoId()
    .withMessage('Valid transaction ID required'),
  body('referenceNumber')
    .notEmpty()
    .withMessage('Reference number required')
    .isLength({ min: 5, max: 100 })
    .withMessage('Reference number must be between 5 and 100 characters'),
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
 * Preview deposit fees before making deposit (supports all methods)
 */
router.post('/deposit/preview', depositPreviewValidation, catchAsync(async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    throw new AppError(errors.array()[0].msg, 400);
  }

  if (req.user.role !== 'business') {
    throw new AppError('Only businesses can preview deposits', 403);
  }

  const { intentUsd, intentLocal, currency, method = 'wallet' } = req.body;
  let usdAmount = intentUsd;

  if (intentLocal && currency) {
    const rates = await getRatesMap();
    usdAmount = convertLocalToUsd(intentLocal, currency, rates);
  }

  const preview = await previewDeposit(usdAmount);
  
  // Add method-specific notes
  let methodNotes = [];
  if (method === 'mpesa') {
    methodNotes = [
      'M-PESA transactions have a 10% platform fee',
      'You will receive an STK push on your phone',
      'Transaction is instant upon confirmation'
    ];
  } else if (method === 'paypal') {
    methodNotes = [
      'PayPal transactions have a 10% platform fee',
      'You will be redirected to PayPal to complete payment',
      'Funds are credited immediately after payment'
    ];
  } else if (method === 'wire') {
    methodNotes = [
      'Wire transfers have a 10% platform fee',
      'Funds typically arrive within 2-5 business days',
      'Minimum wire transfer: $100 USD',
      'Maximum wire transfer: $50,000 USD'
    ];
  }

  res.json({
    success: true,
    data: {
      ...preview,
      method,
      methodNotes,
    },
  });
}));

/**
 * POST /api/wallet/deposit
 * Make a deposit to wallet (unified endpoint)
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

  // Route to appropriate deposit handler based on method
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
        message: 'M-PESA STK push sent. Check your phone for the prompt.',
        checkoutRequestId: result.checkoutRequestId,
        transactionId: result.transactionId,
        amount: usdAmount,
      },
    });
  }

  if (method === 'paypal') {
    // PayPal requires a separate initiate endpoint with return URLs
    // This endpoint should not be used directly for PayPal
    throw new AppError('For PayPal deposits, please use /deposit/paypal/initiate endpoint', 400);
  }

  if (method === 'wire') {
    // Wire transfer requires a separate initiate endpoint for instructions
    throw new AppError('For wire transfers, please use /deposit/wire/initiate endpoint', 400);
  }

  // Handle internal wallet deposit (instant)
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

// ============================================
// PayPal Deposit Routes
// ============================================

/**
 * POST /api/wallet/deposit/paypal/initiate
 * Initiate PayPal deposit (creates order for approval)
 */
router.post('/deposit/paypal/initiate',
  authorize('business'),
  paypalInitiateValidation,
  catchAsync(async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new AppError(errors.array()[0].msg, 400);
    }

    const { amount, campaignId, returnUrl, cancelUrl } = req.body;
    const idempotencyKey = req.headers['idempotency-key'] || crypto.randomBytes(16).toString('hex');

    const result = await initiatePayPalDeposit({
      businessUser: req.user,
      amount: Number(amount),
      campaignId,
      returnUrl,
      cancelUrl,
      idempotencyKey,
    });

    logger.info('PayPal order initiated', {
      userId: req.user._id,
      orderId: result.orderId,
      amount,
    });

    res.json({
      success: true,
      data: result,
    });
  })
);

/**
 * POST /api/wallet/deposit/paypal/complete
 * Complete PayPal deposit after user approval (called from return URL)
 */
router.post('/deposit/paypal/complete',
  paypalCompleteValidation,
  catchAsync(async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new AppError(errors.array()[0].msg, 400);
    }

    const { orderId, payerId, transactionId } = req.body;

    const result = await completePayPalDeposit({
      orderId,
      payerId,
      transactionId,
    });

    logger.info('PayPal deposit completed', {
      orderId,
      payerId,
      transactionId: result.transactionId,
    });

    res.json({
      success: true,
      data: result,
    });
  })
);

/**
 * GET /api/wallet/deposit/paypal/order/:orderId
 * Get PayPal order details (for status checking)
 */
router.get('/deposit/paypal/order/:orderId',
  catchAsync(async (req, res, next) => {
    const { orderId } = req.params;
    
    const order = await getPayPalOrderDetails(orderId);
    
    res.json({
      success: true,
      data: order,
    });
  })
);

// ============================================
// Wire Transfer Deposit Routes
// ============================================

/**
 * POST /api/wallet/deposit/wire/initiate
 * Initiate wire transfer deposit (get bank instructions)
 */
router.post('/deposit/wire/initiate',
  authorize('business'),
  wireInitiateValidation,
  catchAsync(async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new AppError(errors.array()[0].msg, 400);
    }

    const { amount, campaignId } = req.body;
    const idempotencyKey = req.headers['idempotency-key'] || crypto.randomBytes(16).toString('hex');

    const result = await initiateWireDeposit({
      businessUser: req.user,
      amount: Number(amount),
      campaignId,
      idempotencyKey,
    });

    logger.info('Wire deposit initiated', {
      userId: req.user._id,
      transactionId: result.transactionId,
      amount,
    });

    res.json({
      success: true,
      data: result,
    });
  })
);

/**
 * POST /api/wallet/deposit/wire/confirm
 * Confirm wire transfer (Admin only - manual confirmation)
 */
router.post('/deposit/wire/confirm',
  authorize('admin'),
  wireConfirmValidation,
  catchAsync(async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new AppError(errors.array()[0].msg, 400);
    }

    const { transactionId, referenceNumber } = req.body;

    const result = await confirmWireDeposit({
      transactionId,
      referenceNumber,
      confirmedBy: req.user._id,
    });

    logger.info('Wire deposit confirmed by admin', {
      transactionId,
      referenceNumber,
      confirmedBy: req.user._id,
    });

    res.json({
      success: true,
      data: result,
    });
  })
);

/**
 * GET /api/wallet/deposit/wire/pending
 * Get pending wire transfers (Admin only)
 */
router.get('/deposit/wire/pending',
  authorize('admin'),
  catchAsync(async (req, res, next) => {
    const pendingWires = await Transaction.find({
      type: 'deposit',
      'metadata.paymentMethod': 'wire',
      status: 'pending',
      'metadata.expiresAt': { $gt: new Date() },
    }).populate('fromUserId', 'email uniqueCode profile.companyName');

    res.json({
      success: true,
      data: {
        pending: pendingWires,
        count: pendingWires.length,
      },
    });
  })
);

// ============================================
// Withdrawal Routes
// ============================================

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

// ============================================
// Transaction History Routes
// ============================================

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

// ============================================
// Tip Routes
// ============================================

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
 * POST /api/wallet/tip/preview
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
      icon: 'https://cdn.jsdelivr.net/npm/remixicon@3.5.0/icons/phone-line.svg',
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
      icon: 'https://cdn.jsdelivr.net/npm/remixicon@3.5.0/icons/paypal-line.svg',
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
      icon: 'https://cdn.jsdelivr.net/npm/remixicon@3.5.0/icons/bank-line.svg',
    },
    {
      id: 'wallet',
      name: 'Internal Wallet',
      region: 'Platform',
      type: 'internal',
      minAmount: 1,
      maxAmount: null,
      feePercentage: 10,
      processingTime: 'Instant',
      icon: 'https://cdn.jsdelivr.net/npm/remixicon@3.5.0/icons/wallet-line.svg',
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
