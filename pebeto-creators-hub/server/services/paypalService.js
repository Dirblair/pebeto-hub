/**
 * PayPal Service for Pebeto Creator's Hub
 * 
 * Handles PayPal payment processing:
 * - Order creation
 * - Order capture
 * - Order status checking
 * - Webhook handling
 * 
 * @module services/paypalService
 */

const axios = require('axios');
const env = require('../config/env');
const logger = require('../utils/logger');
const { AppError } = require('../utils/errors');

// ============================================
// Constants
// ============================================

let cachedAccessToken = null;
let tokenExpiry = null;
const TOKEN_CACHE_TTL = 50 * 60 * 1000; // 50 minutes

const PAYPAL_ENVIRONMENTS = {
  SANDBOX: 'sandbox',
  PRODUCTION: 'production',
};

// ============================================
// Token Management
// ============================================

/**
 * Get PayPal access token
 * @param {boolean} forceRefresh - Force refresh token
 * @returns {Promise<string>} Access token
 */
async function getPayPalAccessToken(forceRefresh = false) {
  if (!forceRefresh && cachedAccessToken && tokenExpiry && Date.now() < tokenExpiry) {
    logger.debug('Using cached PayPal access token');
    return cachedAccessToken;
  }
  
  const clientId = env.paypal.clientId;
  const clientSecret = env.paypal.clientSecret;
  const apiUrl = env.paypal.apiUrl;
  
  if (!clientId || !clientSecret) {
    throw new AppError('PayPal credentials not configured', 500);
  }
  
  try {
    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    
    const response = await axios.post(
      `${apiUrl}/v1/oauth2/token`,
      'grant_type=client_credentials',
      {
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: 30000,
      }
    );
    
    cachedAccessToken = response.data.access_token;
    tokenExpiry = Date.now() + (response.data.expires_in * 1000) - 60000; // 1 minute buffer
    
    logger.info('PayPal access token obtained');
    return cachedAccessToken;
  } catch (error) {
    logger.error('Failed to get PayPal access token', {
      error: error.message,
      status: error.response?.status,
    });
    throw new AppError('PayPal authentication failed', 502);
  }
}

// ============================================
// Order Management
// ============================================

/**
 * Create PayPal order
 * @param {Object} params - Order parameters
 * @returns {Promise<Object>} Order details
 */
async function createPayPalOrder({ amount, currency = 'USD', returnUrl, cancelUrl, metadata = {} }) {
  const token = await getPayPalAccessToken();
  const apiUrl = env.paypal.apiUrl;
  
  const payload = {
    intent: 'CAPTURE',
    purchase_units: [
      {
        amount: {
          currency_code: currency,
          value: amount.toFixed(2),
        },
        description: metadata.description || 'Pebeto Wallet Deposit',
        custom_id: JSON.stringify(metadata),
        invoice_id: `INV-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`,
      },
    ],
    application_context: {
      brand_name: 'Pebeto',
      landing_page: 'BILLING',
      user_action: 'PAY_NOW',
      return_url: returnUrl,
      cancel_url: cancelUrl,
    },
  };
  
  try {
    const response = await axios.post(
      `${apiUrl}/v2/checkout/orders`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );
    
    const approvalUrl = response.data.links.find(link => link.rel === 'approve')?.href;
    
    logger.info('PayPal order created', {
      orderId: response.data.id,
      amount,
      currency,
    });
    
    return {
      orderId: response.data.id,
      approvalUrl,
      status: response.data.status,
      createTime: response.data.create_time,
    };
  } catch (error) {
    logger.error('Failed to create PayPal order', {
      error: error.message,
      response: error.response?.data,
    });
    throw new AppError('Failed to create PayPal order', 502);
  }
}

/**
 * Capture PayPal order
 * @param {string} orderId - PayPal order ID
 * @returns {Promise<Object>} Capture details
 */
