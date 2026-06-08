const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const { attachFeeService } = require('../middleware/feeService');
const { AppError } = require('../utils/errors');
const { getOrCreateWallet } = require('../services/walletService');
const { processWithdrawal, previewWithdrawal } = require('../services/withdrawalService');
const { processDeposit, initiateMpesaDeposit } = require('../services/depositService'); // Combined imports
const { sendTip } = require('../controllers/wallet.controller');
const { getRatesMap, convertUsdToLocal } = require('../services/exchangeRateService');
const { MIN_WITHDRAWAL_USD } = require('../middleware/feeService');
const Transaction = require('../models/Transaction');
const User = require('../models/User');

const router = express.Router();
const publicRouter = express.Router(); // Defined here

// 1. PROTECTED ROUTES (Require Auth)
router.use(authenticate, attachFeeService);

router.post('/deposit', async (req, res, next) => {
  try {
    const { method, intentUsd, campaignId, phoneNumber, idempotencyKey } = req.body;
    const businessUser = req.user;

    if (method === 'mpesa') {
      const result = await initiateMpesaDeposit({ businessUser, amount: intentUsd, phoneNumber, campaignId });
      return res.status(200).json({ status: 'pending', ...result });
    }
    
    if (businessUser.role !== 'business') throw new AppError('Only businesses can fund escrow', 403);
    const result = await processDeposit({ businessUser, intentUsd: Number(intentUsd), campaignId, idempotencyKey });
    return res.status(200).json({ status: 'completed', ...result });
  } catch (error) {
    next(error);
  }
});

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

// ... Keep your existing balance, exchange-rates, withdraw, and tip routes here ...
router.get('/balance', async (req, res, next) => { /* ... */ });
router.get('/exchange-rates', async (req, res, next) => { /* ... */ });
router.post('/tip', sendTip);
router.get('/transactions', async (req, res, next) => { /* ... */ });

// 2. PUBLIC ROUTES (No Auth)
publicRouter.post('/mpesa-callback', async (req, res) => {
  try {
    const callbackData = req.body.Body?.stkCallback;
    if (callbackData && callbackData.ResultCode === 0) {
      const meta = callbackData.CallbackMetadata.Item;
      const receipt = meta.find(i => i.Name === 'MpesaReceiptNumber').Value;
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
