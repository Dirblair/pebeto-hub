/**
 * Payment Service for Pebeto Creator's Hub
 * 
 * Orchestrates payment processing across multiple providers:
 * - M-Pesa (Kenya) - REAL STK Push integration
 * - PayPal (Global) - REAL Order/Capture integration
 * - Wire/Bank Transfer (International) - Admin confirmation workflow
 * - Wallet Balance - Internal transfers
 * 
 * @module services/paymentService
 */

const axios = require('axios');
const { AppError } = require('../utils/errors');
const logger = require('../utils/logger');
const {
  initiateMpesaDeposit,
  queryMpesaStatus,
  processSTKCallback,
} = require('./mpesaService');
const {
  initiatePayPalDeposit,
  completePayPalDeposit,
  getPayPalOrderDetails,
} = require('./depositService');
const {
  initiateWireDeposit,
  confirmWireDeposit,
} = require('./depositService');
const {
  getOrCreateWallet,
  recordTransaction,
  creditWallet,
  debitWallet,
  runInTransaction,
} = require('./walletService');
const User = require('../models/User');
const Transaction = require('../models/Transaction');

// ============================================
// Constants
// ============================================

const PAYMENT_METHODS = {
  MPESA: 'mpesa',
  PAYPAL: 'paypal',
  WIRE: 'wire',
  BANK_TRANSFER: 'bank_transfer',
  WALLET: 'wallet',
};

const PAYMENT_STATUS = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
  REFUNDED: 'refunded',
  CANCELLED: 'cancelled',
};

// ============================================
// Helper Functions
// ============================================

/**
 * Generate unique transaction reference
 * @param {string} prefix - Reference prefix
 * @returns {string} Unique reference
 */
function generateReference(prefix = 'PAY') {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `${prefix}_${timestamp}_${random}`.toUpperCase();
}

/**
 * Validate webhook signature for payment providers
 * @param {Object} params - Webhook parameters
 * @returns {Promise<boolean>}
 */
async function validateWebhookSignature(params) {
  const { provider, headers, body } = params;
  
  switch (provider) {
    case PAYMENT_METHODS.PAYPAL:
      const paypalService = require('./paypalService');
      return paypalService.validateWebhookSignature({
        headers,
        body,
        webhookId: process.env.PAYPAL_WEBHOOK_ID
      });
      
    case PAYMENT_METHODS.MPESA:
      // M-Pesa callbacks are validated by the unique checkout request ID
      return true;
      
    default:
      return true;
  }
}

// ============================================
// Main Payment Orchestration - REAL IMPLEMENTATIONS
// ============================================

/**
 * Process payment based on method
 * @param {Object} params - Payment parameters
 * @returns {Promise<Object>} Payment result
 */
async function processPayment(params) {
  const { method, userId, amount, currency, metadata = {} } = params;
  
  logger.info('Processing payment', { method, userId, amount, currency });
  
  switch (method) {
    case PAYMENT_METHODS.MPESA:
      return processMpesaPayment(params);
    case PAYMENT_METHODS.PAYPAL:
      return processPayPalPayment(params);
    case PAYMENT_METHODS.WIRE:
      return processWirePayment(params);
    case PAYMENT_METHODS.BANK_TRANSFER:
      return processBankTransferPayment(params);
    case PAYMENT_METHODS.WALLET:
      return processWalletPayment(params);
    default:
      throw new AppError(`Unsupported payment method: ${method}`, 400);
  }
}

/**
 * Process M-Pesa payment (REAL - STK Push)
 * @param {Object} params - Payment parameters
 * @returns {Promise<Object>} Payment result
 */
