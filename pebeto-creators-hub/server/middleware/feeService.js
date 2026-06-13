/**
 * Fee Service Middleware for Pebeto Creator's Hub
 * 
 * Attaches fee calculation functions to every request object.
 * 
 * @module middleware/feeService
 */

const feeService = require('../services/feeService');

/**
 * Express middleware to attach fee helpers to req for route handlers
 */
function attachFeeService(req, res, next) {
  req.feeService = {
    calculateDeposit: feeService.calculateDeposit,
    previewDeposit: feeService.previewDeposit,
    calculateTip: feeService.calculateTip,
    previewTip: feeService.previewTip,
    calculateWithdrawal: feeService.calculateWithdrawal,
    previewWithdrawal: feeService.previewWithdrawal,
    validateMinimumWithdrawal: feeService.validateMinimumWithdrawal,
    validateWithdrawalRequest: feeService.validateWithdrawalRequest,
    convertLocalToUsd: feeService.convertLocalToUsd,
    convertUsdToLocal: feeService.convertUsdToLocal,
    resolveWithdrawalAmountUsd: feeService.resolveWithdrawalAmountUsd,
    getExchangeRate: feeService.getExchangeRate,
    roundUsd: feeService.roundUsd,
    roundAmount: feeService.roundAmount,
    validateAmount: feeService.validateAmount,
    formatCurrency: feeService.formatCurrency,
    MIN_WITHDRAWAL_USD: feeService.MIN_WITHDRAWAL_USD,
    FEE_RATES: feeService.FEE_RATES
  };
  next();
}

// Make sure this exports a function (not an object)
module.exports = attachFeeService;
