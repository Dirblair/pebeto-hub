/**
 * Custom Error Classes for Pebeto Creator's Hub
 * 
 * Provides standardized error handling with:
 * - Operational vs Programming error distinction
 * - Error codes for client-side handling
 * - HTTP status code mapping
 * - Error categorization
 * 
 * @module utils/errors
 */

// ============================================
// Error Codes
// ============================================

const ERROR_CODES = {
  // Authentication (1000-1999)
  AUTH_TOKEN_MISSING: 'AUTH_TOKEN_MISSING',
  AUTH_TOKEN_INVALID: 'AUTH_TOKEN_INVALID',
  AUTH_TOKEN_EXPIRED: 'AUTH_TOKEN_EXPIRED',
  AUTH_TOKEN_REVOKED: 'AUTH_TOKEN_REVOKED',
  AUTH_INVALID_CREDENTIALS: 'AUTH_INVALID_CREDENTIALS',
  AUTH_USER_NOT_FOUND: 'AUTH_USER_NOT_FOUND',
  AUTH_USER_INACTIVE: 'AUTH_USER_INACTIVE',
  AUTH_USER_SUSPENDED: 'AUTH_USER_SUSPENDED',
  AUTH_USER_BANNED: 'AUTH_USER_BANNED',
  AUTH_EMAIL_NOT_VERIFIED: 'AUTH_EMAIL_NOT_VERIFIED',
  AUTH_RATE_LIMIT: 'AUTH_RATE_LIMIT',
  AUTH_FORBIDDEN: 'AUTH_FORBIDDEN',
  
  // Validation (2000-2999)
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  VALIDATION_REQUIRED_FIELD: 'VALIDATION_REQUIRED_FIELD',
  VALIDATION_INVALID_EMAIL: 'VALIDATION_INVALID_EMAIL',
  VALIDATION_INVALID_PHONE: 'VALIDATION_INVALID_PHONE',
  VALIDATION_INVALID_AMOUNT: 'VALIDATION_INVALID_AMOUNT',
  VALIDATION_PASSWORD_WEAK: 'VALIDATION_PASSWORD_WEAK',
  VALIDATION_PASSWORD_MISMATCH: 'VALIDATION_PASSWORD_MISMATCH',
  
  // Database (3000-3999)
  DB_DUPLICATE_KEY: 'DB_DUPLICATE_KEY',
  DB_CAST_ERROR: 'DB_CAST_ERROR',
  DB_VALIDATION_ERROR: 'DB_VALIDATION_ERROR',
  DB_NOT_FOUND: 'DB_NOT_FOUND',
  DB_CONNECTION_ERROR: 'DB_CONNECTION_ERROR',
  
  // Wallet (4000-4999)
  WALLET_INSUFFICIENT_FUNDS: 'WALLET_INSUFFICIENT_FUNDS',
  WALLET_NOT_FOUND: 'WALLET_NOT_FOUND',
  WALLET_FROZEN: 'WALLET_FROZEN',
  WALLET_INVALID_TRANSACTION: 'WALLET_INVALID_TRANSACTION',
  WALLET_CONCURRENCY_ERROR: 'WALLET_CONCURRENCY_ERROR',
  
  // Withdrawal (5000-5999)
  WITHDRAWAL_MINIMUM_NOT_MET: 'WITHDRAWAL_MINIMUM_NOT_MET',
  WITHDRAWAL_INVALID_METHOD: 'WITHDRAWAL_INVALID_METHOD',
  WITHDRAWAL_INVALID_DETAILS: 'WITHDRAWAL_INVALID_DETAILS',
  WITHDRAWAL_PAYOUT_FAILED: 'WITHDRAWAL_PAYOUT_FAILED',
  WITHDRAWAL_LIMIT_EXCEEDED: 'WITHDRAWAL_LIMIT_EXCEEDED',
  
  // Deposit (6000-6999)
  DEPOSIT_INVALID_METHOD: 'DEPOSIT_INVALID_METHOD',
  DEPOSIT_PAYMENT_FAILED: 'DEPOSIT_PAYMENT_FAILED',
  DEPOSIT_DUPLICATE: 'DEPOSIT_DUPLICATE',
  
  // Campaign (7000-7999)
  CAMPAIGN_NOT_FOUND: 'CAMPAIGN_NOT_FOUND',
  CAMPAIGN_INVALID_STATUS: 'CAMPAIGN_INVALID_STATUS',
  CAMPAIGN_ALREADY_BID: 'CAMPAIGN_ALREADY_BID',
  CAMPAIGN_BID_NOT_FOUND: 'CAMPAIGN_BID_NOT_FOUND',
  CAMPAIGN_INSUFFICIENT_ESCROW: 'CAMPAIGN_INSUFFICIENT_ESCROW',
  CAMPAIGN_NOT_OPEN: 'CAMPAIGN_NOT_OPEN',
  CAMPAIGN_CANNOT_MODIFY: 'CAMPAIGN_CANNOT_MODIFY',
  
  // Rate Limiting (8000-8999)
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
  
  // General (9000-9999)
  NOT_FOUND: 'NOT_FOUND',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  BAD_REQUEST: 'BAD_REQUEST',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  CONFLICT: 'CONFLICT',
  UNPROCESSABLE_ENTITY: 'UNPROCESSABLE_ENTITY',
};

