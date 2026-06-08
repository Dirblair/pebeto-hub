/**
 * Fee Calculation Service for Pebeto Creator's Hub
 * 
 * Handles all financial calculations including:
 * - Deposit fees (10% platform fee)
 * - Tip fees (5% platform fee, 95% to creator)
 * - Withdrawal fees (3% platform fee)
 * - Currency conversion
 * - Amount validation (positive numbers only)
 * 
 * @module services/feeService
 */

const { FEE_RATES, MIN_WITHDRAWAL_USD, BASE_CURRENCY } = require('../config/constants');
const { AppError } = require('../utils/errors');
const logger = require('../utils/logger');

// ============================================
// Currency Precision Mapping
// ============================================

const CURRENCY_PRECISION = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  KES: 2,      // Kenyan Shilling
  TZS: 2,      // Tanzanian Shilling
  UGX: 0,      // Ugandan Shilling (no decimals)
  JPY: 0,      // Japanese Yen
  INR: 2,
  NGN: 2,      // Nigerian Naira
  ZAR: 2,      // South African Rand
  GHS: 2,      // Ghanaian Cedi
};

// ============================================
// Core Rounding Functions
// ============================================

/**
 * Round amount to appropriate decimal places for a currency
 * @param {number} amount - Amount to round
 * @param {string} currency - Currency code (default: USD)
 * @returns {number} Rounded amount
 */
function roundAmount(amount, currency = BASE_CURRENCY) {
  const precision = CURRENCY_PRECISION[currency.toUpperCase()] ?? 2;
  const multiplier = Math.pow(10, precision);
  return Math.round(amount * multiplier) / multiplier;
}

/**
 * Round USD amount to 2 decimal places
 * @param {number} amount - Amount in USD
 * @returns {number} Rounded amount
 */
function roundUsd(amount) {
  return roundAmount(amount, 'USD');
}

/**
 * Validate amount is a positive number
 * @param {number} amount - Amount to validate
 * @param {string} type - Transaction type (deposit, tip, withdrawal)
 * @throws {AppError} If validation fails
 */
function validateAmount(amount, type) {
  const numAmount = typeof amount === 'number' ? amount : parseFloat(amount);
  
  if (isNaN(numAmount) || numAmount <= 0) {
    throw new AppError(`${type} amount must be a positive number`, 400);
  }
}

/**
 * Format currency for error messages
 * @param {number} amount - Amount to format
 * @param {string} currency - Currency code
 * @returns {string} Formatted currency string
 */
function formatCurrency(amount, currency = BASE_CURRENCY) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: CURRENCY_PRECISION[currency.toUpperCase()] ?? 2
  }).format(amount);
}

// ============================================
// Deposit Calculations
// ============================================

/**
 * Calculate deposit fees for campaign funding
 * Business pays intent + 10% fee
 * 
 * @param {number} intentUsd - Amount to credit to escrow in USD
 * @param {Object} options - Additional options (userId, campaignId)
 * @returns {Object} Deposit breakdown
 * @throws {AppError} If amount is invalid
 */
function calculateDeposit(intentUsd, options = {}) {
  validateAmount(intentUsd, 'Deposit');
  
  const intent = roundUsd(intentUsd);
  const feeUsd = roundUsd(intent * FEE_RATES.DEPOSIT);
  const totalChargeUsd = roundUsd(intent + feeUsd);
  
  const result = {
    intentUsd: intent,
    feeUsd,
    totalChargeUsd,
    escrowCreditUsd: intent,
    feeRate: FEE_RATES.DEPOSIT,
    feePercentage: (FEE_RATES.DEPOSIT * 100) + '%',
    feeSource: 'deposit',
    timestamp: new Date().toISOString()
  };
  
  // Add optional metadata
  if (options.userId) result.userId = options.userId;
  if (options.campaignId) result.campaignId = options.campaignId;
  
  logger.debug('Deposit calculation', result);
  return result;
}

/**
 * Preview deposit with detailed breakdown
 * @param {number} intentUsd - Intended escrow amount
 * @returns {Object} Detailed deposit preview
 */
