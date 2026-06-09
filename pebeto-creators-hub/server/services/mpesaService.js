/**
 * M-Pesa Service for Pebeto Creator's Hub
 * 
 * Handles M-Pesa integrations including:
 * - STK Push (Lipa Na M-Pesa Online) for deposits
 * - B2C (Business to Customer) for withdrawals
 * - Access token management with caching
 * 
 * @module services/mpesaService
 */

const axios = require('axios');
const crypto = require('crypto');
const env = require('../config/env');
const logger = require('../utils/logger');
const { AppError } = require('../utils/errors');

// ============================================
// Constants
// ============================================

const TOKEN_CACHE_TTL = 55 * 60 * 1000; // 55 minutes (tokens expire in 60)
let cachedToken = null;
let tokenExpiry = null;

const B2C_COMMAND_IDS = {
  SALARY_PAYMENT: 'SalaryPayment',
  BUSINESS_PAYMENT: 'BusinessPayment',
  PROMOTION_PAYMENT: 'PromotionPayment',
};

const STK_TRANSACTION_TYPES = {
  CUSTOMER_PAY_BILL: 'CustomerPayBillOnline',
  CUSTOMER_BUY_GOODS: 'CustomerBuyGoodsOnline',
};

const RESULT_CODES = {
  SUCCESS: 0,
  INSUFFICIENT_FUNDS: 1,
  INVALID_ACCOUNT: 2,
  PROCESSING_ERROR: 3,
  TIMEOUT: 4,
  CANCELLED: 1001,
  USER_NOT_FOUND: 1005,
};

// ============================================
// Helper Functions
// ============================================

/**
 * Format phone number to international format (254XXXXXXXXX)
 * @param {string} phoneNumber - Raw phone number
 * @returns {string} Formatted phone number
 */
function formatPhoneNumber(phoneNumber) {
  if (!phoneNumber) return null;
  let cleaned = phoneNumber.replace(/\D/g, '');
  if (cleaned.startsWith('0')) {
    cleaned = '254' + cleaned.substring(1);
  } else if (cleaned.startsWith('+254')) {
    cleaned = cleaned.substring(1);
  }
  return cleaned;
}

/**
 * Validate phone number format
 * @param {string} phoneNumber - Phone number to validate
 * @returns {boolean}
 */
function validatePhoneNumber(phoneNumber) {
  const formatted = formatPhoneNumber(phoneNumber);
  if (!formatted) return false;
  return /^254[7-9][0-9]{8}$/.test(formatted);
}

/**
 * Generate STK push timestamp and password
 * @returns {Object} { timestamp, password }
 */
function generateStkCredentials() {
  const timestamp = new Date()
    .toISOString()
    .replace(/[^0-9]/g, '')
    .slice(0, 14);
  const password = Buffer.from(
    `${env.mpesa.shortCode || env.mpesaShortCode}${env.mpesa.passkey || env.mpesaPasskey}${timestamp}`
  ).toString('base64');
  return { timestamp, password };
}

/**
 * Format amount to integer (remove decimals)
 * @param {number} amount - Amount to format
 * @returns {number} Formatted amount
 */
function formatAmount(amount) {
  return Math.round(amount);
}

/**
 * Generate a unique transaction reference
 * @param {string} prefix - Optional prefix
 * @returns {string} Unique reference
 */
function generateReference(prefix = 'PBT') {
  const timestamp = Date.now().toString(36);
  const random = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `${prefix}${timestamp}${random}`.slice(0, 20);
}

/**
 * Map M-Pesa result code to user-friendly message
 * @param {number} resultCode - M-Pesa result code
 * @returns {string} User-friendly message
 */
function getResultMessage(resultCode) {
  const messages = {
    [RESULT_CODES.SUCCESS]: 'Payment completed successfully',
    [RESULT_CODES.INSUFFICIENT_FUNDS]: 'Insufficient funds in the business account',
    [RESULT_CODES.INVALID_ACCOUNT]: 'Invalid account or paybill number',
    [RESULT_CODES.PROCESSING_ERROR]: 'Payment processing error occurred',
    [RESULT_CODES.TIMEOUT]: 'Payment request timed out',
    [RESULT_CODES.CANCELLED]: 'Transaction was cancelled by the user',
    [RESULT_CODES.USER_NOT_FOUND]: 'User not found on M-Pesa network',
  };
  return messages[resultCode] || `Unknown error (Code: ${resultCode})`;
}

// ============================================
// Token Management
// ============================================

/**
 * Get M-Pesa access token (with caching)
 * @param {boolean} forceRefresh - Force refresh the token
 * @returns {Promise<string>} Access token
 */
