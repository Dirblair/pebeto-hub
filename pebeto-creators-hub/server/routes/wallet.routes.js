const express = require('express');
const { body, query, validationResult } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const { AppError } = require('../utils/errors');
const { catchAsync } = require('../middleware/errorHandler');
const { getWalletBalance, getTransactionHistory } = require('../services/walletService');
const { previewWithdrawal, getWithdrawalHistory } = require('../services/withdrawalService');
const { previewDeposit, processDeposit } = require('../services/depositService');
const { processWithdrawal } = require('../services/withdrawalService');
const { getRatesMap, convertUsdToLocal, convertLocalToUsd } = require('../services/exchangeRateService');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const logger = require('../utils/logger');

const router = express.Router();

// ============================================
// Validation Rules
// ============================================

const depositPreviewValidation = [
  body('intentUsd').optional().isFloat({ min: 1 }).withMessage('Intent amount must be at least $1'),
];

const withdrawalPreviewValidation = [
  body('amountUsd').optional().isFloat({ min: 0.01 }).withMessage('Amount must be at least $0.01'),
  body('amountLocal').optional().isFloat({ min: 0.01 }).withMessage('Local amount must be positive'),
  body('currency').optional().isString().isLength({ min: 3, max: 3 }),
];

const depositValidation = [
  body('intentUsd').isFloat({ min: 1 }).withMessage('Deposit amount must be at least $1').toFloat(),
];

const withdrawValidation = [
  body('payoutMethod').isIn(['mpesa', 'paypal', 'swift', 'bank_transfer']).withMessage('Invalid payout method'),
  body('payoutDetails').isObject().withMessage('Payout details are required'),
  body('amountUsd').optional().isFloat({ min: 1 }).withMessage('Amount in USD must be at least $1').toFloat(),
  body('amountLocal').optional().isFloat({ min: 1 }).withMessage('Amount in local currency must be at least 1').toFloat(),
  body('currency').optional().isLength({ min: 3, max: 3 }).withMessage('Currency must be a 3-letter code').toUpperCase(),
];

const tipValidation = [
  body('recipientUsername').optional().isString().trim(),
  body('recipientUniqueCode').optional().isString().trim(),
  body('amount').isFloat({ min: 1 }).withMessage('Tip amount must be at least $1'),
];

const balanceValidation = [
  query('userId').optional().isMongoId().withMessage('Invalid user ID'),
];

const transactionsValidation = [
  query('page').optional().isInt({ min: 1 }).withMessage('Page must be a positive integer').toInt(),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Limit must be between 1 and 100').toInt(),
  query('type').optional().isIn(['deposit', 'withdrawal', 'tip', 'platform_fee', 'escrow_release']).withMessage('Invalid transaction type'),
];

// ============================================
// Helper function to attach fee service
// ============================================

function attachFeeService(req, res, next) {
  try {
    const feeService = require('../services/feeService');
    req.feeService = feeService;
    next();
  } catch (err) {
    logger.error('Failed to load fee service:', err.message);
    next();
  }
}

// ============================================
// Protected Routes (Require Authentication)
// ============================================

router.use(authenticate);
router.use(attachFeeService);

// GET /api/wallet/balance
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

// GET /api/wallet/exchange-rates
router.get('/exchange-rates', catchAsync(async (req, res) => {
  const rates = await getRatesMap();
  res.json({ success: true, data: { base: 'USD', rates, timestamp: new Date().toISOString() } });
}));

// POST /api/wallet/deposit/preview
router.post('/deposit/preview', depositPreviewValidation, catchAsync(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    throw new AppError(errors.array()[0].msg, 400);
  }

  const { intentUsd } = req.body;
  const isAdmin = req.user.role === 'admin';
  const preview = await previewDeposit(intentUsd, isAdmin);
  res.json({ success: true, data: preview });
}));

// POST /api/wallet/deposit
router.post('/deposit', depositValidation, catchAsync(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    throw new AppError(errors.array()[0].msg, 400);
  }

  const { intentUsd, campaignId, idempotencyKey } = req.body;
  const isAdmin = req.user.role === 'admin';

  const result = await processDeposit({
    businessUser: req.user,
    intentUsd,
    campaignId,
    idempotencyKey,
    paymentMethod: 'wallet',
    isAdmin: isAdmin,
    adminFeeWaived: isAdmin
  });

  res.json({
    success: true,
    message: isAdmin ? `Successfully deposited $${intentUsd} with NO fee.` : `Successfully deposited $${intentUsd}.`,
    data: {
      transactionId: result.transactionId,
      breakdown: result.breakdown,
      escrowCredit: result.breakdown.escrowCreditUsd,
      feePaid: isAdmin ? 0 : result.breakdown.feeUsd,
      feeWaived: isAdmin
    }
  });
}));