async function processMpesaPayment({ userId, amount, phoneNumber, campaignId, idempotencyKey, description }) {
  // Validate inputs
  if (!amount || amount <= 0) {
    throw new AppError('Valid payment amount required', 400);
  }
  
  if (!phoneNumber) {
    throw new AppError('Phone number is required for M-Pesa payment', 400);
  }
  
  // Get user details
  const user = await User.findById(userId);
  if (!user) {
    throw new AppError('User not found', 404);
  }
  
  try {
    const result = await initiateMpesaDeposit({
      businessUser: user,
      amount: parseFloat(amount),
      phoneNumber,
      campaignId,
      idempotencyKey,
      description: description || 'Pebeto wallet deposit'
    });
    
    logger.info('M-Pesa payment initiated', {
      userId,
      amount,
      checkoutRequestId: result.checkoutRequestId,
      transactionId: result.transactionId
    });
    
    return {
      success: true,
      method: PAYMENT_METHODS.MPESA,
      status: PAYMENT_STATUS.PENDING,
      checkoutRequestId: result.checkoutRequestId,
      transactionId: result.transactionId,
      message: 'M-Pesa STK push sent to your phone. Please enter your PIN to complete payment.',
    };
  } catch (error) {
    logger.error('M-Pesa payment failed', { userId, amount, error: error.message });
    throw error;
  }
}

/**
 * Process PayPal payment (REAL - Order Creation)
 * @param {Object} params - Payment parameters
 * @returns {Promise<Object>} Payment result
 */
async function processPayPalPayment({ userId, amount, returnUrl, cancelUrl, campaignId, idempotencyKey, description }) {
  // Validate inputs
  if (!amount || amount <= 0) {
    throw new AppError('Valid payment amount required', 400);
  }
  
  if (!returnUrl || !cancelUrl) {
    throw new AppError('Return URL and Cancel URL are required for PayPal payment', 400);
  }
  
  // Get user details
  const user = await User.findById(userId);
  if (!user) {
    throw new AppError('User not found', 404);
  }
  
  try {
    const result = await initiatePayPalDeposit({
      businessUser: user,
      amount: parseFloat(amount),
      campaignId,
      returnUrl,
      cancelUrl,
      idempotencyKey,
      description: description || 'Pebeto wallet deposit'
    });
    
    logger.info('PayPal payment initiated', {
      userId,
      amount,
      orderId: result.orderId,
      transactionId: result.transactionId
    });
    
    return {
      success: true,
      method: PAYMENT_METHODS.PAYPAL,
      status: PAYMENT_STATUS.PENDING,
      orderId: result.orderId,
      approvalUrl: result.approvalUrl,
      transactionId: result.transactionId,
      message: 'Redirect to PayPal to complete payment.',
    };
  } catch (error) {
    logger.error('PayPal payment failed', { userId, amount, error: error.message });
    throw error;
  }
}

/**
 * Process Wire Transfer payment (REAL - Generates instructions)
 * @param {Object} params - Payment parameters
 * @returns {Promise<Object>} Payment result
 */
async function processWirePayment({ userId, amount, campaignId, idempotencyKey, description }) {
  // Validate inputs
  if (!amount || amount <= 0) {
    throw new AppError('Valid payment amount required', 400);
  }
  
  if (amount < 100) {
    throw new AppError('Minimum wire transfer amount is $100 USD', 400);
  }
  
  if (amount > 50000) {
    throw new AppError('Maximum wire transfer amount is $50,000 USD', 400);
  }
  
  // Get user details
  const user = await User.findById(userId);
  if (!user) {
    throw new AppError('User not found', 404);
  }
  
  try {
    const result = await initiateWireDeposit({
      businessUser: user,
      amount: parseFloat(amount),
      campaignId,
      idempotencyKey,
      description: description || 'Pebeto wallet deposit'
    });
    
    logger.info('Wire transfer payment initiated', {
      userId,
      amount,
      transactionId: result.transactionId
    });
    
    return {
      success: true,
      method: PAYMENT_METHODS.WIRE,
      status: PAYMENT_STATUS.PENDING,
      transactionId: result.transactionId,
      instructions: result.instructions,
      expiresAt: result.expiresAt,
      message: 'Wire transfer instructions generated. Please complete the transfer within 7 days.',
    };
  } catch (error) {
    logger.error('Wire payment failed', { userId, amount, error: error.message });
    throw error;
  }
}

/**
 * Process Bank Transfer payment (similar to wire but for local transfers)
 * @param {Object} params - Payment parameters
 * @returns {Promise<Object>} Payment result
 */