async function getMpesaAccessToken(forceRefresh = false) {
  // Check if cached token is still valid
  if (!forceRefresh && cachedToken && tokenExpiry && Date.now() < tokenExpiry) {
    logger.debug('Using cached M-Pesa access token');
    return cachedToken;
  }

  try {
    const consumerKey = env.mpesa.consumerKey || env.mpesaConsumerKey;
    const consumerSecret = env.mpesa.consumerSecret || env.mpesaConsumerSecret;
    const apiUrl = env.mpesa.apiUrl || env.mpesaApiUrl;

    if (!consumerKey || !consumerSecret) {
      throw new AppError('M-Pesa credentials not configured', 500);
    }

    const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
    
    logger.debug('Requesting new M-Pesa access token');
    
    const response = await axios.get(
      `${apiUrl}/oauth/v1/generate?grant_type=client_credentials`,
      {
        headers: { Authorization: `Basic ${auth}` },
        timeout: 30000,
      }
    );

    if (!response.data || !response.data.access_token) {
      throw new Error('Invalid response from M-Pesa token endpoint');
    }

    cachedToken = response.data.access_token;
    tokenExpiry = Date.now() + TOKEN_CACHE_TTL;
    
    logger.info('M-Pesa access token obtained successfully');
    
    return cachedToken;
  } catch (error) {
    logger.error('Failed to get M-Pesa access token', {
      error: error.message,
      status: error.response?.status,
      data: error.response?.data,
    });
    
    if (error.response?.data?.errorCode) {
      throw new AppError(`M-Pesa auth error: ${error.response.data.errorMessage || 'Authentication failed'}`, 500);
    }
    throw new AppError('Failed to authenticate with M-Pesa. Please try again later.', 500);
  }
}

/**
 * Invalidate cached token (useful for testing)
 */
function invalidateToken() {
  cachedToken = null;
  tokenExpiry = null;
  logger.debug('M-Pesa token cache invalidated');
}

// ============================================
// STK Push (Lipa Na M-Pesa Online)
// ============================================

/**
 * Initiate STK Push for customer payment
 * @param {Object} params - Payment parameters
 * @param {number} params.amount - Amount in KES
 * @param {string} params.phoneNumber - Customer phone number
 * @param {string} params.accountReference - Account reference (order ID)
 * @param {string} params.transactionDesc - Transaction description
 * @returns {Promise<Object>} STK push response
 */
async function initiateSTKPush({ amount, phoneNumber, accountReference, transactionDesc }) {
  // Validate inputs
  if (!amount || amount <= 0) {
    throw new AppError('Amount is required and must be positive', 400);
  }
  
  if (!phoneNumber) {
    throw new AppError('Phone number is required', 400);
  }
  
  const formattedPhone = formatPhoneNumber(phoneNumber);
  if (!validatePhoneNumber(formattedPhone)) {
    throw new AppError('Invalid phone number format. Use 07XX XXX XXX or 2547XX XXX XXX', 400);
  }
  
  const shortCode = env.mpesa.shortCode || env.mpesaShortCode;
  const callbackUrl = env.mpesa.callbackUrl || env.mpesaCallbackUrl;
  
  if (!shortCode) {
    throw new AppError('M-Pesa short code not configured', 500);
  }
  
  if (!callbackUrl) {
    throw new AppError('M-Pesa callback URL not configured', 500);
  }
  
  try {
    const token = await getMpesaAccessToken();
    const { timestamp, password } = generateStkCredentials();
    const apiUrl = env.mpesa.apiUrl || env.mpesaApiUrl;
    const formattedAmount = formatAmount(amount);
    const reference = accountReference || generateReference('STK');
    
    const payload = {
      BusinessShortCode: shortCode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: STK_TRANSACTION_TYPES.CUSTOMER_PAY_BILL,
      Amount: formattedAmount,
      PartyA: formattedPhone,
      PartyB: shortCode,
      PhoneNumber: formattedPhone,
      CallBackURL: callbackUrl,
      AccountReference: reference,
      TransactionDesc: transactionDesc || 'Pebeto Payment',
    };
    
    logger.info('Initiating STK Push', {
      phoneNumber: formattedPhone.slice(-6), // Log only last 6 digits
      amount: formattedAmount,
      reference,
    });
    
    const response = await axios.post(
      `${apiUrl}/mpesa/stkpush/v1/processrequest`,
      payload,
      {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 30000,
      }
    );
    
    if (!response.data || response.data.ResponseCode !== '0') {
      const errorMsg = response.data?.ResponseDescription || 'STK push initiation failed';
      logger.error('STK push failed', { response: response.data });
      throw new AppError(`M-Pesa: ${errorMsg}`, 400);
    }
    
    logger.info('STK Push initiated successfully', {
      checkoutRequestId: response.data.CheckoutRequestID,
      responseCode: response.data.ResponseCode,
    });
    
    return {
      success: true,
      checkoutRequestId: response.data.CheckoutRequestID,
      responseCode: response.data.ResponseCode,
      responseDescription: response.data.ResponseDescription,
      merchantRequestId: response.data.MerchantRequestID,
      reference,
    };
    
  } catch (error) {
    logger.error('STK Push failed', {
      error: error.message,
      phoneNumber: phoneNumber?.slice(-6),
      amount,
    });
    
    if (error instanceof AppError) throw error;
    
    if (error.response?.data) {
      throw new AppError(`M-Pesa error: ${error.response.data.ResponseDescription || 'Payment initiation failed'}`, 400);
    }
    throw new AppError('Failed to initiate M-Pesa payment. Please try again.', 500);
  }
}