// ============================================
// HTTP Status Code Mapping
// ============================================

const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  ACCEPTED: 202,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE_ENTITY: 422,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
};

// ============================================
// Base AppError Class
// ============================================

/**
 * Base application error class
 * Distinguishes between operational errors (handled) and programming errors (unhandled)
 */
class AppError extends Error {
  /**
   * Create a new AppError
   * @param {string} message - Error message
   * @param {number} statusCode - HTTP status code (default: 400)
   * @param {string} code - Error code for client-side handling (default: derived from statusCode)
   */
  constructor(message, statusCode = HTTP_STATUS.BAD_REQUEST, code = null) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code || getDefaultErrorCode(statusCode);
    this.isOperational = true;
    
    // Capture stack trace (excludes constructor from stack)
    Error.captureStackTrace(this, this.constructor);
  }
}

// ============================================
// Specific Error Classes
// ============================================

/**
 * Authentication error (401)
 */
class AuthenticationError extends AppError {
  constructor(message = 'Authentication required', code = ERROR_CODES.AUTH_TOKEN_MISSING) {
    super(message, HTTP_STATUS.UNAUTHORIZED, code);
  }
}

/**
 * Authorization error (403)
 */
class AuthorizationError extends AppError {
  constructor(message = 'You do not have permission to access this resource', code = ERROR_CODES.AUTH_FORBIDDEN) {
    super(message, HTTP_STATUS.FORBIDDEN, code);
  }
}

/**
 * Validation error (422)
 */
class ValidationError extends AppError {
  constructor(message = 'Validation failed', errors = null) {
    super(message, HTTP_STATUS.UNPROCESSABLE_ENTITY, ERROR_CODES.VALIDATION_ERROR);
    this.errors = errors;
  }
}

/**
 * Not found error (404)
 */
class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(`${resource} not found`, HTTP_STATUS.NOT_FOUND, ERROR_CODES.NOT_FOUND);
  }
}

/**
 * Conflict error (409) - e.g., duplicate entry
 */
class ConflictError extends AppError {
  constructor(message = 'Resource already exists') {
    super(message, HTTP_STATUS.CONFLICT, ERROR_CODES.CONFLICT);
  }
}

/**
 * Insufficient funds error (400)
 */
class InsufficientFundsError extends AppError {
  constructor(message = 'Insufficient funds in wallet', required = null, available = null) {
    super(message, HTTP_STATUS.BAD_REQUEST, ERROR_CODES.WALLET_INSUFFICIENT_FUNDS);
    this.required = required;
    this.available = available;
  }
}

/**
 * Rate limit error (429)
 */
class RateLimitError extends AppError {
  constructor(message = 'Too many requests. Please try again later.') {
    super(message, HTTP_STATUS.TOO_MANY_REQUESTS, ERROR_CODES.RATE_LIMIT_EXCEEDED);
  }
}

/**
 * Database error (500)
 */
class DatabaseError extends AppError {
  constructor(message = 'Database operation failed', originalError = null) {
    super(message, HTTP_STATUS.INTERNAL_SERVER_ERROR, ERROR_CODES.DB_CONNECTION_ERROR);
    this.originalError = originalError;
  }
}

/**
 * Payment error (400/502)
 */
class PaymentError extends AppError {
  constructor(message = 'Payment processing failed', statusCode = HTTP_STATUS.BAD_GATEWAY, code = ERROR_CODES.DEPOSIT_PAYMENT_FAILED) {
    super(message, statusCode, code);
  }
}

/**
 * Campaign error (400)
 */
class CampaignError extends AppError {
  constructor(message, code = ERROR_CODES.CAMPAIGN_NOT_FOUND) {
    super(message, HTTP_STATUS.BAD_REQUEST, code);
  }
}