async function processBankTransferPayment({ userId, amount, campaignId, idempotencyKey, description }) {
  // Validate inputs
  if (!amount || amount <= 0) {
    throw new AppError('Valid payment amount required', 400);
  }
  
  if (amount < 10) {
    throw new AppError('Minimum bank transfer amount is $10 USD', 400);
  }
  
  const user = await User.findById(userId);
  if (!user) {
    throw new AppError('User not found', 404);
  }
  
  try {
    const result = await initiateWireDeposit({
      businessUser: user,
      amount: parseFloat(amount),
      campaignId,
      idempotencyKey,
      description: description || 'Pebeto wallet deposit',
      isLocalBankTransfer: true
    });
    
    logger.info('Bank transfer payment initiated', {
      userId,
      amount,
      transactionId: result.transactionId
    });
    
    return {
      success: true,
      method: PAYMENT_METHODS.BANK_TRANSFER,
      status: PAYMENT_STATUS.PENDING,
      transactionId: result.transactionId,
      instructions: result.instructions,
      expiresAt: result.expiresAt,
      message: 'Bank transfer instructions generated. Please complete the transfer.',
    };
  } catch (error) {
    logger.error('Bank transfer payment failed', { userId, amount, error: error.message });
    throw error;
  }
}

/**
 * Process Wallet Balance payment (internal transfer)
 * @param {Object} params - Payment parameters
 * @returns {Promise<Object>} Payment result
 */
async function processWalletPayment({ userId, amount, campaignId, idempotencyKey, description }) {
  // Validate inputs
  if (!amount || amount <= 0) {
    throw new AppError('Valid payment amount required', 400);
  }
  
  const user = await User.findById(userId);
  if (!user) {
    throw new AppError('User not found', 404);
  }
  
  const userWallet = await getOrCreateWallet(userId);
  
  // Check sufficient balance
  if (userWallet.balances.available < amount) {
    throw new AppError(
      `Insufficient wallet balance. Available: $${userWallet.balances.available}, Requested: $${amount}`,
      400
    );
  }
  
  let paymentTx;
  
  await runInTransaction(async (session) => {
    // Debit user's wallet
    await debitWallet(userWallet._id, 'available', amount, session);
    
    // If campaign deposit, credit to escrow
    if (campaignId) {
      await creditWallet(userWallet._id, 'escrow', amount, session);
    }
    
    // Record transaction
    paymentTx = await recordTransaction(
      {
        type: campaignId ? 'campaign_fund' : 'payment',
        status: PAYMENT_STATUS.COMPLETED,
        fromUserId: userId,
        toUserId: userId,
        fromWalletId: userWallet._id,
        toWalletId: userWallet._id,
        grossAmount: amount,
        feeAmount: 0,
        netAmount: amount,
        metadata: {
          campaignId,
          idempotencyKey,
          paymentMethod: PAYMENT_METHODS.WALLET,
          description: description || 'Wallet payment',
        },
      },
      session
    );
    
    // Update campaign escrow if applicable
    if (campaignId) {
      const Campaign = require('../models/Campaign');
      const campaign = await Campaign.findById(campaignId).session(session);
      if (campaign) {
        campaign.escrowHeld = (campaign.escrowHeld || 0) + amount;
        campaign.fundedAmount = (campaign.fundedAmount || 0) + amount;
        await campaign.save({ session });
      }
    }
  });
  
  logger.info('Wallet payment processed', {
    userId,
    amount,
    campaignId,
    transactionId: paymentTx._id
  });
  
  return {
    success: true,
    method: PAYMENT_METHODS.WALLET,
    status: PAYMENT_STATUS.COMPLETED,
    transactionId: paymentTx._id,
    amount,
    message: 'Payment completed from wallet balance.',
  };
}

// ============================================
// Payment Completion Functions
// ============================================

/**
 * Complete payment after approval (for PayPal and similar)
 * @param {Object} params - Completion parameters
 * @returns {Promise<Object>} Completion result
 */