// POST /api/wallet/withdraw/preview
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

  const isAdmin = req.user.role === 'admin';
  const preview = await previewWithdrawal(usdAmount, isAdmin);
  res.json({ success: true, data: preview });
}));

// POST /api/wallet/withdraw
router.post('/withdraw', withdrawValidation, catchAsync(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    throw new AppError(errors.array()[0].msg, 400);
  }

  const { amountUsd, amountLocal, currency, payoutMethod, payoutDetails, idempotencyKey } = req.body;

  if (!amountUsd && (!amountLocal || !currency)) {
    throw new AppError('Provide amountUsd or amountLocal with currency', 400);
  }

  const isAdmin = req.user.role === 'admin';

  const result = await processWithdrawal({
    user: req.user,
    amountUsd,
    amountLocal,
    currency,
    payoutMethod,
    payoutDetails,
    idempotencyKey,
    isAdmin: isAdmin,
    adminFeeWaived: isAdmin
  });

  res.json({
    success: true,
    message: result.message,
    data: {
      withdrawalId: result.withdrawal._id,
      transactionId: result.withdrawal.transactionId,
      amount: result.grossUsd,
      fee: isAdmin ? 0 : result.feeUsd,
      netAmount: isAdmin ? result.grossUsd : result.netToUserUsd,
      method: payoutMethod,
      status: result.withdrawal.status,
      providerReference: result.payoutResult?.reference,
      feeWaived: isAdmin
    }
  });
}));

// GET /api/wallet/transactions
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

// GET /api/wallet/withdrawals
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

// POST /api/wallet/tip
router.post('/tip', tipValidation, catchAsync(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    throw new AppError(errors.array()[0].msg, 400);
  }

  const { recipientUsername, recipientUniqueCode, amount, idempotencyKey, currency = 'USD' } = req.body;

  if ((!recipientUsername && !recipientUniqueCode) || !amount || amount <= 0) {
    throw new AppError('Invalid recipient or amount.', 400);
  }

  const recipient = await User.findOne({
    $or: [
      { uniqueCode: recipientUniqueCode },
      { username: recipientUsername }
    ]
  });

  if (!recipient) {
    throw new AppError('Recipient not found', 404);
  }

  const { processTip } = require('../services/tipService');
  
  const result = await processTip({
    fromUser: req.user,
    toCreatorId: recipient._id,
    grossUsd: amount,
    idempotencyKey
  });
  
  res.json({
    success: true,
    message: `Successfully tipped ${recipient.uniqueCode || recipient.username}`,
    data: {
      amount: amount,
      currency: currency,
      recipient: recipient.uniqueCode || recipient.username,
      transactionId: result.tipTx._id
    }
  });
}));

// GET /api/wallet/earnings
router.get('/earnings', catchAsync(async (req, res) => {
  const { days = 30 } = req.query;
  const daysInt = parseInt(days) || 30;
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - daysInt);
  
  const earningsData = await Transaction.aggregate([
    { $match: { toUserId: req.user._id, type: 'tip', status: 'completed', createdAt: { $gte: startDate } } },
    { $group: { _id: { date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } } }, total: { $sum: '$netAmount' }, count: { $sum: 1 } } },
    { $sort: { '_id.date': 1 } }
  ]);
  
  const campaignEarnings = await Transaction.aggregate([
    { $match: { toUserId: req.user._id, type: 'escrow_release', status: 'completed', createdAt: { $gte: startDate } } },
    { $group: { _id: { date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } } }, total: { $sum: '$netAmount' }, count: { $sum: 1 } } },
    { $sort: { '_id.date': 1 } }
  ]);
  
  const earningsMap = new Map();
  
  earningsData.forEach(item => {
    earningsMap.set(item._id.date, { tips: item.total, campaigns: 0, total: item.total });
  });
  
  campaignEarnings.forEach(item => {
    if (earningsMap.has(item._id.date)) {
      const existing = earningsMap.get(item._id.date);
      existing.campaigns = item.total;
      existing.total = existing.tips + item.total;
    } else {
      earningsMap.set(item._id.date, { tips: 0, campaigns: item.total, total: item.total });
    }
  });
  
  const labels = [];
  const earnings = [];
  const tipsData = [];
  const campaignsData = [];
  
  for (let i = daysInt - 1; i >= 0; i--) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split('T')[0];
    const label = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    labels.push(label);
    
    const dayData = earningsMap.get(dateStr) || { tips: 0, campaigns: 0, total: 0 };
    earnings.push(dayData.total);
    tipsData.push(dayData.tips);
    campaignsData.push(dayData.campaigns);
  }
  
  const totalTips = earningsData.reduce((sum, item) => sum + item.total, 0);
  const totalCampaigns = campaignEarnings.reduce((sum, item) => sum + item.total, 0);
  const totalEarnings = totalTips + totalCampaigns;
  
  res.json({
    success: true,
    data: {
      labels,
      earnings,
      breakdown: { tips: tipsData, campaigns: campaignsData },
      summary: { totalEarnings, totalTips, totalCampaigns, period: `${daysInt} days`, averagePerDay: totalEarnings / daysInt }
    }
  });
}));

