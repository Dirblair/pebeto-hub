/**
 * Fee Service Middleware for Pebeto Creator's Hub
 * 
 * Attaches fee calculation functions to every request object.
 * This middleware imports the core fee calculation logic from services/feeService.js
 * and makes it available as req.feeService in all route handlers.
 * 
 * @module middleware/feeService
 */

const feeService = require('../services/feeService');

/**
 * Express middleware to attach fee helpers to req for route handlers
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
function attachFeeService(req, res, next) {
  // Make sure feeService exists and has all required functions
  if (!feeService) {
    console.error('❌ feeService not loaded correctly');
    return next(new Error('Fee service not available'));
  }

  req.feeService = {
    // Deposit calculations
    calculateDeposit: feeService.calculateDeposit,
    previewDeposit: feeService.previewDeposit,
    
    // Tip calculations
    calculateTip: feeService.calculateTip,
    previewTip: feeService.previewTip,
    
    // Withdrawal calculations
    calculateWithdrawal: feeService.calculateWithdrawal,
    previewWithdrawal: feeService.previewWithdrawal,
    validateMinimumWithdrawal: feeService.validateMinimumWithdrawal,
    validateWithdrawalRequest: feeService.validateWithdrawalRequest,
    
    // Currency conversion
    convertLocalToUsd: feeService.convertLocalToUsd,
    convertUsdToLocal: feeService.convertUsdToLocal,
    resolveWithdrawalAmountUsd: feeService.resolveWithdrawalAmountUsd,
    getExchangeRate: feeService.getExchangeRate,
    
    // Rounding utilities
    roundUsd: feeService.roundUsd,
    roundAmount: feeService.roundAmount,
    validateAmount: feeService.validateAmount,
    formatCurrency: feeService.formatCurrency,
    
    // Constants
    MIN_WITHDRAWAL_USD: feeService.MIN_WITHDRAWAL_USD,
    FEE_RATES: feeService.FEE_RATES
  };
  
  next();
}

// Export the middleware function directly (not as an object)
module.exports = attachFeeService;
