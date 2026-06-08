const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const { attachFeeService } = require('../middleware/feeService');
const { AppError } = require('../utils/errors');
const { getOrCreateWallet } = require('../services/walletService');
const { processWithdrawal, previewWithdrawal } = require('../services/withdrawalService');
const { processDeposit } = require('../services/depositService');
const { sendTip } = require('../controllers/wallet.controller');
const { getRatesMap, convertUsdToLocal } = require('../services/exchangeRateService');
const { MIN_WITHDRAWAL_USD } = require('../middleware/feeService');
const Transaction = require('../models/Transaction');
const User = require('../models/User');

const router = express.Router();
const protectedRouter = express.Router();

router.use(authenticate, attachFeeService);

router.get('/balance', async (req, res, next) => {
  try {
    let targetUser = req.user;
    if (req.query.userId && req.user.role === 'admin') {
      targetUser = await User.findById(req.query.userId);
      if (!targetUser) throw new AppError('User not found', 404);
    }
    const wallet = await getOrCreateWallet(targetUser._id);
    const rates = await getRatesMap();
    const currency = targetUser.preferredCurrency || 'USD';
    res.json({
      success: true,
      currency: 'USD',
      balances: wallet.balances,
      display: {
        currency,
        available: convertUsdToLocal(wallet.balances.available, currency, rates),
        escrow: convertUsdToLocal(wallet.balances.escrow, currency, rates),
        tips: convertUsdToLocal(wallet.balances.tips, currency, rates),
      },
      minWithdrawalUsd: MIN_WITHDRAWAL_USD,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/exchange-rates', async (req, res, next) => {
  try {
    const rates = await getRatesMap();
    res.json({ success: true, base: 'USD', rates });
  } catch (err) {
    next(err);
  }
});

router.post('/withdraw/preview', async (req, res, next) => {
  try {
    const preview = await previewWithdrawal({
      user: req.user,
      amountUsd: req.body.amountUsd,
      amountLocal: req.body.amountLocal,
      currency: req.body.currency || req.user.preferredCurrency,
    });
    res.json({ success: true, preview, meetsMinimum: preview.grossUsd >= MIN_WITHDRAWAL_USD || req.user.role === 'admin' });
  } catch (err) {
    next(err);
  }
});

router.post(
  '/withdraw',
  [
    body('payoutMethod').isIn(['mpesa', 'paypal', 'swift']),
    body('payoutDetails').isObject(),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) throw new AppError(errors.array()[0].msg, 400);

      const result = await processWithdrawal({
        user: req.user,
        amountUsd: req.body.amountUsd,
        amountLocal: req.body.amountLocal,
        currency: req.body.currency || req.user.preferredCurrency,
        payoutMethod: req.body.payoutMethod,
        payoutDetails: req.body.payoutDetails,
      });
      res.json({ success: true, ...result });
    } catch (err) {
      next(err);
    }
  }
);

router.post('/deposit/preview', async (req, res, next) => {
  try {
    if (req.user.role !== 'business') throw new AppError('Only businesses can preview deposits', 403);
    const intentUsd = Number(req.body.intentUsd);
    const breakdown = req.feeService.calculateDeposit(intentUsd);
    res.json({ success: true, breakdown });
  } catch (err) {
    next(err);
  }
});

router.post('/deposit', async (req, res, next) => {
  try {
    if (req.user.role !== 'business') throw new AppError('Only businesses can fund escrow', 403);
    const intentUsd = Number(req.body.intentUsd);
    const result = await processDeposit({
      businessUser: req.user,
      intentUsd,
      campaignId: req.body.campaignId,
      idempotencyKey: req.body.idempotencyKey,
    });
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

router.post('/tip', sendTip);

router.get('/transactions', async (req, res, next) => {
  try {
    const txs = await Transaction.find({
      $or: [{ fromUserId: req.user._id }, { toUserId: req.user._id }],
    })
      .sort({ createdAt: -1 })
      .limit(100);
    res.json({ success: true, transactions: txs });
  } catch (err) {
    next(err);
  }
});

publicRouter.post('/mpesa-callback', async (req, res) => {
  try {
    const callbackData = req.body.Body?.stkCallback;
    if (callbackData && callbackData.ResultCode === 0) {
      const meta = callbackData.CallbackMetadata.Item;
      const receipt = meta.find(i => i.Name === 'MpesaReceiptNumber').Value;
      
      // Update your database
      await Transaction.findOneAndUpdate(
        { checkoutRequestId: callbackData.CheckoutRequestID },
        { status: 'completed', mpesaReceiptNumber: receipt }
      );
    }
    res.status(200).json({ ResultCode: 0, ResultDesc: "Success" });
  } catch (err) {
    res.status(500).json({ ResultCode: 1, ResultDesc: "Internal Error" });
  }
});
module.exports = { router, publicRouter };
