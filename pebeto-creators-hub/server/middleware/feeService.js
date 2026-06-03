const { FEE_RATES, MIN_WITHDRAWAL_USD, BASE_CURRENCY } = require('../config/constants');
const { AppError } = require('../utils/errors');

function roundUsd(amount) {
  return Math.round(amount * 100) / 100;
}

/**
 * Deposit: Business funds escrow with intent X (USD).
 * User pays X + 10% fee. X credits escrow; fee goes to Admin Profit Wallet.
 */
function calculateDeposit(intentUsd) {
  if (typeof intentUsd !== 'number' || intentUsd <= 0) {
    throw new AppError('Deposit amount must be a positive number', 400);
  }
  const intent = roundUsd(intentUsd);
  const feeUsd = roundUsd(intent * FEE_RATES.DEPOSIT);
  const totalChargeUsd = roundUsd(intent + feeUsd);
  return {
    intentUsd: intent,
    feeUsd,
    totalChargeUsd,
    escrowCreditUsd: intent,
    feeRate: FEE_RATES.DEPOSIT,
    feeSource: 'deposit',
  };
}

/**
 * Tip: Fan tips X (USD). Creator receives 95%; platform fee 5% to Admin.
 */
function calculateTip(grossUsd) {
  if (typeof grossUsd !== 'number' || grossUsd <= 0) {
    throw new AppError('Tip amount must be a positive number', 400);
  }
  const gross = roundUsd(grossUsd);
  const feeUsd = roundUsd(gross * FEE_RATES.TIP);
  const netToCreatorUsd = roundUsd(gross - feeUsd);
  return {
    grossUsd: gross,
    feeUsd,
    netToCreatorUsd,
    feeRate: FEE_RATES.TIP,
    feeSource: 'tip',
  };
}

/**
 * Withdrawal: User withdraws gross X (USD).
 * User receives 97%; platform fee 3% to Admin (waived for admin role).
 */
function calculateWithdrawal(grossUsd, role = 'creator') {
  if (typeof grossUsd !== 'number' || grossUsd <= 0) {
    throw new AppError('Withdrawal amount must be a positive number', 400);
  }
  const gross = roundUsd(grossUsd);
  if (role === 'admin') {
    return {
      grossUsd: gross,
      feeUsd: 0,
      netToUserUsd: gross,
      feeRate: 0,
      feeSource: null,
      adminExempt: true,
    };
  }
  const feeUsd = roundUsd(gross * FEE_RATES.WITHDRAWAL);
  const netToUserUsd = roundUsd(gross - feeUsd);
  return {
    grossUsd: gross,
    feeUsd,
    netToUserUsd,
    feeRate: FEE_RATES.WITHDRAWAL,
    feeSource: 'withdrawal',
    adminExempt: false,
  };
}

/**
 * Minimum withdrawal: $30 USD for creator/business; no minimum for admin.
 */
function validateMinimumWithdrawal(grossUsd, role = 'creator') {
  if (role === 'admin') return;
  const gross = roundUsd(grossUsd);
  if (gross < MIN_WITHDRAWAL_USD) {
    throw new AppError(
      `Minimum withdrawal is $${MIN_WITHDRAWAL_USD} ${BASE_CURRENCY}. You requested $${gross}.`,
      400
    );
  }
}

/**
 * Convert local currency amount to USD using rate (1 USD = rate units of local currency).
 * Example: KES 3900 with rate 130 → 3900/130 = 30 USD
 */
function convertLocalToUsd(localAmount, currency, rates = {}) {
  if (!currency || currency.toUpperCase() === BASE_CURRENCY) {
    return roundUsd(Number(localAmount));
  }
  const rate = rates[currency.toUpperCase()];
  if (!rate || rate <= 0) {
    throw new AppError(`Exchange rate unavailable for ${currency}`, 400);
  }
  return roundUsd(Number(localAmount) / rate);
}

/**
 * Resolve withdrawal amount to USD from either amountUsd or amountLocal + currency.
 */
function resolveWithdrawalAmountUsd({ amountUsd, amountLocal, currency }, rates = {}) {
  if (amountUsd != null && amountUsd !== '') {
    return roundUsd(Number(amountUsd));
  }
  if (amountLocal != null && amountLocal !== '' && currency) {
    return convertLocalToUsd(amountLocal, currency, rates);
  }
  throw new AppError('Provide amountUsd or amountLocal with currency', 400);
}

/**
 * Full withdrawal validation: USD threshold + fee preview (multi-currency safe).
 */
function validateWithdrawalRequest({ amountUsd, amountLocal, currency, role }, rates = {}) {
  const grossUsd = resolveWithdrawalAmountUsd({ amountUsd, amountLocal, currency }, rates);
  validateMinimumWithdrawal(grossUsd, role);
  const feeBreakdown = calculateWithdrawal(grossUsd, role);
  return {
    grossUsd,
    ...feeBreakdown,
    displayCurrency: currency || BASE_CURRENCY,
    displayAmount: amountLocal != null ? Number(amountLocal) : grossUsd,
    exchangeRateUsed: currency && rates[currency.toUpperCase()] ? rates[currency.toUpperCase()] : 1,
  };
}

/**
 * Express middleware: attach fee helpers to req for route handlers.
 */
function attachFeeService(req, _res, next) {
  req.feeService = {
    calculateDeposit,
    calculateTip,
    calculateWithdrawal,
    validateMinimumWithdrawal,
    validateWithdrawalRequest,
    convertLocalToUsd,
    resolveWithdrawalAmountUsd,
    roundUsd,
    MIN_WITHDRAWAL_USD,
    FEE_RATES,
  };
  next();
}

module.exports = {
  calculateDeposit,
  calculateTip,
  calculateWithdrawal,
  validateMinimumWithdrawal,
  validateWithdrawalRequest,
  convertLocalToUsd,
  resolveWithdrawalAmountUsd,
  attachFeeService,
  roundUsd,
  MIN_WITHDRAWAL_USD,
  FEE_RATES,
};
