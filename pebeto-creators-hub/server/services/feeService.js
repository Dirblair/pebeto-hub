/**
 * Fee Calculation Service for Pebeto Creator's Hub
 * 
 * Handles all financial calculations including:
 * - Deposit fees (10% platform fee) - WAIVED FOR ADMIN
 * - Tip fees (5% platform fee, 95% to creator)
 * - Withdrawal fees (3% platform fee) - WAIVED FOR ADMIN
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
  KES: 2,
  TZS: 2,
  UGX: 0,
  JPY: 0,
  INR: 2,
  NGN: 2,
  ZAR: 2,
  GHS: 2,
};

// ============================================
// Core Rounding Functions
// ============================================

function roundAmount(amount, currency = BASE_CURRENCY) {
  const precision = CURRENCY_PRECISION[currency.toUpperCase()] ?? 2;
  const multiplier = Math.pow(10, precision);
  return Math.round(amount * multiplier) / multiplier;
}

function roundUsd(amount) {
  return roundAmount(amount, 'USD');
}

function validateAmount(amount, type) {
  const numAmount = typeof amount === 'number' ? amount : parseFloat(amount);
  
  if (isNaN(numAmount) || numAmount <= 0) {
    throw new AppError(`${type} amount must be a positive number`, 400);
  }
}

function formatCurrency(amount, currency = BASE_CURRENCY) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: CURRENCY_PRECISION[currency.toUpperCase()] ?? 2
  }).format(amount);
}

// ============================================
// Deposit Calculations (FIXED - Admin fee waiver)
// ============================================

function calculateDeposit(intentUsd, options = {}) {
  validateAmount(intentUsd, 'Deposit');
  
  const intent = roundUsd(intentUsd);
  const isAdmin = options.isAdmin || false;
  
  // Admin gets NO fee
  const feeUsd = isAdmin ? 0 : roundUsd(intent * FEE_RATES.DEPOSIT);
  const totalChargeUsd = roundUsd(intent + feeUsd);
  
  const result = {
    intentUsd: intent,
    feeUsd,
    totalChargeUsd,
    escrowCreditUsd: intent,
    feeRate: isAdmin ? 0 : FEE_RATES.DEPOSIT,
    feePercentage: isAdmin ? '0% (Admin - No Fee)' : (FEE_RATES.DEPOSIT * 100) + '%',
    feeSource: 'deposit',
    feeWaived: isAdmin,
    timestamp: new Date().toISOString()
  };
  
  if (options.userId) result.userId = options.userId;
  if (options.campaignId) result.campaignId = options.campaignId;
  
  logger.debug('Deposit calculation', result);
  return result;
}

function previewDeposit(intentUsd, isAdmin = false) {
  const calculation = calculateDeposit(intentUsd, { isAdmin });
  return {
    ...calculation,
    breakdown: {
      escrowAmount: calculation.intentUsd,
      feeAmount: calculation.feeUsd,
      feeDescription: isAdmin ? '✅ No fee (admin benefit)' : `${calculation.feePercentage} platform fee`,
      totalPayment: calculation.totalChargeUsd
    },
    message: isAdmin 
      ? `You will pay ${formatCurrency(calculation.totalChargeUsd)} with NO fee (admin benefit).`
      : `You will pay ${formatCurrency(calculation.totalChargeUsd)} to fund ${formatCurrency(calculation.intentUsd)} in escrow.`
  };
}

// ============================================
// Tip Calculations
// ============================================

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

function calculateWithdrawal(grossUsd, role = 'creator', options = {}) {
  validateAmount(grossUsd, 'Withdrawal');
  
  const gross = roundUsd(grossUsd);
  
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
  FEE_RATES,
  attachFeeService,
  CURRENCY_PRECISION
};
