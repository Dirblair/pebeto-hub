/**
 * Validation Middleware for Pebeto Creator's Hub
 * 
 * Provides centralized validation functions for common data types:
 * - Email validation
 * - Phone number validation (Kenyan format)
 * - Password strength validation
 * - Amount validation
 * - URL validation
 * - MongoDB ObjectId validation
 * 
 * @module middleware/validation
 */

const { body, param, query, validationResult } = require('express-validator');

// ============================================
// Validation Rules
// ============================================

/**
 * Email validation rule
 */
const validateEmail = () => 
  body('email')
    .isEmail()
    .withMessage('Please provide a valid email address')
    .normalizeEmail()
    .trim();

/**
 * Password validation rule (min 8 characters, at least 1 uppercase, 1 lowercase, 1 number)
 */
const validatePassword = (field = 'password') =>
  body(field)
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters long')
    .matches(/[A-Z]/)
    .withMessage('Password must contain at least one uppercase letter')
    .matches(/[a-z]/)
    .withMessage('Password must contain at least one lowercase letter')
    .matches(/[0-9]/)
    .withMessage('Password must contain at least one number')
    .trim();

/**
 * Password confirmation validation
 */
const validatePasswordConfirmation = (passwordField = 'password', confirmField = 'confirmPassword') =>
  body(confirmField)
    .custom((value, { req }) => {
      if (value !== req.body[passwordField]) {
        throw new Error('Password confirmation does not match');
      }
      return true;
    });

/**
 * Kenyan phone number validation
 */
const validateKenyanPhone = (field = 'phoneNumber') =>
  body(field)
    .optional()
    .custom((value) => {
      if (!value) return true;
      // Accepts: 0712345678, 254712345678, +254712345678
      const phoneRegex = /^(254|\+254|0)[7-9][0-9]{8}$/;
      if (!phoneRegex.test(value)) {
        throw new Error('Please enter a valid Kenyan phone number (e.g., 0712345678)');
      }
      return true;
    });

/**
 * Amount validation (positive number)
 */
const validateAmount = (field = 'amount', min = 0.01) =>
  body(field)
    .isFloat({ min })
    .withMessage(`Amount must be at least ${min}`)
    .toFloat();

/**
 * URL validation
 */
const validateUrl = (field = 'url') =>
  body(field)
    .optional()
    .isURL({ protocols: ['http', 'https'], require_protocol: true })
    .withMessage('Please provide a valid URL starting with http:// or https://');

/**
 * MongoDB ObjectId validation
 */
const validateObjectId = (field, paramName = field) =>
  param(field)
    .isMongoId()
    .withMessage(`Invalid ${paramName} ID format`);

/**
 * Campaign title validation
 */
const validateCampaignTitle = () =>
  body('title')
    .notEmpty()
    .withMessage('Campaign title is required')
    .isLength({ min: 3, max: 200 })
    .withMessage('Campaign title must be between 3 and 200 characters')
    .trim();

/**
 * Campaign budget validation
 */
const validateCampaignBudget = () =>
  body('budget')
    .isFloat({ min: 1 })
    .withMessage('Budget must be at least $1')
    .toFloat();

/**
 * Date validation (future date)
 */
const validateFutureDate = (field = 'deadline') =>
  body(field)
    .optional()
    .isISO8601()
    .withMessage('Invalid date format')
    .custom((value) => {
      if (value && new Date(value) <= new Date()) {
        throw new Error('Date must be in the future');
      }
      return true;
    });

/**
 * Pagination query validation
 */
const validatePagination = () => [
  query('page')
    .optional()
    .isInt({ min: 1 })
    .withMessage('Page must be a positive integer')
    .toInt(),
  query('limit')
    .optional()
    .isInt({ min: 1, max: 100 })
    .withMessage('Limit must be between 1 and 100')
    .toInt()
];

/**
 * Role validation
 */
const validateRole = () =>
  body('role')
    .isIn(['creator', 'business', 'admin'])
    .withMessage('Role must be creator, business, or admin');

/**
 * Withdrawal amount validation (supports both USD and local currency)
 */
const validateWithdrawalAmount = () => [
  body('amountUsd')
    .optional()
    .isFloat({ min: 1 })
    .withMessage('Amount in USD must be at least $1')
    .toFloat(),
  body('amountLocal')
    .optional()
    .isFloat({ min: 1 })
    .withMessage('Amount in local currency must be at least 1')
    .toFloat(),
  body('currency')
    .optional()
    .isLength({ min: 3, max: 3 })
    .withMessage('Currency must be a 3-letter code (e.g., USD, KES)')
    .toUpperCase()
];

/**
 * Tip validation
 */
const validateTip = () => [
  body('recipientUsername')
    .optional()
    .isString()
    .trim(),
  body('recipientUniqueCode')
    .optional()
    .isString()
    .trim(),
  body('amount')
    .isFloat({ min: 1 })
    .withMessage('Tip amount must be at least $1')
    .toFloat(),
  body('currency')
    .optional()
    .isLength({ min: 3, max: 3 })
    .withMessage('Currency must be a 3-letter code')
    .toUpperCase()
];

/**
 * Bid validation
 */
const validateBid = () => [
  body('amount')
    .isFloat({ min: 1 })
    .withMessage('Bid amount must be at least $1')
    .toFloat(),
  body('proposal')
    .optional()
    .isLength({ max: 2000 })
    .withMessage('Proposal cannot exceed 2000 characters')
    .trim()
];

/**
 * Comment validation
 */
const validateComment = () =>
  body('text')
    .notEmpty()
    .withMessage('Comment text is required')
    .isLength({ max: 500 })
    .withMessage('Comment cannot exceed 500 characters')
    .trim();

// ============================================
// Helper Function to Check Validation Results
// ============================================

/**
 * Middleware to check validation results and return formatted errors
 */
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const formattedErrors = errors.array().map(err => ({
      field: err.param,
      message: err.msg
    }));
    return res.status(422).json({
      success: false,
      message: 'Validation failed',
      errors: formattedErrors
    });
  }
  next();
};

// ============================================
// Exports
// ============================================

module.exports = {
  // Validation rules
  validateEmail,
  validatePassword,
  validatePasswordConfirmation,
  validateKenyanPhone,
  validateAmount,
  validateUrl,
  validateObjectId,
  validateCampaignTitle,
  validateCampaignBudget,
  validateFutureDate,
  validatePagination,
  validateRole,
  validateWithdrawalAmount,
  validateTip,
  validateBid,
  validateComment,
  
  // Helper
  validate,
  
  // Re-export validationResult for custom usage
  validationResult
};