async function capturePayPalOrder(orderId) {
  const token = await getPayPalAccessToken();
  const apiUrl = env.paypal.apiUrl;
  
  try {
    const response = await axios.post(
      `${apiUrl}/v2/checkout/orders/${orderId}/capture`,
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
    
    logger.info('PayPal order captured', {
      orderId,
      captureId: capture?.id,
      status: capture?.status,
    });
    
    return {
      orderId: response.data.id,
      captureId: capture?.id,
      status: capture?.status,
      amount: capture?.amount?.value ? parseFloat(capture.amount.value) : null,
      currency: capture?.amount?.currency_code,
      payerEmail: response.data.payer?.email_address,
      payerName: `${response.data.payer?.name?.given_name || ''} ${response.data.payer?.name?.surname || ''}`.trim(),
      createTime: response.data.create_time,
      updateTime: response.data.update_time,
    };
  } catch (error) {
    logger.error('Failed to capture PayPal order', {
      orderId,
      error: error.message,
      response: error.response?.data,
    });
    throw new AppError('Failed to capture PayPal payment', 502);
  }
}

/**
 * Get PayPal order details
 * @param {string} orderId - PayPal order ID
 * @returns {Promise<Object>} Order details
 */
async function getPayPalOrderDetails(orderId) {
  const token = await getPayPalAccessToken();
  const apiUrl = env.paypal.apiUrl;
  
  try {
    const response = await axios.get(
      `${apiUrl}/v2/checkout/orders/${orderId}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );
    
    return {
      orderId: response.data.id,
      status: response.data.status,
      amount: response.data.purchase_units[0]?.amount?.value,
      currency: response.data.purchase_units[0]?.amount?.currency_code,
      createTime: response.data.create_time,
    };
  } catch (error) {
    logger.error('Failed to get PayPal order details', {
      orderId,
      error: error.message,
    });
    throw new AppError('Failed to get PayPal order status', 502);
  }
}

/**
 * Refund PayPal payment
 * @param {string} captureId - PayPal capture ID
 * @param {number} amount - Amount to refund
 * @returns {Promise<Object>} Refund details
 */
async function refundPayPalPayment(captureId, amount = null) {
  const token = await getPayPalAccessToken();
  const apiUrl = env.paypal.apiUrl;
  
  const payload = amount ? { amount: { value: amount.toFixed(2), currency_code: 'USD' } } : {};
  
  try {
    const response = await axios.post(
      `${apiUrl}/v2/payments/captures/${captureId}/refund`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );
    
    logger.info('PayPal payment refunded', {
      captureId,
      amount: amount || 'full',
      refundId: response.data.id,
    });
    
    return {
      refundId: response.data.id,
      status: response.data.status,
      amount: response.data.amount?.value,
    };
  } catch (error) {
    logger.error('Failed to refund PayPal payment', {
      captureId,
      error: error.message,
    });
    throw new AppError('Failed to refund PayPal payment', 502);
  }
}

/**
 * Validate PayPal webhook signature
 * @param {Object} params - Webhook parameters
 * @returns {Promise<boolean>} Valid signature
 */
async function validateWebhookSignature({ headers, body, webhookId }) {
  const token = await getPayPalAccessToken();
  const apiUrl = env.paypal.apiUrl;
  
  const transmissionId = headers['paypal-transmission-id'];
  const timestamp = headers['paypal-transmission-time'];
  const webhookEvent = body;
  const certUrl = headers['paypal-cert-url'];
  const authAlgo = headers['paypal-auth-algo'];
  const transmissionSig = headers['paypal-transmission-sig'];
  
  try {
    const response = await axios.post(
      `${apiUrl}/v1/notifications/verify-webhook-signature`,
      {
        transmission_id: transmissionId,
        transmission_time: timestamp,
        cert_url: certUrl,
        auth_algo: authAlgo,
        transmission_sig: transmissionSig,
        webhook_id: webhookId,
        webhook_event: webhookEvent,
      },
      {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 30000,
      }
    );
    
    return response.data.verification_status === 'SUCCESS';
  } catch (error) {
    logger.error('Failed to validate webhook signature', { error: error.message });
    return false;
  }
}

// ============================================
// Webhook Processing
// ============================================

/**
 * Process PayPal webhook event
 * @param {Object} event - Webhook event
 * @returns {Object} Processed event
 */
function processWebhookEvent(event) {
  const eventType = event.event_type;
  const resource = event.resource;
  
  logger.info('Processing PayPal webhook', { eventType, resourceId: resource?.id });
  
  switch (eventType) {
    case 'CHECKOUT.ORDER.APPROVED':
      return { type: 'order_approved', orderId: resource.id, status: 'approved' };
    case 'PAYMENT.CAPTURE.COMPLETED':
      return { type: 'payment_completed', captureId: resource.id, orderId: resource.supplementary_data?.related_ids?.order_id };
    case 'PAYMENT.CAPTURE.DENIED':
      return { type: 'payment_denied', captureId: resource.id, reason: resource.status_details?.reason };
    case 'PAYMENT.CAPTURE.REFUNDED':
      return { type: 'payment_refunded', captureId: resource.id, refundId: resource.refund_ids?.[0] };
    default:
      return { type: 'unknown', event: eventType };
  }
}

// ============================================
// Exports
// ============================================

module.exports = {
  getPayPalAccessToken,
  createPayPalOrder,
  capturePayPalOrder,
  getPayPalOrderDetails,
  refundPayPalPayment,
  validateWebhookSignature,
  processWebhookEvent,
};
