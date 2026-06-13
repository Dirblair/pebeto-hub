/**
 * Payment Service for Pebeto Creator's Hub
 * 
 * Orchestrates payment processing across multiple providers:
 * - M-Pesa (Kenya)
 * - PayPal (Global)
 * - Wire/Bank Transfer (International)
 * 
 * @module services/paymentService
 */

const { AppError } = require('../utils/errors');
const logger = require('../utils/logger');
const {
  initiateMpesaDeposit,
  completeMpesaDeposit,
  queryMpesaStatus,
} = require('./mpesaService');
const {
  initiatePayPalDeposit,
  completePayPalDeposit,
  getPayPalOrderStatus,
} = require('./paypalService');
const {
  initiateWireDeposit,
  confirmWireDeposit,
} = require('./depositService');

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
// Main Payment Orchestration
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
    default:
      throw new AppError(`Unsupported payment method: ${method}`, 400);
  }
}

/**
 * Process M-Pesa payment
 */
async function processMpesaPayment({ userId, amount, phoneNumber, campaignId, idempotencyKey }) {
  try {
    const result = await initiateMpesaDeposit({
      businessUser: { _id: userId },
      amount,
      phoneNumber,
      campaignId,
      idempotencyKey,
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
 * Process PayPal payment
 */
async function processPayPalPayment({ userId, amount, returnUrl, cancelUrl, campaignId, idempotencyKey }) {
  try {
    const result = await initiatePayPalDeposit({
      businessUser: { _id: userId, email: '' },
      amount,
      campaignId,
      returnUrl,
      cancelUrl,
      idempotencyKey,
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
 * Process wire transfer payment
 */
async function processWirePayment({ userId, amount, campaignId, idempotencyKey }) {
  try {
    const result = await initiateWireDeposit({
      businessUser: { _id: userId, email: '' },
      amount,
      campaignId,
      idempotencyKey,
    });
    
    return {
      success: true,
      method: PAYMENT_METHODS.WIRE,
      status: PAYMENT_STATUS.PENDING,
      transactionId: result.transactionId,
      instructions: result.instructions,
      expiresAt: result.expiresAt,
      message: 'Wire transfer instructions generated. Please complete the transfer.',
    };
  } catch (error) {
    logger.error('Wire payment failed', { userId, amount, error: error.message });
    throw error;
  }
}

/**
 * Complete payment after approval
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
    case PAYMENT_METHODS.MPESA:
      return completeMpesaPayment({ checkoutRequestId: orderId, transactionId });
    default:
      throw new AppError(`Cannot complete payment for method: ${method}`, 400);
  }
}

/**
 * Complete PayPal payment
 */
async function completePayPalPayment({ orderId, payerId, transactionId }) {
  try {
    const result = await completePayPalDeposit({ orderId, payerId, transactionId });
    return {
      success: true,
      method: PAYMENT_METHODS.PAYPAL,
      status: PAYMENT_STATUS.COMPLETED,
      transactionId: result.transactionId,
      amount: result.amount,
      message: 'Payment completed successfully.',
    };
  } catch (error) {
    logger.error('PayPal completion failed', { orderId, error: error.message });
    throw error;
  }
}

/**
 * Complete wire transfer payment
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
 * Complete M-Pesa payment (callback handling)
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
    default:
      return { status: PAYMENT_STATUS.PENDING, message: 'Status unknown' };
  }
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
    { id: PAYMENT_METHODS.WALLET, name: 'Wallet Balance', enabled: true, icon: 'wallet' },
    { id: PAYMENT_METHODS.PAYPAL, name: 'PayPal', enabled: true, icon: 'paypal' },
  ];
  
  // Add M-Pesa for users in Kenya
  if (user?.location === 'KE' || user?.preferredCurrency === 'KES') {
    methods.unshift({ id: PAYMENT_METHODS.MPESA, name: 'M-Pesa', enabled: true, icon: 'phone' });
  }
  
  // Add wire transfer for high-value transactions
  methods.push({ id: PAYMENT_METHODS.WIRE, name: 'Wire Transfer', enabled: true, icon: 'bank' });
  
  return methods;
}

// ============================================
// Exports
// ============================================

module.exports = {
  processPayment,
  completePayment,
  getPaymentStatus,
  getAvailablePaymentMethods,
  PAYMENT_METHODS,
  PAYMENT_STATUS,
};