/**
 * Wallet error (400)
 */
class WalletError extends AppError {
  constructor(message, code = ERROR_CODES.WALLET_NOT_FOUND) {
    super(message, HTTP_STATUS.BAD_REQUEST, code);
  }
}

// ============================================
// Helper Functions
// ============================================

/**
 * Get default error code based on HTTP status
 * @param {number} statusCode - HTTP status code
 * @returns {string} Default error code
 */
function getDefaultErrorCode(statusCode) {
  switch (statusCode) {
    case HTTP_STATUS.UNAUTHORIZED:
      return ERROR_CODES.AUTH_TOKEN_MISSING;
    case HTTP_STATUS.FORBIDDEN:
      return ERROR_CODES.AUTH_FORBIDDEN;
    case HTTP_STATUS.NOT_FOUND:
      return ERROR_CODES.NOT_FOUND;
    case HTTP_STATUS.CONFLICT:
      return ERROR_CODES.CONFLICT;
    case HTTP_STATUS.UNPROCESSABLE_ENTITY:
      return ERROR_CODES.VALIDATION_ERROR;
    case HTTP_STATUS.TOO_MANY_REQUESTS:
      return ERROR_CODES.RATE_LIMIT_EXCEEDED;
    case HTTP_STATUS.INTERNAL_SERVER_ERROR:
      return ERROR_CODES.INTERNAL_ERROR;
    default:
      return ERROR_CODES.BAD_REQUEST;
  }
}

/**
 * Format error for response
 * @param {Error} error - Error object
 * @param {string} requestId - Request tracking ID
 * @param {boolean} includeStack - Whether to include stack trace
 * @returns {Object} Formatted error response
 */
function formatErrorResponse(error, requestId = null, includeStack = false) {
  const isAppError = error instanceof AppError;
  
  const response = {
    success: false,
    message: error.message || 'An unexpected error occurred',
    code: isAppError ? error.code : ERROR_CODES.INTERNAL_ERROR,
    statusCode: isAppError ? error.statusCode : HTTP_STATUS.INTERNAL_SERVER_ERROR,
  };
  
  if (requestId) {
    response.requestId = requestId;
  }
  
  if (includeStack && process.env.NODE_ENV !== 'production') {
    response.stack = error.stack;
  }
  
  if (error instanceof ValidationError && error.errors) {
    response.errors = error.errors;
  }
  
  if (error instanceof InsufficientFundsError) {
    if (error.required) response.required = error.required;
    if (error.available) response.available = error.available;
  }
  
  return response;
}

/**
 * Convert mongoose/database error to AppError
 * @param {Error} err - Mongoose error
 * @returns {AppError} Converted error
 */
function convertDatabaseError(err) {
  // Duplicate key error (code 11000)
  if (err.code === 11000) {
    const field = Object.keys(err.keyPattern)[0];
    return new ConflictError(`${field} already exists`);
  }
  
  // Cast error (invalid ObjectId)
  if (err.name === 'CastError') {
    return new AppError(`Invalid ${err.path}: ${err.value}`, HTTP_STATUS.BAD_REQUEST, ERROR_CODES.DB_CAST_ERROR);
  }
  
  // Validation error
  if (err.name === 'ValidationError') {
    const errors = {};
    for (const field in err.errors) {
      errors[field] = err.errors[field].message;
    }
    const validationError = new ValidationError('Validation failed', errors);
    validationError.errors = errors;
    return validationError;
  }
  
  // Generic database error
  return new DatabaseError(err.message, err);
}

/**
 * Async wrapper to catch errors in route handlers
 * @param {Function} fn - Async function to wrap
 * @returns {Function} Wrapped function
 */
function catchAsync(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * Determine if error is operational (safe to show to user)
 * @param {Error} error - Error object
 * @returns {boolean}
 */
function isOperationalError(error) {
  if (error instanceof AppError) return error.isOperational;
  return false;
}

// ============================================
// Exports
// ============================================

module.exports = {
  // Base class
  AppError,
  
  // Specific error classes
  AuthenticationError,
  AuthorizationError,
  ValidationError,
  NotFoundError,
  ConflictError,
  InsufficientFundsError,
  RateLimitError,
  DatabaseError,
  PaymentError,
  CampaignError,
  WalletError,
  
  // Error codes
  ERROR_CODES,
  
  // HTTP status codes
  HTTP_STATUS,
  
  // Helper functions
  getDefaultErrorCode,
  formatErrorResponse,
  convertDatabaseError,
  catchAsync,
  isOperationalError,
};