async function completePayment(params) {
  const { method, orderId, payerId, transactionId, referenceNumber, confirmedBy } = params;
  
  logger.info('Completing payment', { method, orderId, transactionId });
  
  switch (method) {
    case PAYMENT_METHODS.PAYPAL:
      return completePayPalPayment({ orderId, payerId, transactionId });
      
    case PAYMENT_METHODS.WIRE:
      return completeWirePayment({ transactionId, referenceNumber, confirmedBy });
      
    case PAYMENT_METHODS.BANK_TRANSFER:
      return completeBankTransferPayment({ transactionId, referenceNumber, confirmedBy });
      
    case PAYMENT_METHODS.MPESA:
      return completeMpesaPayment({ checkoutRequestId: orderId, transactionId });
      
    default:
      throw new AppError(`Cannot complete payment for method: ${method}`, 400);
  }
}

/**
 * Complete PayPal payment (REAL - Capture)
 * @param {Object} params - Completion parameters
 * @returns {Promise<Object>} Completion result
 */
async function completePayPalPayment({ orderId, payerId, transactionId }) {
  try {
    const result = await completePayPalDeposit({ orderId, payerId, transactionId });
    
    // Get the transaction to return amount
    const transaction = await Transaction.findById(transactionId);
    
    return {
      success: true,
      method: PAYMENT_METHODS.PAYPAL,
      status: PAYMENT_STATUS.COMPLETED,
      transactionId: result.transactionId,
      amount: transaction?.grossAmount || 0,
      message: 'Payment completed successfully.',
    };
  } catch (error) {
    logger.error('PayPal completion failed', { orderId, error: error.message });
    throw error;
  }
}

/**
 * Complete Wire Transfer payment (REAL - Admin confirmation)
 * @param {Object} params - Completion parameters
 * @returns {Promise<Object>} Completion result
 */
async function completeWirePayment({ transactionId, referenceNumber, confirmedBy }) {
  try {
    const result = await confirmWireDeposit({ transactionId, referenceNumber, confirmedBy });
    
    return {
      success: true,
      method: PAYMENT_METHODS.WIRE,
      status: PAYMENT_STATUS.COMPLETED,
      transactionId: result.transactionId,
      amount: result.amount,
      message: 'Wire transfer confirmed. Funds added to wallet.',
    };
  } catch (error) {
    logger.error('Wire completion failed', { transactionId, error: error.message });
    throw error;
  }
}

/**
 * Complete Bank Transfer payment (REAL - Admin confirmation)
 * @param {Object} params - Completion parameters
 * @returns {Promise<Object>} Completion result
 */
async function completeBankTransferPayment({ transactionId, referenceNumber, confirmedBy }) {
  try {
    const result = await confirmWireDeposit({ transactionId, referenceNumber, confirmedBy });
    
    return {
      success: true,
      method: PAYMENT_METHODS.BANK_TRANSFER,
      status: PAYMENT_STATUS.COMPLETED,
      transactionId: result.transactionId,
      amount: result.amount,
      message: 'Bank transfer confirmed. Funds added to wallet.',
    };
  } catch (error) {
    logger.error('Bank transfer completion failed', { transactionId, error: error.message });
    throw error;
  }
}

/**
 * Complete M-Pesa payment (handled by callback)
 * @param {Object} params - Completion parameters
 * @returns {Promise<Object>} Completion result
 */
async function completeMpesaPayment({ checkoutRequestId, transactionId }) {
  try {
    const result = await queryMpesaStatus(checkoutRequestId);
    if (result.status === 'completed') {
      return {
        success: true,
        method: PAYMENT_METHODS.MPESA,
        status: PAYMENT_STATUS.COMPLETED,
        transactionId,
        message: 'M-Pesa payment completed.',
      };
    }
    return {
      success: false,
      method: PAYMENT_METHODS.MPESA,
      status: PAYMENT_STATUS.FAILED,
      message: result.resultDesc || 'Payment failed',
    };
  } catch (error) {
    logger.error('M-Pesa completion failed', { checkoutRequestId, error: error.message });
    throw error;
  }
}

// ============================================
// Payment Status Functions
// ============================================

/**
 * Get payment status
 * @param {Object} params - Status parameters
 * @returns {Promise<Object>} Payment status
 */