function previewDeposit(intentUsd) {
  const calculation = calculateDeposit(intentUsd);
  return {
    ...calculation,
    breakdown: {
      escrowAmount: calculation.intentUsd,
      feeAmount: calculation.feeUsd,
      feeDescription: `${calculation.feePercentage} platform fee`,
      totalPayment: calculation.totalChargeUsd
    },
    message: `You will pay ${formatCurrency(calculation.totalChargeUsd)} to fund ${formatCurrency(calculation.intentUsd)} in escrow.`
  };
}

// ============================================
// Tip Calculations
// ============================================

/**
 * Calculate tip fees
 * Fan pays gross amount, creator receives 95%, platform fee 5%
 * 
 * @param {number} grossUsd - Gross tip amount in USD
 * @param {Object} options - Additional options (senderId, recipientId)
 * @returns {Object} Tip breakdown
 * @throws {AppError} If amount is invalid
 */
function calculateTip(grossUsd, options = {}) {
  validateAmount(grossUsd, 'Tip');
  
  const gross = roundUsd(grossUsd);
  const feeUsd = roundUsd(gross * FEE_RATES.TIP);
  const netToCreatorUsd = roundUsd(gross - feeUsd);
  
  const result = {
    grossUsd: gross,
    feeUsd,
    netToCreatorUsd,
    feeRate: FEE_RATES.TIP,
    feePercentage: (FEE_RATES.TIP * 100) + '%',
    feeSource: 'tip',
    creatorReceivesPercentage: ((1 - FEE_RATES.TIP) * 100) + '%',
    timestamp: new Date().toISOString()
  };
  
  if (options.senderId) result.senderId = options.senderId;
  if (options.recipientId) result.recipientId = options.recipientId;
  
  logger.debug('Tip calculation', result);
  return result;
}

/**
 * Preview tip with detailed breakdown
 * @param {number} grossUsd - Gross tip amount
 * @returns {Object} Detailed tip preview
 */
function previewTip(grossUsd) {
  const calculation = calculateTip(grossUsd);
  return {
    ...calculation,
    breakdown: {
      yourPayment: calculation.grossUsd,
      creatorReceives: calculation.netToCreatorUsd,
      platformFee: calculation.feeUsd,
      feeDescription: `${calculation.feePercentage} platform fee`
    },
    message: `${formatCurrency(calculation.netToCreatorUsd)} will be sent to the creator after ${calculation.feePercentage} fee.`
  };
}

// ============================================
// Withdrawal Calculations
// ============================================

/**
 * Calculate withdrawal fees
 * User receives gross - 3% fee (waived for admin)
 * 
 * @param {number} grossUsd - Gross withdrawal amount in USD
 * @param {string} role - User role ('admin', 'creator', 'business')
 * @param {Object} options - Additional options (payoutMethod)
 * @returns {Object} Withdrawal breakdown
 * @throws {AppError} If amount is invalid
 */
function calculateWithdrawal(grossUsd, role = 'creator', options = {}) {
  validateAmount(grossUsd, 'Withdrawal');
  
  const gross = roundUsd(grossUsd);
  
  // Admin withdrawals are fee-free
  if (role === 'admin') {
    const result = {
      grossUsd: gross,
      feeUsd: 0,
      netToUserUsd: gross,
      feeRate: 0,
      feePercentage: '0%',
      feeSource: null,
      adminExempt: true,
      timestamp: new Date().toISOString()
    };
    
    if (options.payoutMethod) result.payoutMethod = options.payoutMethod;
    return result;
  }
  
  const feeUsd = roundUsd(gross * FEE_RATES.WITHDRAWAL);
  const netToUserUsd = roundUsd(gross - feeUsd);
  
  const result = {
    grossUsd: gross,
    feeUsd,
    netToUserUsd,
    feeRate: FEE_RATES.WITHDRAWAL,
    feePercentage: (FEE_RATES.WITHDRAWAL * 100) + '%',
    feeSource: 'withdrawal',
    adminExempt: false,
    timestamp: new Date().toISOString()
  };
  
  if (options.payoutMethod) result.payoutMethod = options.payoutMethod;
  
  logger.debug('Withdrawal calculation', result);
  return result;
}

