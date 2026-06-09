/**
 * Deposit Service for Pebeto Creator's Hub
 * 
 * Handles deposit operations including:
 * - M-PESA STK push (Kenya)
 * - PayPal payments (Global)
 * - Wire/Bank transfers (International)
 * - Internal wallet transfers
 * 
 * @module services/depositService
 */

const axios = require('axios');
const moment = require('moment');
const crypto = require('crypto');
const env = require('../config/env');
const { calculateDeposit, previewDeposit } = require('../services/feeService');
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

const MPESA_MAX_AMOUNT = 150000; // KES max per transaction (approx $1150)
const MPESA_MIN_AMOUNT = 10; // KES minimum per transaction
const USD_TO_KES_RATE = 130; // Approximate rate for validation

const PAYPAL_MAX_AMOUNT = 10000; // $10,000 USD max per transaction
const PAYPAL_MIN_AMOUNT = 1; // $1 USD minimum per transaction

const WIRE_MIN_AMOUNT = 100; // $100 USD minimum for wire transfers
const WIRE_MAX_AMOUNT = 50000; // $50,000 USD max per wire transfer

// ============================================
// M-PESA Helper Functions
// ============================================

/**
 * Get current timestamp in M-PESA format (YYYYMMDDHHmmss)
 */
const getTimestamp = () => moment().format('YYYYMMDDHHmmss');

/**
 * Generate password for M-PESA API
 */
const getPassword = (timestamp) => {
  const buffer = Buffer.from(`${env.mpesaShortCode}${env.mpesaPasskey}${timestamp}`);
  return buffer.toString('base64');
};

/**
 * Get M-PESA access token
 */
const getAccessToken = async () => {
  try {
    const auth = Buffer.from(`${env.mpesaConsumerKey}:${env.mpesaConsumerSecret}`).toString('base64');
    const response = await axios.get(`${env.mpesaApiUrl}/oauth/v1/generate?grant_type=client_credentials`, {
      headers: { Authorization: `Basic ${auth}` },
      timeout: 30000,
    });
    return response.data.access_token;
  } catch (error) {
    logger.error('Failed to get M-PESA access token', {
      error: error.message,
      status: error.response?.status,
    });
    throw new AppError('Payment service unavailable. Please try again later.', 503);
  }
};

/**
 * Validate Kenyan phone number
 */
function validateMpesaPhoneNumber(phoneNumber) {
  const phoneRegex = /^(254|\+254|0)[7-9][0-9]{8}$/;
  return phoneRegex.test(phoneNumber);
}

/**
 * Format phone number to M-PESA standard (254XXXXXXXXX)
 */
function formatMpesaPhoneNumber(phoneNumber) {
  let cleaned = phoneNumber.replace(/\D/g, '');
  if (cleaned.startsWith('0')) {
    cleaned = '254' + cleaned.substring(1);
  } else if (cleaned.startsWith('+254')) {
    cleaned = cleaned.substring(1);
  }
  return cleaned;
}

/**
 * Validate M-PESA amount against limits
 */
function validateMpesaAmount(amountUsd) {
  const amountKes = amountUsd * USD_TO_KES_RATE;
  if (amountKes < MPESA_MIN_AMOUNT) {
    throw new AppError(`Minimum M-PESA deposit is ${MPESA_MIN_AMOUNT} KES (approx $${(MPESA_MIN_AMOUNT / USD_TO_KES_RATE).toFixed(2)})`, 400);
  }
  if (amountKes > MPESA_MAX_AMOUNT) {
    throw new AppError(`Maximum M-PESA deposit is ${MPESA_MAX_AMOUNT} KES (approx $${(MPESA_MAX_AMOUNT / USD_TO_KES_RATE).toFixed(2)})`, 400);
  }
  return true;
}

// ============================================
// PayPal Helper Functions
// ============================================

/**
 * Get PayPal access token
 */
async function getPayPalAccessToken() {
  try {
    const auth = Buffer.from(`${env.paypalClientId}:${env.paypalClientSecret}`).toString('base64');
    const response = await axios.post(
      `${env.paypalApiUrl}/v1/oauth2/token`,
      'grant_type=client_credentials',
      {
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: 30000,
      }
    );
    return response.data.access_token;
  } catch (error) {
    logger.error('Failed to get PayPal access token', {
      error: error.message,
      status: error.response?.status,
    });
    throw new AppError('PayPal service unavailable. Please try again later.', 503);
  }
}

/**
 * Validate PayPal email
 */
function validatePayPalEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * Validate PayPal amount against limits
 */
function validatePayPalAmount(amountUsd) {
  if (amountUsd < PAYPAL_MIN_AMOUNT) {
    throw new AppError(`Minimum PayPal deposit is $${PAYPAL_MIN_AMOUNT} USD`, 400);
  }
  if (amountUsd > PAYPAL_MAX_AMOUNT) {
    throw new AppError(`Maximum PayPal deposit is $${PAYPAL_MAX_AMOUNT} USD per transaction`, 400);
  }
  return true;
}

/**
 * Create PayPal order
 */
async function createPayPalOrder(amountUsd, returnUrl, cancelUrl, metadata = {}) {
  const token = await getPayPalAccessToken();
  
  const payload = {
    intent: 'CAPTURE',
    purchase_units: [
      {
        amount: {
          currency_code: 'USD',
          value: amountUsd.toFixed(2),
          breakdown: {
            item_total: {
              currency_code: 'USD',
              value: amountUsd.toFixed(2),
            },
          },
        },
        description: metadata.campaignId 
          ? `Pebeto Campaign Deposit - ${metadata.campaignId}`
          : 'Pebeto Wallet Deposit',
        custom_id: JSON.stringify(metadata),
        invoice_id: `INV-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
      },
    ],
    application_context: {
      brand_name: 'Pebeto Creator Hub',
      landing_page: 'BILLING',
      user_action: 'PAY_NOW',
      return_url: returnUrl,
      cancel_url: cancelUrl,
    },
  };
  
  const response = await axios.post(
    `${env.paypalApiUrl}/v2/checkout/orders`,
    payload,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    }
  );
  
  // Find approval URL
  const approvalUrl = response.data.links.find(link => link.rel === 'approve')?.href;
  
  return {
    orderId: response.data.id,
    approvalUrl,
    status: response.data.status,
  };
}

/**
 * Capture PayPal payment after approval
 */
async function capturePayPalOrder(orderId) {
  const token = await getPayPalAccessToken();
  
  const response = await axios.post(
    `${env.paypalApiUrl}/v2/checkout/orders/${orderId}/capture`,
    {},
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    }
  );
  
  const capture = response.data.purchase_units[0]?.payments?.captures[0];
  
  return {
    captureId: capture.id,
    status: capture.status,
    amount: parseFloat(capture.amount.value),
    currency: capture.amount.currency_code,
    payerEmail: response.data.payer?.email_address,
    payerName: `${response.data.payer?.name?.given_name || ''} ${response.data.payer?.name?.surname || ''}`.trim(),
  };
}

/**
 * Get PayPal order details
 */
async function getPayPalOrderDetails(orderId) {
  const token = await getPayPalAccessToken();
  
  const response = await axios.get(
    `${env.paypalApiUrl}/v2/checkout/orders/${orderId}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    }
  );
  
  return response.data;
}

// ============================================
// Wire Transfer Helper Functions
// ============================================

/**
 * Validate wire transfer amount against limits
 */
function validateWireAmount(amountUsd) {
  if (amountUsd < WIRE_MIN_AMOUNT) {
    throw new AppError(`Minimum wire transfer deposit is $${WIRE_MIN_AMOUNT} USD`, 400);
  }
  if (amountUsd > WIRE_MAX_AMOUNT) {
    throw new AppError(`Maximum wire transfer deposit is $${WIRE_MAX_AMOUNT} USD per transaction`, 400);
  }
  return true;
}

/**
 * Generate wire transfer instructions
 */
function generateWireInstructions(amountUsd, transactionId, userEmail) {
  return {
    bankName: env.wireBankName || 'Pebeto Partner Bank',
    bankAddress: env.wireBankAddress || '123 Financial District, New York, NY 10005, USA',
    accountName: env.wireAccountName || 'Pebeto Global Holdings Ltd',
    accountNumber: env.wireAccountNumber || '9876543210',
    routingNumber: env.wireRoutingNumber || '021000021',
    swiftCode: env.wireSwiftCode || 'CHASUS33',
    iban: env.wireIban || 'US12345678901234567890',
    reference: `PEBETO-${transactionId.slice(-8)}`,
    amount: amountUsd.toFixed(2),
    currency: 'USD',
    instructions: [
      'Please include the reference number in your transfer description',
      'Funds typically arrive within 2-5 business days',
      'A confirmation email will be sent once funds are received',
      `Reference ID: PEBETO-${transactionId.slice(-8)}`,
    ],
    contactForSupport: 'finance@pebeto.com',
  };
}

// ============================================
// Preview Functions
// ============================================

/**
 * Preview deposit fees (without processing)
 * @param {number} intentUsd - Intended deposit amount in USD
 * @returns {Object} Deposit preview
 */
async function previewDepositService(intentUsd) {
  const breakdown = calculateDeposit(intentUsd);
  return {
    intentUsd: breakdown.intentUsd,
    feeUsd: breakdown.feeUsd,
    totalChargeUsd: breakdown.totalChargeUsd,
    escrowCreditUsd: breakdown.escrowCreditUsd,
    feePercentage: breakdown.feePercentage,
    message: `You will pay $${breakdown.totalChargeUsd} to credit $${breakdown.escrowCreditUsd} to escrow.`,
  };
}

// ============================================
// PayPal Deposit
// ============================================

/**
 * Initiate PayPal deposit (creates order for approval)
 * @param {Object} params - Deposit parameters
 * @returns {Promise<Object>} PayPal order details
 */
async function initiatePayPalDeposit({ businessUser, amount, campaignId, returnUrl, cancelUrl, idempotencyKey }) {
  // Validate inputs
  if (!businessUser) throw new AppError('User information required', 400);
  if (!amount || amount <= 0) throw new AppError('Valid deposit amount required', 400);
  
  // Validate amount limits
  validatePayPalAmount(amount);
  
  // Calculate deposit breakdown
  const breakdown = calculateDeposit(amount);
  
  // Check for duplicate idempotency key
  if (idempotencyKey) {
    const existing = await Transaction.findOne({ 
      'metadata.idempotencyKey': idempotencyKey,
      status: 'pending',
    });
    if (existing) {
      logger.warn('Duplicate PayPal deposit request', { idempotencyKey, userId: businessUser._id });
      throw new AppError('Duplicate transaction detected', 409);
    }
  }
  
  try {
    const metadata = {
      userId: businessUser._id.toString(),
      email: businessUser.email,
      campaignId,
      intentUsd: amount,
      feeUsd: breakdown.feeUsd,
      escrowCreditUsd: breakdown.escrowCreditUsd,
    };
    
    const order = await createPayPalOrder(breakdown.totalChargeUsd, returnUrl, cancelUrl, metadata);
    
    // Create pending transaction record
    const transaction = await recordTransaction({
      type: 'deposit',
      status: 'pending',
      fromUserId: businessUser._id,
      toUserId: businessUser._id,
      grossAmount: breakdown.intentUsd,
      feeAmount: breakdown.feeUsd,
      netAmount: breakdown.escrowCreditUsd,
      metadata: {
        campaignId,
        idempotencyKey,
        paymentMethod: 'paypal',
        paypalOrderId: order.orderId,
        amountRequested: amount,
        totalCharge: breakdown.totalChargeUsd,
      },
    });
    
    logger.info('PayPal order created', {
      transactionId: transaction._id,
      orderId: order.orderId,
      userId: businessUser._id,
      amount: breakdown.totalChargeUsd,
    });
    
    return {
      orderId: order.orderId,
      approvalUrl: order.approvalUrl,
      transactionId: transaction._id,
    };
    
  } catch (error) {
    logger.error('PayPal order creation failed', {
      userId: businessUser._id,
      error: error.message,
      response: error.response?.data,
    });
    
    if (error.response?.data) {
      throw new AppError(`PayPal error: ${error.response.data.message || 'Payment initiation failed'}`, 400);
    }
    throw new AppError('Failed to initiate PayPal payment. Please try again.', 500);
  }
}

/**
 * Complete PayPal deposit after approval
 * @param {Object} params - Completion parameters
 * @returns {Promise<Object>} Deposit result
 */
async function completePayPalDeposit({ orderId, payerId, transactionId }) {
  // Find pending transaction
  const transaction = await Transaction.findOne({ 
    'metadata.paypalOrderId': orderId,
    status: 'pending',
  });
  
  if (!transaction) {
    logger.warn('PayPal completion: Transaction not found', { orderId });
    throw new AppError('Transaction not found', 404);
  }
  
  try {
    // Capture the PayPal payment
    const capture = await capturePayPalOrder(orderId);
    
    if (capture.status !== 'COMPLETED') {
      transaction.status = 'failed';
      transaction.errorMessage = `PayPal capture failed: ${capture.status}`;
      await transaction.save();
      throw new AppError('Payment capture failed', 400);
    }
    
    // Update transaction
    transaction.status = 'completed';
    transaction.completedAt = new Date();
    transaction.referenceId = capture.captureId;
    transaction.metadata.paypalPayerId = payerId;
    transaction.metadata.paypalPayerEmail = capture.payerEmail;
    transaction.metadata.paypalCaptureId = capture.captureId;
    await transaction.save();
    
    // Process the deposit to wallet
    await completeDeposit(transaction);
    
    logger.info('PayPal deposit completed', {
      transactionId: transaction._id,
      orderId,
      captureId: capture.captureId,
    });
    
    return {
      success: true,
      transactionId: transaction._id,
      amount: transaction.grossAmount,
    };
    
  } catch (error) {
    logger.error('PayPal capture failed', {
      orderId,
      transactionId,
      error: error.message,
    });
    
    transaction.status = 'failed';
    transaction.errorMessage = error.message;
    await transaction.save();
    
    throw new AppError('Failed to complete PayPal payment', 500);
  }
}

// ============================================
// Wire Transfer Deposit
// ============================================

/**
 * Initiate wire transfer deposit (generates instructions)
 * @param {Object} params - Deposit parameters
 * @returns {Promise<Object>} Wire transfer instructions
 */
async function initiateWireDeposit({ businessUser, amount, campaignId, idempotencyKey }) {
  // Validate inputs
  if (!businessUser) throw new AppError('User information required', 400);
  if (!amount || amount <= 0) throw new AppError('Valid deposit amount required', 400);
  
  // Validate amount limits
  validateWireAmount(amount);
  
  // Calculate deposit breakdown
  const breakdown = calculateDeposit(amount);
  
  // Check for duplicate idempotency key
  if (idempotencyKey) {
    const existing = await Transaction.findOne({ 
      'metadata.idempotencyKey': idempotencyKey,
      status: { $in: ['pending', 'completed'] },
    });
    if (existing) {
      logger.warn('Duplicate wire deposit request', { idempotencyKey, userId: businessUser._id });
      throw new AppError('Duplicate transaction detected', 409);
    }
  }
  
  // Create pending transaction record
  const transaction = await recordTransaction({
    type: 'deposit',
    status: 'pending',
    fromUserId: businessUser._id,
    toUserId: businessUser._id,
    grossAmount: breakdown.intentUsd,
    feeAmount: breakdown.feeUsd,
    netAmount: breakdown.escrowCreditUsd,
    metadata: {
      campaignId,
      idempotencyKey,
      paymentMethod: 'wire',
      amountRequested: amount,
      totalCharge: breakdown.totalChargeUsd,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days expiry
    },
  });
  
  // Generate wire transfer instructions
  const instructions = generateWireInstructions(breakdown.totalChargeUsd, transaction._id, businessUser.email);
  
  logger.info('Wire deposit initiated', {
    transactionId: transaction._id,
    userId: businessUser._id,
    amount: breakdown.totalChargeUsd,
  });
  
  return {
    transactionId: transaction._id,
    instructions,
    expiresAt: transaction.metadata.expiresAt,
    amount: breakdown.totalChargeUsd,
    fee: breakdown.feeUsd,
    escrowCredit: breakdown.escrowCreditUsd,
  };
}

/**
 * Confirm wire transfer deposit (admin or webhook)
 * @param {Object} params - Confirmation parameters
 * @returns {Promise<Object>} Deposit result
 */
async function confirmWireDeposit({ transactionId, referenceNumber, confirmedBy }) {
  const transaction = await Transaction.findById(transactionId);
  
  if (!transaction) {
    throw new AppError('Transaction not found', 404);
  }
  
  if (transaction.status !== 'pending') {
    throw new AppError(`Transaction already ${transaction.status}`, 400);
  }
  
  // Update transaction
  transaction.status = 'completed';
  transaction.completedAt = new Date();
  transaction.referenceId = referenceNumber;
  transaction.metadata.confirmedBy = confirmedBy;
  transaction.metadata.confirmedAt = new Date();
  await transaction.save();
  
  // Process the deposit to wallet
  await completeDeposit(transaction);
  
  logger.info('Wire deposit confirmed', {
    transactionId: transaction._id,
    referenceNumber,
    confirmedBy,
  });
  
  return {
    success: true,
    transactionId: transaction._id,
    amount: transaction.grossAmount,
  };
}

// ============================================
// M-PESA Deposit
// ============================================

/**
 * Initiate M-PESA STK Push for deposit
 */
async function initiateMpesaDeposit({ businessUser, amount, phoneNumber, campaignId, idempotencyKey }) {
  // Validate inputs
  if (!businessUser) throw new AppError('User information required', 400);
  if (!amount || amount <= 0) throw new AppError('Valid deposit amount required', 400);
  if (!phoneNumber) throw new AppError('Phone number is required for M-PESA payment', 400);
  
  // Validate phone number format
  if (!validateMpesaPhoneNumber(phoneNumber)) {
    throw new AppError('Invalid Kenyan phone number format. Use 07XX XXX XXX or 2547XX XXX XXX', 400);
  }
  
  // Validate amount limits
  validateMpesaAmount(amount);
  
  // Calculate deposit breakdown
  const breakdown = calculateDeposit(amount);
  const formattedPhone = formatMpesaPhoneNumber(phoneNumber);
  const timestamp = getTimestamp();
  const password = getPassword(timestamp);
  
  // Check for duplicate idempotency key
  if (idempotencyKey) {
    const existing = await Transaction.findOne({ 
      'metadata.idempotencyKey': idempotencyKey,
      status: 'pending',
    });
    if (existing) {
      logger.warn('Duplicate M-PESA deposit request', { idempotencyKey, userId: businessUser._id });
      throw new AppError('Duplicate transaction detected. Please wait for existing payment to complete.', 409);
    }
  }
  
  try {
    const token = await getAccessToken();
    
    const payload = {
      BusinessShortCode: env.mpesaShortCode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerPayBillOnline",
      Amount: Math.round(breakdown.totalChargeUsd * USD_TO_KES_RATE),
      PartyA: formattedPhone,
      PartyB: env.mpesaShortCode,
      PhoneNumber: formattedPhone,
      CallBackURL: env.mpesaCallbackUrl || `${env.clientOrigin}/api/wallet/mpesa-callback`,
      AccountReference: `Pebeto${campaignId ? campaignId.slice(-6) : Date.now()}`,
      TransactionDesc: campaignId ? `Escrow for campaign: ${campaignId}` : 'Wallet deposit',
    };
    
    logger.info('Initiating M-PESA STK push', {
      userId: businessUser._id,
      amount: breakdown.totalChargeUsd,
      phoneNumber: formattedPhone.slice(-6),
      campaignId,
    });
    
    const response = await axios.post(
      `${env.mpesaApiUrl}/mpesa/stkpush/v1/processrequest`,
      payload,
      {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 30000,
      }
    );
    
    // Create pending transaction record
    const transaction = await recordTransaction({
      type: 'deposit',
      status: 'pending',
      fromUserId: businessUser._id,
      toUserId: businessUser._id,
      grossAmount: breakdown.intentUsd,
      feeAmount: breakdown.feeUsd,
      netAmount: breakdown.escrowCreditUsd,
      metadata: {
        campaignId,
        idempotencyKey,
        paymentMethod: 'mpesa',
        phoneNumber: formattedPhone,
        checkoutRequestId: response.data.CheckoutRequestID,
        amountRequested: amount,
        totalCharge: breakdown.totalChargeUsd,
      },
    });
    
    logger.info('M-PESA STK push initiated', {
      transactionId: transaction._id,
      checkoutRequestId: response.data.CheckoutRequestID,
      userId: businessUser._id,
    });
    
    return {
      checkoutRequestId: response.data.CheckoutRequestID,
      responseCode: response.data.ResponseCode,
      responseDescription: response.data.ResponseDescription,
      transactionId: transaction._id,
    };
    
  } catch (error) {
    logger.error('M-PESA STK push failed', {
      userId: businessUser._id,
      error: error.message,
      response: error.response?.data,
    });
    
    if (error.response?.data) {
      throw new AppError(`M-PESA error: ${error.response.data.errorMessage || 'Payment initiation failed'}`, 400);
    }
    throw new AppError('Failed to initiate M-PESA payment. Please try again.', 500);
  }
}

// ============================================
// Internal Wallet Deposit
// ============================================

/**
 * Complete deposit after payment confirmation (used by all methods)
 */
async function completeDeposit(transaction) {
  const breakdown = calculateDeposit(transaction.grossAmount);
  const businessUser = await User.findById(transaction.fromUserId);
  const businessWallet = await getOrCreateWallet(businessUser._id);
  const { admin, wallet: profitWallet } = await getAdminProfitWallet();
  
  await runInTransaction(async (session) => {
    // Credit escrow amount to business escrow balance
    await creditWallet(businessWallet._id, 'escrow', breakdown.escrowCreditUsd, session);
    
    // Credit platform fee to admin profit wallet
    if (breakdown.feeUsd > 0 && profitWallet) {
      await creditWallet(profitWallet._id, 'available', breakdown.feeUsd, session);
    }
    
    // Update transaction with additional metadata
    transaction.metadata.completedAt = new Date();
    transaction.metadata.escrowCredited = breakdown.escrowCreditUsd;
    transaction.metadata.feeCredited = breakdown.feeUsd;
    await transaction.save({ session });
  });
  
  logger.info('Deposit completed', {
    transactionId: transaction._id,
    userId: businessUser._id,
    amount: breakdown.escrowCreditUsd,
    method: transaction.metadata.paymentMethod,
  });
}

/**
 * Process deposit from business wallet balance (internal)
 */
async function processDeposit({ businessUser, intentUsd, campaignId, idempotencyKey, paymentMethod = 'wallet' }) {
  // Validate inputs
  if (!businessUser) throw new AppError('User information required', 400);
  if (!intentUsd || intentUsd <= 0) {
    throw new AppError('Valid deposit amount required', 400);
  }
  
  // Calculate deposit breakdown
  const breakdown = calculateDeposit(intentUsd);
  
  // Get user wallet
  const businessWallet = await getOrCreateWallet(businessUser._id);
  
  // Check sufficient funds
  if (businessWallet.balances.available < breakdown.totalChargeUsd) {
    throw new AppError(
      `Insufficient funds. Need $${breakdown.totalChargeUsd}. Available: $${businessWallet.balances.available}`,
      400
    );
  }
  
  // Check for duplicate idempotency key
  if (idempotencyKey) {
    const existing = await Transaction.findOne({ 
      'metadata.idempotencyKey': idempotencyKey,
      status: 'completed',
    });
    if (existing) {
      logger.warn('Duplicate deposit request', { idempotencyKey, userId: businessUser._id });
      throw new AppError('Duplicate transaction detected', 409);
    }
  }
  
  // Get admin profit wallet
  const { admin, wallet: profitWallet } = await getAdminProfitWallet();
  
  let depositTx;
  
  await runInTransaction(async (session) => {
    // Debit total amount from business available balance
    await debitWallet(businessWallet._id, 'available', breakdown.totalChargeUsd, session);
    
    // Credit escrow amount to business escrow balance
    await creditWallet(businessWallet._id, 'escrow', breakdown.escrowCreditUsd, session);
    
    // Credit platform fee to admin profit wallet
    if (breakdown.feeUsd > 0 && profitWallet) {
      await creditWallet(profitWallet._id, 'available', breakdown.feeUsd, session);
    }
    
    // Record deposit transaction
    depositTx = await recordTransaction(
      {
        type: 'deposit',
        status: 'completed',
        fromUserId: businessUser._id,
        toUserId: businessUser._id,
        fromWalletId: businessWallet._id,
        toWalletId: businessWallet._id,
        grossAmount: breakdown.intentUsd,
        feeAmount: breakdown.feeUsd,
        netAmount: breakdown.escrowCreditUsd,
        feeRate: breakdown.feeRate,
        feeSource: 'deposit',
        metadata: {
          campaignId,
          idempotencyKey,
          paymentMethod,
          depositBreakdown: breakdown,
        },
      },
      session
    );
  });
  
  logger.info('Internal deposit processed successfully', {
    userId: businessUser._id,
    amount: breakdown.intentUsd,
    fee: breakdown.feeUsd,
    campaignId,
    transactionId: depositTx._id,
  });
  
  return {
    transactionId: depositTx._id,
    breakdown,
  };
}

// ============================================
// Exports
// ============================================

module.exports = {
  // Main functions
  processDeposit,
  initiateMpesaDeposit,
  initiatePayPalDeposit,
  completePayPalDeposit,
  initiateWireDeposit,
  confirmWireDeposit,
  previewDeposit: previewDepositService,
  
  // Helper functions (for testing)
  validateMpesaPhoneNumber,
  formatMpesaPhoneNumber,
  validateMpesaAmount,
  validatePayPalEmail,
  validatePayPalAmount,
  validateWireAmount,
  generateWireInstructions,
  getPayPalAccessToken,
  createPayPalOrder,
  capturePayPalOrder,
  getPayPalOrderDetails,
};