/**
 * Query STK push status
 * @param {string} checkoutRequestId - Checkout request ID from STK push
 * @returns {Promise<Object>} Transaction status
 */
async function querySTKStatus(checkoutRequestId) {
  if (!checkoutRequestId) {
    throw new AppError('Checkout request ID is required', 400);
  }
  
  try {
    const token = await getMpesaAccessToken();
    const shortCode = env.mpesa.shortCode || env.mpesaShortCode;
    const { timestamp, password } = generateStkCredentials();
    const apiUrl = env.mpesa.apiUrl || env.mpesaApiUrl;
    
    const payload = {
      BusinessShortCode: shortCode,
      Password: password,
      Timestamp: timestamp,
      CheckoutRequestID: checkoutRequestId,
    };
    
    logger.debug('Querying STK status', { checkoutRequestId });
    
    const response = await axios.post(
      `${apiUrl}/mpesa/stkpushquery/v1/query`,
      payload,
      {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 30000,
      }
    );
    
    return {
      resultCode: response.data.ResultCode,
      resultDesc: response.data.ResultDesc,
      status: response.data.ResultCode === '0' ? 'completed' : 'failed',
    };
    
  } catch (error) {
    logger.error('STK status query failed', {
      checkoutRequestId,
      error: error.message,
    });
    throw new AppError('Failed to query payment status', 500);
  }
}

// ============================================
// B2C (Business to Customer)
// ============================================

/**
 * Send B2C payment to customer
 * @param {Object} params - Payment parameters
 * @param {string} params.phoneNumber - Recipient phone number
 * @param {number} params.amount - Amount in KES
 * @param {string} params.commandId - B2C command ID (default: BusinessPayment)
 * @param {string} params.remarks - Payment remarks
 * @returns {Promise<Object>} B2C response
 */
async function sendMpesaB2C({ phoneNumber, amount, commandId = B2C_COMMAND_IDS.BUSINESS_PAYMENT, remarks = 'Pebeto Withdrawal' }) {
  // Validate inputs
  if (!amount || amount <= 0) {
    throw new AppError('Amount is required and must be positive', 400);
  }
  
  if (!phoneNumber) {
    throw new AppError('Phone number is required', 400);
  }
  
  const formattedPhone = formatPhoneNumber(phoneNumber);
  if (!validatePhoneNumber(formattedPhone)) {
    throw new AppError('Invalid phone number format. Use 07XX XXX XXX or 2547XX XXX XXX', 400);
  }
  
  const initiatorName = env.mpesa.initiatorName || env.mpesaInitiatorName;
  const securityCredential = env.mpesa.password || env.mpesaPassword;
  const shortCode = env.mpesa.shortCode || env.mpesaShortCode;
  const queueTimeoutUrl = env.mpesa.queueTimeoutUrl || env.mpesaQueueTimeoutUrl;
  const resultUrl = env.mpesa.resultUrl || env.mpesaResultUrl;
  
  if (!initiatorName || !securityCredential) {
    throw new AppError('M-Pesa B2C credentials not configured', 500);
  }
  
  try {
    const token = await getMpesaAccessToken();
    const apiUrl = env.mpesa.apiUrl || env.mpesaApiUrl;
    const formattedAmount = formatAmount(amount);
    const conversationId = generateReference('B2C');
    
    const payload = {
      InitiatorName: initiatorName,
      SecurityCredential: securityCredential,
      CommandID: commandId,
      Amount: formattedAmount,
      PartyA: shortCode,
      PartyB: formattedPhone,
      Remarks: remarks,
      QueueTimeOutURL: queueTimeoutUrl,
      ResultURL: resultUrl,
      Occasion: 'Payment',
    };
    
    logger.info('Initiating B2C payment', {
      phoneNumber: formattedPhone.slice(-6),
      amount: formattedAmount,
      conversationId,
      commandId,
    });
    
    const response = await axios.post(
      `${apiUrl}/mpesa/b2c/v1/paymentrequest`,
      payload,
      {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 60000, // B2C can take longer
      }
    );
    
    if (response.data.ResultCode && response.data.ResultCode !== 0) {
      const errorMsg = getResultMessage(response.data.ResultCode);
      logger.error('B2C payment failed', {
        resultCode: response.data.ResultCode,
        resultDesc: response.data.ResultDesc,
      });
      throw new AppError(`M-Pesa B2C failed: ${errorMsg}`, 400);
    }
    
    logger.info('B2C payment initiated successfully', {
      conversationId: response.data.ConversationID,
      originatorConversationId: response.data.OriginatorConversationID,
    });
    
    return {
      success: true,
      conversationId: response.data.ConversationID,
      originatorConversationId: response.data.OriginatorConversationID,
      responseCode: response.data.ResponseCode,
      responseDescription: response.data.ResponseDescription,
    };
    
  } catch (error) {
    logger.error('B2C payment failed', {
      error: error.message,
      phoneNumber: phoneNumber?.slice(-6),
      amount,
    });
    
    if (error instanceof AppError) throw error;
    
    if (error.response?.data) {
      throw new AppError(`M-Pesa B2C error: ${error.response.data.errorMessage || 'Payment failed'}`, 400);
    }
    throw new AppError('Failed to process M-Pesa withdrawal. Please try again.', 500);
  }
}