async function getPaymentStatus({ method, orderId, transactionId }) {
  switch (method) {
    case PAYMENT_METHODS.PAYPAL:
      return getPayPalOrderStatus(orderId);
      
    case PAYMENT_METHODS.MPESA:
      return queryMpesaStatus(orderId);
      
    case PAYMENT_METHODS.WIRE:
    case PAYMENT_METHODS.BANK_TRANSFER:
      // Check database for transaction status
      const transaction = await Transaction.findById(transactionId);
      if (!transaction) {
        return { status: PAYMENT_STATUS.FAILED, message: 'Transaction not found' };
      }
      return {
        status: transaction.status,
        message: `Payment is ${transaction.status}`,
        reference: transaction.referenceId,
      };
      
    default:
      return { status: PAYMENT_STATUS.PENDING, message: 'Status unknown' };
  }
}

/**
 * Get PayPal order status (REAL)
 * @param {string} orderId - PayPal order ID
 * @returns {Promise<Object>} Order status
 */
async function getPayPalOrderStatus(orderId) {
  try {
    const details = await getPayPalOrderDetails(orderId);
    let status = PAYMENT_STATUS.PENDING;
    
    if (details.status === 'APPROVED' || details.status === 'COMPLETED') {
      status = PAYMENT_STATUS.COMPLETED;
    } else if (details.status === 'VOIDED' || details.status === 'DENIED') {
      status = PAYMENT_STATUS.FAILED;
    }
    
    return {
      status,
      orderStatus: details.status,
      amount: details.amount,
      currency: details.currency,
    };
  } catch (error) {
    logger.error('Failed to get PayPal order status', { orderId, error: error.message });
    return { status: PAYMENT_STATUS.FAILED, message: error.message };
  }
}

// ============================================
// Webhook Handlers
// ============================================

/**
 * Handle PayPal webhook event (REAL)
 * @param {Object} event - Webhook event
 * @returns {Promise<Object>} Processed event
 */
async function handlePayPalWebhook(event) {
  const eventType = event.event_type;
  const resource = event.resource;
  
  logger.info('Processing PayPal webhook', { eventType, resourceId: resource?.id });
  
  switch (eventType) {
    case 'PAYMENT.CAPTURE.COMPLETED':
      // Find transaction by PayPal capture ID
      const transaction = await Transaction.findOne({
        'metadata.paypalCaptureId': resource.id
      });
      
      if (transaction && transaction.status !== PAYMENT_STATUS.COMPLETED) {
        transaction.status = PAYMENT_STATUS.COMPLETED;
        transaction.completedAt = new Date();
        transaction.referenceId = resource.id;
        await transaction.save();
        
        // Process deposit completion
        const { completeDeposit } = require('./depositService');
        await completeDeposit(transaction);
        
        logger.info('PayPal webhook: Payment completed', { transactionId: transaction._id });
      }
      return { type: 'payment_completed', processed: true };
      
    case 'PAYMENT.CAPTURE.DENIED':
    case 'PAYMENT.CAPTURE.DECLINED':
      const failedTransaction = await Transaction.findOne({
        'metadata.paypalCaptureId': resource.id
      });
      if (failedTransaction) {
        failedTransaction.status = PAYMENT_STATUS.FAILED;
        failedTransaction.errorMessage = `Payment ${eventType.toLowerCase()}`;
        await failedTransaction.save();
      }
      return { type: 'payment_failed', processed: true };
      
    default:
      return { type: 'unhandled', event: eventType };
  }
}

/**
 * Handle M-Pesa callback webhook (REAL)
 * @param {Object} callbackData - STK callback data
 * @returns {Promise<Object>} Processed callback
 */
