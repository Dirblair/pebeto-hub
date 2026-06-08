/**
 * Central Error Handler for Pebeto Creator's Hub
 * 
 * Handles all application errors, formats responses appropriately
 * based on environment, and integrates with logging/monitoring services.
 * 
 * @module middleware/errorHandler
 */

const { AppError } = require('../utils/errors');
const logger = require('../utils/logger');

// ============================================
// Error Type Constants
// ============================================

const ERROR_TYPES = {
  // Authentication/Authorization
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  INVALID_TOKEN: 'INVALID_TOKEN',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  
  // Validation
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  DUPLICATE_KEY: 'DUPLICATE_KEY',
  CAST_ERROR: 'CAST_ERROR',
  
  // Database
  DATABASE_ERROR: 'DATABASE_ERROR',
  CONNECTION_ERROR: 'CONNECTION_ERROR',
  
  // Business Logic
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
  CAMPAIGN_NOT_FOUND: 'CAMPAIGN_NOT_FOUND',
  BID_ALREADY_EXISTS: 'BID_ALREADY_EXISTS',
  
  // Rate Limiting
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
  
  // File Upload
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  INVALID_FILE_TYPE: 'INVALID_FILE_TYPE',
  
  // Payment
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  MPESA_ERROR: 'MPESA_ERROR',
  
  // Generic
  NOT_FOUND: 'NOT_FOUND',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
};

// ============================================
// Environment Detection
// ============================================

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const IS_DEVELOPMENT = process.env.NODE_ENV === 'development';
const IS_TEST = process.env.NODE_ENV === 'test';

// ============================================
// Error Classification Helpers
// ============================================

/**
 * Determine if error is a known operational error
 * @param {Error} err - Error object
 * @returns {boolean}
 */
function isOperationalError(err) {
  if (err.isOperational) return true;
  if (err instanceof AppError) return true;
  
  // Check for known error types that are operational
  const operationalErrorNames = [
    'ValidationError',
    'CastError',
    'MongoError',
    'MongoServerError',
    'MulterError',
    'RateLimitError',
    'JsonWebTokenError',
    'TokenExpiredError'
  ];
  
  return operationalErrorNames.includes(err.name);
}

/**
 * Get error type classification
 * @param {Error} err - Error object
 * @returns {string} Error type
 */
function getErrorType(err) {
  // JWT Errors
  if (err.name === 'JsonWebTokenError') return ERROR_TYPES.INVALID_TOKEN;
  if (err.name === 'TokenExpiredError') return ERROR_TYPES.TOKEN_EXPIRED;
  
  // Database Errors
  if (err.name === 'ValidationError') return ERROR_TYPES.VALIDATION_ERROR;
  if (err.name === 'CastError') return ERROR_TYPES.CAST_ERROR;
  if (err.code === 11000) return ERROR_TYPES.DUPLICATE_KEY;
  
  // Multer (File Upload) Errors
  if (err.name === 'MulterError') {
    if (err.code === 'LIMIT_FILE_SIZE') return ERROR_TYPES.FILE_TOO_LARGE;
    if (err.code === 'LIMIT_FILE_TYPE') return ERROR_TYPES.INVALID_FILE_TYPE;
    return ERROR_TYPES.VALIDATION_ERROR;
  }
  
  // Rate Limiting
  if (err.name === 'RateLimitError') return ERROR_TYPES.RATE_LIMIT_EXCEEDED;
  
  // Use error code if available
  if (err.code) return err.code;
  
  // Default
  return ERROR_TYPES.INTERNAL_ERROR;
}

/**
 * Get appropriate HTTP status code for error
 * @param {Error} err - Error object
 * @returns {number} HTTP status code
 */
function getStatusCode(err) {
  if (err.statusCode) return err.statusCode;
  
  switch (err.name) {
    case 'ValidationError':
    case 'CastError':
      return 400;
    case 'JsonWebTokenError':
    case 'TokenExpiredError':
      return 401;
    case 'MulterError':
      if (err.code === 'LIMIT_FILE_SIZE') return 413;
      return 400;
    case 'RateLimitError':
      return 429;
    default:
      if (err.code === 11000) return 409;
      return err.statusCode || 500;
  }
}

/**
 * Format validation errors from Mongoose
 * @param {Error} err - Mongoose validation error
 * @returns {Object} Formatted validation errors
 */
function formatValidationError(err) {
  const errors = {};
  
  for (const field in err.errors) {
    errors[field] = err.errors[field].message;
  }
  
  return {
    message: 'Validation failed',
    fields: errors
  };
}

/**
 * Format duplicate key error
 * @param {Error} err - MongoDB duplicate key error
 * @returns {Object} Formatted error
 */
function formatDuplicateKeyError(err) {
  const field = Object.keys(err.keyPattern)[0];
  const value = err.keyValue[field];
  
  return {
    message: `Duplicate value: ${field} '${value}' already exists`,
    field,
    value
  };
}

/**
 * Format cast error (invalid ObjectId, etc.)
 * @param {Error} err - Mongoose cast error
 * @returns {Object} Formatted error
 */