/**
 * Process B2C result callback (to be called from webhook)
 * @param {Object} callbackData - B2C callback data
 * @returns {Object} Processed result
 */
function processB2CCallback(callbackData) {
  const result = callbackData.Result;
  
  if (!result) {
    logger.warn('Invalid B2C callback received', { callbackData });
    return { success: false, message: 'Invalid callback data' };
  }
  
  const isSuccessful = result.ResultCode === 0;
  const message = getResultMessage(result.ResultCode);
  
  logger.info('B2C callback processed', {
    conversationId: result.ConversationID,
    resultCode: result.ResultCode,
    resultDesc: result.ResultDesc,
    success: isSuccessful,
  });
  
  return {
    success: isSuccessful,
    resultCode: result.ResultCode,
    resultDesc: result.ResultDesc,
    message,
    transactionId: result.TransactionID,
    conversationId: result.ConversationID,
    originatorConversationId: result.OriginatorConversationID,
  };
}

// ============================================
// STK Push Callback Processing
// ============================================

/**
 * Process STK push callback (to be called from webhook)
 * @param {Object} callbackData - STK callback data
 * @returns {Object} Processed result
 */
function processSTKCallback(callbackData) {
  const stkCallback = callbackData.Body?.stkCallback;
  
  if (!stkCallback) {
    logger.warn('Invalid STK callback received', { callbackData });
    return { success: false, message: 'Invalid callback data' };
  }
  
  const isSuccessful = stkCallback.ResultCode === RESULT_CODES.SUCCESS;
  const message = getResultMessage(stkCallback.ResultCode);
  
  // Extract metadata if successful
  let metadata = {};
  if (isSuccessful && stkCallback.CallbackMetadata) {
    const items = stkCallback.CallbackMetadata.Item;
    metadata = {
      amount: items.find(i => i.Name === 'Amount')?.Value,
      mpesaReceiptNumber: items.find(i => i.Name === 'MpesaReceiptNumber')?.Value,
      transactionDate: items.find(i => i.Name === 'TransactionDate')?.Value,
      phoneNumber: items.find(i => i.Name === 'PhoneNumber')?.Value,
    };
  }
  
  logger.info('STK callback processed', {
    checkoutRequestId: stkCallback.CheckoutRequestID,
    resultCode: stkCallback.ResultCode,
    resultDesc: stkCallback.ResultDesc,
    success: isSuccessful,
    receiptNumber: metadata.mpesaReceiptNumber,
  });
  
  return {
    success: isSuccessful,
    resultCode: stkCallback.ResultCode,
    resultDesc: stkCallback.ResultDesc,
    message,
    checkoutRequestId: stkCallback.CheckoutRequestID,
    metadata,
  };
}

// ============================================
// Exports
// ============================================

module.exports = {
  // Token management
  getMpesaAccessToken,
  invalidateToken,
  
  // STK Push
  initiateSTKPush,
  querySTKStatus,
  processSTKCallback,
  
  // B2C
  sendMpesaB2C,
  processB2CCallback,
  
  // Utilities
  formatPhoneNumber,
  validatePhoneNumber,
  generateReference,
  getResultMessage,
  
  // Constants
  B2C_COMMAND_IDS,
  STK_TRANSACTION_TYPES,
  RESULT_CODES,
};