// GET /api/wallet/spending
router.get('/spending', catchAsync(async (req, res) => {
  const { days = 30 } = req.query;
  const daysInt = parseInt(days) || 30;
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - daysInt);
  
  const spendingData = await Transaction.aggregate([
    { $match: { fromUserId: req.user._id, type: 'deposit', status: 'completed', createdAt: { $gte: startDate } } },
    { $group: { _id: { date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } } }, total: { $sum: '$grossAmount' }, fee: { $sum: '$feeAmount' } } },
    { $sort: { '_id.date': 1 } }
  ]);
  
  const campaignFunding = await Transaction.aggregate([
    { $match: { fromUserId: req.user._id, type: 'campaign_fund', status: 'completed', createdAt: { $gte: startDate } } },
    { $group: { _id: { date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } } }, total: { $sum: '$grossAmount' } } },
    { $sort: { '_id.date': 1 } }
  ]);
  
  const spendingMap = new Map();
  
  spendingData.forEach(item => {
    spendingMap.set(item._id.date, { deposits: item.total, fees: item.fee, campaigns: 0, total: item.total });
  });
  
  campaignFunding.forEach(item => {
    if (spendingMap.has(item._id.date)) {
      const existing = spendingMap.get(item._id.date);
      existing.campaigns = item.total;
      existing.total = existing.deposits + item.total;
    } else {
      spendingMap.set(item._id.date, { deposits: 0, fees: 0, campaigns: item.total, total: item.total });
    }
  });
  
  const labels = [];
  const spending = [];
  const depositsData = [];
  const campaignsData = [];
  const feesData = [];
  
  for (let i = daysInt - 1; i >= 0; i--) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split('T')[0];
    const label = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    labels.push(label);
    
    const dayData = spendingMap.get(dateStr) || { deposits: 0, fees: 0, campaigns: 0, total: 0 };
    spending.push(dayData.total);
    depositsData.push(dayData.deposits);
    campaignsData.push(dayData.campaigns);
    feesData.push(dayData.fees);
  }
  
  const totalSpending = spendingData.reduce((sum, item) => sum + item.total, 0) + campaignFunding.reduce((sum, item) => sum + item.total, 0);
  const totalFees = spendingData.reduce((sum, item) => sum + (item.fee || 0), 0);
  
  res.json({
    success: true,
    data: {
      labels,
      spending,
      breakdown: { deposits: depositsData, campaigns: campaignsData, fees: feesData },
      summary: { totalSpending, totalFees, period: `${daysInt} days`, averagePerDay: totalSpending / daysInt }
    }
  });
}));

// POST /api/wallet/mpesa-callback
router.post('/mpesa-callback', catchAsync(async (req, res) => {
  try {
    const callbackData = req.body.Body?.stkCallback;
    if (!callbackData) {
      return res.status(200).json({ ResultCode: 0, ResultDesc: "Success" });
    }

    const { ResultCode, ResultDesc, CheckoutRequestID } = callbackData;
    const transaction = await Transaction.findOne({ 'metadata.checkoutRequestId': CheckoutRequestID });
    
    if (transaction) {
      transaction.status = ResultCode === 0 ? 'completed' : 'failed';
      transaction.errorMessage = ResultDesc;
      transaction.completedAt = new Date();
      await transaction.save();
    }

    res.status(200).json({ ResultCode: 0, ResultDesc: "Success" });
  } catch (err) {
    logger.error('M-Pesa callback error:', err);
    res.status(200).json({ ResultCode: 0, ResultDesc: "Success" });
  }
}));

// GET /api/wallet/payment-methods
router.get('/payment-methods', catchAsync(async (req, res) => {
  res.json({
    success: true,
    data: [
      { id: 'mpesa', name: 'M-Pesa', region: 'Kenya', type: 'mobile_money', minAmount: 1, maxAmount: 1150, feePercentage: 10, processingTime: 'Instant', enabled: true },
      { id: 'paypal', name: 'PayPal', region: 'Global', type: 'digital_wallet', minAmount: 1, maxAmount: 10000, feePercentage: 10, processingTime: 'Instant', enabled: false },
      { id: 'wire', name: 'Wire Transfer', region: 'International', type: 'bank_transfer', minAmount: 100, maxAmount: 50000, feePercentage: 10, processingTime: '2-5 business days', enabled: false },
    ]
  });
}));

module.exports = router;
