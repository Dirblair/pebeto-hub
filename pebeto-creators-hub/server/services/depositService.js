const axios = require('axios');
const moment = require('moment');
const env = require('../config/env');
const { calculateDeposit } = require('../middleware/feeService');
const {
  getOrCreateWallet,
  getAdminProfitWallet,
  recordTransaction,
  debitWallet,
  creditWallet,
  runInTransaction,
} = require('./walletService');
const { AppError } = require('../utils/errors');

/**
 * 1. M-PESA HELPER FUNCTIONS
 */
const getTimestamp = () => moment().format('YYYYMMDDHHmmss');

const getPassword = (timestamp) => {
  const buffer = Buffer.from(`${env.mpesaShortCode}${env.mpesaPasskey}${timestamp}`);
  return buffer.toString('base64');
};

const getAccessToken = async () => {
  const auth = Buffer.from(`${env.mpesaConsumerKey}:${env.mpesaConsumerSecret}`).toString('base64');
  const response = await axios.get(`${env.mpesaApiUrl}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` }
  });
  return response.data.access_token;
};

/**
 * 2. EXTERNAL PAYMENT: Initiate M-Pesa STK Push
 */
async function initiateMpesaDeposit({ businessUser, amount, phoneNumber, campaignId }) {
  const timestamp = getTimestamp();
  const password = getPassword(timestamp);
  const token = await getAccessToken();

  const payload = {
    BusinessShortCode: env.mpesaShortCode,
    Password: password,
    Timestamp: timestamp,
    TransactionType: "CustomerPayBillOnline",
    Amount: amount,
    PartyA: phoneNumber,
    PartyB: env.mpesaShortCode,
    PhoneNumber: phoneNumber,
    CallBackURL: env.mpesaCallbackUrl,
    AccountReference: "PebetoDeposit",
    TransactionDesc: `Escrow for campaign: ${campaignId}`
  };

  const response = await axios.post(
    `${env.mpesaApiUrl}/mpk/stkpush/v1/processrequest`, 
    payload,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  await recordTransaction({
    type: 'deposit_pending',
    status: 'pending',
    fromUserId: businessUser._id,
    checkoutRequestId: response.data.CheckoutRequestID,
    metadata: { campaignId, amount, phoneNumber }
  });

  return response.data;
}

/**
 * 3. INTERNAL WALLET: Process business deposit from available balance
 */
async function processDeposit({ businessUser, intentUsd, campaignId, idempotencyKey }) {
  const breakdown = calculateDeposit(intentUsd);
  const businessWallet = await getOrCreateWallet(businessUser._id);
  const { admin, wallet: profitWallet } = await getAdminProfitWallet();

  if (businessWallet.balances.available < breakdown.totalChargeUsd) {
    throw new AppError(`Insufficient funds. Need $${breakdown.totalChargeUsd}`, 400);
  }

  return runInTransaction(async (session) => {
    await debitWallet(businessWallet._id, 'available', breakdown.totalChargeUsd, session);
    await creditWallet(businessWallet._id, 'escrow', breakdown.escrowCreditUsd, session);
    await creditWallet(profitWallet._id, 'available', breakdown.feeUsd, session);

    const depositTx = await recordTransaction({
        type: 'deposit',
        status: 'completed',
        fromUserId: businessUser._id,
        toUserId: businessUser._id,
        fromWalletId: businessWallet._id,
        toWalletId: businessWallet._id,
        grossAmount: breakdown.intentUsd,
        feeAmount: breakdown.feeUsd,
        netAmount: breakdown.escrowCreditUsd,
        metadata: { campaignId, idempotencyKey }
      }, session);

    return { depositTx, breakdown };
  });
}

module.exports = { processDeposit, initiateMpesaDeposit };