function formatCastError(err) {
  return {
    message: `Invalid ${err.path}: ${err.value}`,
    field: err.path,
    value: err.value
  };
}

// ============================================
// Error Response Formatters
// ============================================

/**
 * Format error for development environment (verbose)
 * @param {Error} err - Error object
 * @param {string} requestId - Request tracking ID
 * @returns {Object} Formatted error response
 */
function formatDevError(err, requestId) {
  return {
    success: false,
    error: {
      message: err.message,
      type: getErrorType(err),
      statusCode: getStatusCode(err),
      stack: err.stack,
      requestId,
      ...(err.errors && { details: err.errors }),
      ...(err.code === 11000 && { duplicateKey: err.keyValue })
    }
  };
}

/**
 * Format error for production environment (safe)
 * @param {Error} err - Error object
 * @param {string} requestId - Request tracking ID
 * @returns {Object} Formatted error response
 */
function formatProdError(err, requestId) {
  const statusCode = getStatusCode(err);
  const errorType = getErrorType(err);
  
  // User-friendly messages for known error types
  const userMessages = {
    [ERROR_TYPES.UNAUTHORIZED]: 'Authentication required. Please log in.',
    [ERROR_TYPES.FORBIDDEN]: 'You don\'t have permission to access this resource.',
    [ERROR_TYPES.INVALID_TOKEN]: 'Invalid authentication token. Please log in again.',
    [ERROR_TYPES.TOKEN_EXPIRED]: 'Your session has expired. Please log in again.',
    [ERROR_TYPES.VALIDATION_ERROR]: 'Please check your input and try again.',
    [ERROR_TYPES.DUPLICATE_KEY]: 'This record already exists.',
    [ERROR_TYPES.INSUFFICIENT_FUNDS]: 'Insufficient funds in your wallet.',
    [ERROR_TYPES.CAMPAIGN_NOT_FOUND]: 'The requested campaign was not found.',
    [ERROR_TYPES.RATE_LIMIT_EXCEEDED]: 'Too many requests. Please try again later.',
    [ERROR_TYPES.FILE_TOO_LARGE]: 'File size exceeds the maximum allowed limit.',
    [ERROR_TYPES.INVALID_FILE_TYPE]: 'File type not supported.',
    [ERROR_TYPES.NOT_FOUND]: 'The requested resource was not found.',
    [ERROR_TYPES.PAYMENT_FAILED]: 'Payment processing failed. Please try again.',
  };
  
  const userMessage = userMessages[errorType] || 
    (err.isOperational ? err.message : 'Something went wrong. Please try again later.');
  
  const response = {
    success: false,
    message: userMessage,
    error: {
      type: errorType,
      statusCode,
      requestId
    }
  };
  
  // Add field-specific validation errors for client
  if (errorType === ERROR_TYPES.VALIDATION_ERROR && err.errors) {
    error.fields = {};
    for (const field in err.errors) {
      error.fields[field] = err.errors[field].message;
    }
  }
  
  // Add duplicate field info
  if (errorType === ERROR_TYPES.DUPLICATE_KEY && err.keyPattern) {
    error.field = Object.keys(err.keyPattern)[0];
  }
  
  return response;
}

// ============================================
// Logging Helpers
// ============================================

/**
 * Log error with appropriate level and metadata
 * @param {Error} err - Error object
 * @param {Object} req - Express request object
 * @param {string} requestId - Request tracking ID
 */
function logError(err, req, requestId) {
  const statusCode = getStatusCode(err);
  const errorType = getErrorType(err);
  const isOperational = isOperationalError(err);
  
  // Build log metadata
  const logMetadata = {
    requestId,
    error: {
      name: err.name,
      message: err.message,
      type: errorType,
      statusCode,
      stack: IS_DEVELOPMENT ? err.stack : undefined,
      code: err.code,
      ...(err.keyPattern && { duplicateKey: err.keyPattern }),
      ...(err.errors && { validationErrors: Object.keys(err.errors) })
    },
    request: {
      method: req.method,
      url: req.url,
      ip: req.ip || req.connection?.remoteAddress,
      userAgent: req.get('user-agent'),
      userId: req.user?._id,
      userRole: req.user?.role
    }
  };
  
  // Choose log level based on status code
  if (statusCode >= 500) {
    logger.error(`[${errorType}] ${err.message}`, logMetadata);
  } else if (statusCode >= 400 && statusCode < 500) {
    if (isOperational) {
      logger.warn(`[${errorType}] ${err.message}`, logMetadata);
    } else {
      logger.error(`[${errorType}] ${err.message}`, logMetadata);
    }
  } else {
    logger.info(`[${errorType}] ${err.message}`, logMetadata);
  }
  
  // Always log to console in development for debugging
  if (IS_DEVELOPMENT) {
    console.error('\n--- ERROR DETAILS ---');
    console.error(`[${new Date().toISOString()}] ${err.stack || err.message}`);
    console.error('--- END ERROR ---\n');
  }
}

// ============================================
// Main Error Handler Middleware
// ============================================