/**
 * Preview withdrawal with detailed breakdown
 * @param {number} grossUsd - Gross withdrawal amount
 * @param {string} role - User role
 * @returns {Object} Detailed withdrawal preview
 */
function previewWithdrawal(grossUsd, role = 'creator') {
  const calculation = calculateWithdrawal(grossUsd, role);
  return {
    ...calculation,
    breakdown: {
      requestedAmount: calculation.grossUsd,
      youReceive: calculation.netToUserUsd,
      platformFee: calculation.feeUsd,
      feeDescription: calculation.adminExempt 
        ? 'Admin fee waived' 
        : `${calculation.feePercentage} withdrawal fee`
    },
    message: calculation.adminExempt
      ? `You will receive the full ${formatCurrency(calculation.netToUserUsd)} (admin fee waived).`
      : `You will receive ${formatCurrency(calculation.netToUserUsd)} after ${calculation.feePercentage} fee.`
  };
}

/**
 * Validate withdrawal meets minimum requirement
 * @param {number} grossUsd - Gross withdrawal amount in USD
 * @param {string} role - User role
 * @throws {AppError} If withdrawal doesn't meet minimum
 */
function validateMinimumWithdrawal(grossUsd, role = 'creator') {
  if (role === 'admin') return;
  
  const gross = roundUsd(grossUsd);
  if (gross < MIN_WITHDRAWAL_USD) {
    throw new AppError(
      `Minimum withdrawal is ${formatCurrency(MIN_WITHDRAWAL_USD)}. You requested ${formatCurrency(gross)}.`,
      400,
      'MIN_WITHDRAWAL_NOT_MET'
    );
  }
}

// ============================================
// Currency Conversion
// ============================================

/**
 * Convert local currency amount to USD using exchange rate
 * 
 * @param {number} localAmount - Amount in local currency
 * @param {string} currency - Currency code (KES, EUR, GBP, etc.)
 * @param {Object} rates - Exchange rate object { USD: 1, KES: 130, ... }
 * @returns {number} Amount in USD (rounded)
 * @throws {AppError} If rate is unavailable
 */
function convertLocalToUsd(localAmount, currency, rates = {}) {
  const local = typeof localAmount === 'number' ? localAmount : parseFloat(localAmount);
  
  if (isNaN(local) || local <= 0) {
    throw new AppError('Local amount must be a positive number', 400);
  }
  
  if (!currency || currency.toUpperCase() === BASE_CURRENCY) {
    return roundUsd(local);
  }
  
  const rate = rates[currency.toUpperCase()];
  if (!rate || rate <= 0) {
    throw new AppError(`Exchange rate unavailable for ${currency}. Please try again later.`, 400);
  }
  
  return roundUsd(local / rate);
}

/**
 * Convert USD to local currency
 * @param {number} usdAmount - Amount in USD
 * @param {string} currency - Target currency code
 * @param {Object} rates - Exchange rate object
 * @returns {number} Amount in local currency
 */
function convertUsdToLocal(usdAmount, currency, rates = {}) {
  const usd = typeof usdAmount === 'number' ? usdAmount : parseFloat(usdAmount);
  
  if (isNaN(usd) || usd <= 0) {
    throw new AppError('USD amount must be a positive number', 400);
  }
  
  if (!currency || currency.toUpperCase() === BASE_CURRENCY) {
    return roundAmount(usd, currency);
  }
  
  const rate = rates[currency.toUpperCase()];
  if (!rate || rate <= 0) {
    throw new AppError(`Exchange rate unavailable for ${currency}`, 400);
  }
  
  return roundAmount(usd * rate, currency);
}

/**
 * Resolve withdrawal amount to USD from either amountUsd or amountLocal + currency
 * 
 * @param {Object} params - Withdrawal parameters
 * @param {number} params.amountUsd - Amount in USD (optional)
 * @param {number} params.amountLocal - Amount in local currency (optional)
 * @param {string} params.currency - Currency code for local amount
 * @param {Object} rates - Exchange rate object
 * @returns {number} Amount in USD
 * @throws {AppError} If neither amountUsd nor amountLocal+currency provided
 */