async function handleMpesaCallback(callbackData) {
  const result = processSTKCallback(callbackData);
  
  if (result.success) {
    // Find transaction by checkout request ID
    const transaction = await Transaction.findOne({
      'metadata.checkoutRequestId': result.checkoutRequestId
    });
    
    if (transaction && transaction.status !== PAYMENT_STATUS.COMPLETED) {
      transaction.status = PAYMENT_STATUS.COMPLETED;
      transaction.completedAt = new Date();
      transaction.referenceId = result.metadata.mpesaReceiptNumber;
      transaction.metadata.mpesaReceiptNumber = result.metadata.mpesaReceiptNumber;
      await transaction.save();
      
      // Process deposit completion
      const { completeDeposit } = require('./depositService');
      await completeDeposit(transaction);
      
      logger.info('M-Pesa callback: Payment completed', {
        transactionId: transaction._id,
        receiptNumber: result.metadata.mpesaReceiptNumber
      });
    }
  }
  
  return result;
}

// ============================================
// Helper Functions
// ============================================

/**
 * Get available payment methods for a user
 * @param {Object} user - User object
 * @returns {Array} Available methods
 */
function getAvailablePaymentMethods(user) {
  const methods = [
    { 
      id: PAYMENT_METHODS.WALLET, 
      name: 'Wallet Balance', 
      enabled: true, 
      icon: 'wallet',
      description: 'Use your Pebeto wallet balance'
    },
    { 
      id: PAYMENT_METHODS.PAYPAL, 
      name: 'PayPal', 
      enabled: !!process.env.PAYPAL_CLIENT_ID, 
      icon: 'paypal',
      description: 'Pay with PayPal account'
    },
  ];
  
  // Add M-Pesa for users in Kenya
  if (user?.location === 'KE' || user?.preferredCurrency === 'KES') {
    methods.unshift({ 
      id: PAYMENT_METHODS.MPESA, 
      name: 'M-Pesa', 
      enabled: true, 
      icon: 'phone',
      description: 'Pay with M-Pesa (instant)'
    });
  }
  
  // Add wire transfer for high-value transactions
  methods.push({ 
    id: PAYMENT_METHODS.WIRE, 
    name: 'Wire Transfer', 
    enabled: true, 
    icon: 'bank',
    description: 'International wire transfer (2-5 days)'
  });
  
  methods.push({ 
    id: PAYMENT_METHODS.BANK_TRANSFER, 
    name: 'Bank Transfer', 
    enabled: true, 
    icon: 'bank',
    description: 'Local bank transfer (1-2 days)'
  });
  
  return methods;
}

/**
 * Calculate payment fee based on method
 * @param {number} amount - Payment amount
 * @param {string} method - Payment method
 * @returns {Object} Fee breakdown
 */
function calculatePaymentFee(amount, method) {
  const feeRates = {
    [PAYMENT_METHODS.MPESA]: 0.10,    // 10%
    [PAYMENT_METHODS.PAYPAL]: 0.029,  // 2.9% + $0.30 (simplified)
    [PAYMENT_METHODS.WIRE]: 0.01,      // 1% (min $15, max $150)
    [PAYMENT_METHODS.BANK_TRANSFER]: 0.005, // 0.5%
    [PAYMENT_METHODS.WALLET]: 0,        // 0%
  };
  
  const rate = feeRates[method] || 0;
  let fee = amount * rate;
  
  // PayPal has a fixed fee component
  if (method === PAYMENT_METHODS.PAYPAL && amount > 0) {
    fee += 0.30;
  }
  
  // Wire transfer minimum fee
  if (method === PAYMENT_METHODS.WIRE && fee < 15) {
    fee = 15;
  }
  
  // Wire transfer maximum fee
  if (method === PAYMENT_METHODS.WIRE && fee > 150) {
    fee = 150;
  }
  
  return {
    rate: rate * 100,
    feeAmount: Math.round(fee * 100) / 100,
    netAmount: Math.round((amount - fee) * 100) / 100,
  };
}

// ============================================
// Exports
// ============================================

module.exports = {
  // Main functions
  processPayment,
  completePayment,
  getPaymentStatus,
  getAvailablePaymentMethods,
  
  // Webhook handlers
  handlePayPalWebhook,
  handleMpesaCallback,
  validateWebhookSignature,
  
  // Helper functions
  calculatePaymentFee,
  generateReference,
  
  // Constants
  PAYMENT_METHODS,
  PAYMENT_STATUS,
};