/**
 * Global error handling middleware
 * @param {Error} err - Error object
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
function errorHandler(err, req, res, next) {
  // Get or generate request ID
  const requestId = req.id || req.requestId || Math.random().toString(36).substring(2, 12);
  
  // Log the error
  logError(err, req, requestId);
  
  // Handle specific error types
  let processedError = err;
  
  // Mongoose Validation Error
  if (err.name === 'ValidationError') {
    processedError = new AppError(
      formatValidationError(err).message,
      400,
      ERROR_TYPES.VALIDATION_ERROR
    );
    processedError.errors = err.errors;
  }
  
  // Mongoose Cast Error (invalid ObjectId)
  else if (err.name === 'CastError') {
    const formatted = formatCastError(err);
    processedError = new AppError(formatted.message, 400, ERROR_TYPES.CAST_ERROR);
    processedError.field = formatted.field;
  }
  
  // MongoDB Duplicate Key Error
  else if (err.code === 11000) {
    const formatted = formatDuplicateKeyError(err);
    processedError = new AppError(formatted.message, 409, ERROR_TYPES.DUPLICATE_KEY);
    processedError.keyPattern = err.keyPattern;
    processedError.keyValue = err.keyValue;
  }
  
  // JWT Errors
  else if (err.name === 'JsonWebTokenError') {
    processedError = new AppError('Invalid authentication token', 401, ERROR_TYPES.INVALID_TOKEN);
  }
  else if (err.name === 'TokenExpiredError') {
    processedError = new AppError('Authentication token has expired', 401, ERROR_TYPES.TOKEN_EXPIRED);
  }
  
  // Multer (File Upload) Errors
  else if (err.name === 'MulterError') {
    if (err.code === 'LIMIT_FILE_SIZE') {
      processedError = new AppError('File too large. Maximum size is 100MB.', 413, ERROR_TYPES.FILE_TOO_LARGE);
    } else if (err.code === 'LIMIT_FILE_TYPE') {
      processedError = new AppError('Invalid file type. Please upload an image or video.', 400, ERROR_TYPES.INVALID_FILE_TYPE);
    } else {
      processedError = new AppError(err.message, 400, ERROR_TYPES.VALIDATION_ERROR);
    }
  }
  
  // Rate Limit Error
  else if (err.name === 'RateLimitError') {
    processedError = new AppError('Too many requests. Please try again later.', 429, ERROR_TYPES.RATE_LIMIT_EXCEEDED);
  }
  
  // 404 Not Found (express default)
  else if (err.message === 'Not Found') {
    processedError = new AppError('Resource not found', 404, ERROR_TYPES.NOT_FOUND);
  }
  
  // Ensure we have a status code
  const statusCode = getStatusCode(processedError);
  
  // Format response based on environment
  const response = IS_PRODUCTION || IS_TEST
    ? formatProdError(processedError, requestId)
    : formatDevError(processedError, requestId);
  
  // Add CORS headers for error responses
  res.setHeader('X-Request-ID', requestId);
  
  // Send response
  res.status(statusCode).json(response);
}

// ============================================
// 404 Not Found Handler
// ============================================

/**
 * Handle 404 - Route not found
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
function notFoundHandler(req, res, next) {
  const error = new AppError(
    `Cannot ${req.method} ${req.originalUrl}. Route not found.`,
    404,
    ERROR_TYPES.NOT_FOUND
  );
  next(error);
}

// ============================================
// Async Wrapper for Controllers
// ============================================

/**
 * Wrapper for async route handlers to eliminate try-catch blocks
 * @param {Function} fn - Async function to wrap
 * @returns {Function} Express middleware
 */
function catchAsync(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// ============================================
// Unhandled Rejection/Exception Handlers
// ============================================

/**
 * Handle unhandled promise rejections
 * @param {Error} err - Error object
 */
function handleUnhandledRejection(err) {
  logger.error('UNHANDLED PROMISE REJECTION', {
    error: {
      name: err.name,
      message: err.message,
      stack: err.stack
    }
  });
  
  console.error('💥 Unhandled Promise Rejection:', err);
  
  // In production, attempt graceful shutdown
  if (IS_PRODUCTION) {
    console.error('⚠️ Performing graceful shutdown...');
    process.exit(1);
  }
}

/**
 * Handle uncaught exceptions
 * @param {Error} err - Error object
 */
function handleUncaughtException(err) {
  logger.error('UNCAUGHT EXCEPTION', {
    error: {
      name: err.name,
      message: err.message,
      stack: err.stack
    }
  });
  
  console.error('💥 Uncaught Exception:', err);
  
  // Uncaught exceptions are serious - exit immediately
  process.exit(1);
}

// Set up global handlers
process.on('unhandledRejection', handleUnhandledRejection);
process.on('uncaughtException', handleUncaughtException);

// ============================================
// Exports
// ============================================

module.exports = {
  errorHandler,
  notFoundHandler,
  catchAsync,
  ERROR_TYPES,
  getStatusCode,
  getErrorType,
  isOperationalError,
  formatValidationError,
  formatDuplicateKeyError,
  formatCastError
};