function resolveWithdrawalAmountUsd({ amountUsd, amountLocal, currency }, rates = {}) {
  if (amountUsd != null && amountUsd !== '') {
    const usdAmount = roundUsd(Number(amountUsd));
    validateAmount(usdAmount, 'Withdrawal');
    return usdAmount;
  }
  
  if (amountLocal != null && amountLocal !== '' && currency) {
    return convertLocalToUsd(amountLocal, currency, rates);
  }
  
  throw new AppError('Provide amountUsd or amountLocal with currency', 400);
}

/**
 * Get exchange rate for a currency
 * @param {string} currency - Currency code
 * @param {Object} rates - Exchange rate object
 * @returns {number} Exchange rate
 */
function getExchangeRate(currency, rates = {}) {
  if (!currency || currency.toUpperCase() === BASE_CURRENCY) return 1;
  const rate = rates[currency.toUpperCase()];
  if (!rate) {
    throw new AppError(`Exchange rate unavailable for ${currency}`, 400);
  }
  return rate;
}

// ============================================
// Withdrawal Request Validation
// ============================================

/**
 * Full withdrawal validation: USD threshold + fee preview (multi-currency safe)
 * 
 * @param {Object} params - Withdrawal request parameters
 * @param {number} params.amountUsd - Amount in USD (optional)
 * @param {number} params.amountLocal - Amount in local currency (optional)
 * @param {string} params.currency - Currency code
 * @param {string} params.role - User role
 * @param {Object} rates - Exchange rate object
 * @returns {Object} Validated withdrawal breakdown
 * @throws {AppError} If validation fails
 */
function validateWithdrawalRequest({ amountUsd, amountLocal, currency, role }, rates = {}) {
  const grossUsd = resolveWithdrawalAmountUsd({ amountUsd, amountLocal, currency }, rates);
  validateMinimumWithdrawal(grossUsd, role);
  const feeBreakdown = calculateWithdrawal(grossUsd, role);
  
  const exchangeRateUsed = currency && rates[currency.toUpperCase()] 
    ? rates[currency.toUpperCase()] 
    : 1;
  
  return {
    grossUsd,
    ...feeBreakdown,
    displayCurrency: currency || BASE_CURRENCY,
    displayAmount: amountLocal != null ? Number(amountLocal) : grossUsd,
    exchangeRateUsed,
    exchangeRateSource: rates._source || 'cache',
    isValid: true
  };
}

// ============================================
// Express Middleware
// ============================================

/**
 * Express middleware: attach fee helpers to req for route handlers
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
function attachFeeService(req, res, next) {
  req.feeService = {
    calculateDeposit,
    previewDeposit,
    calculateTip,
    previewTip,
    calculateWithdrawal,
    previewWithdrawal,
    validateMinimumWithdrawal,
    validateWithdrawalRequest,
    convertLocalToUsd,
    convertUsdToLocal,
    resolveWithdrawalAmountUsd,
    getExchangeRate,
    roundUsd,
    roundAmount,
    validateAmount,
    formatCurrency,
    MIN_WITHDRAWAL_USD,
    FEE_RATES
  };
  next();
}

// ============================================
// Exports
// ============================================

module.exports = {
  // Core functions
  calculateDeposit,
  previewDeposit,
  calculateTip,
  previewTip,
  calculateWithdrawal,
  previewWithdrawal,
  validateMinimumWithdrawal,
  validateWithdrawalRequest,
  
  // Currency conversion
  convertLocalToUsd,
  convertUsdToLocal,
  resolveWithdrawalAmountUsd,
  getExchangeRate,
  
  // Rounding utilities
  roundUsd,
  roundAmount,
  validateAmount,
  formatCurrency,
  
  // Constants
  MIN_WITHDRAWAL_USD,
  FEE_RATES,
  
  // Middleware
  attachFeeService,
  
  // Currency precision
  CURRENCY_PRECISION
};
