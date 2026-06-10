/**
 * Authentication Middleware for Pebeto Creator's Hub
 * 
 * Handles JWT verification and user authorization
 * 
 * @module middleware/auth
 */

const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { AppError } = require('../utils/errors');
const logger = require('../utils/logger');

// ============================================
// Main Authentication Middleware
// ============================================

/**
 * Authenticate user using JWT token from Authorization header
 */
async function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw new AppError('Authentication required', 401);
    }
    
    const token = header.split(' ')[1];
    
    if (!token) {
      throw new AppError('Invalid token format', 401);
    }
    
    const decoded = jwt.verify(token, env.jwtSecret);
    
    if (!decoded.userId) {
      throw new AppError('Invalid token payload', 401);
    }
    
    req.user = {
      _id: decoded.userId,
      role: decoded.role || 'user'
    };
    req.token = token;
    
    next();
    
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      next(new AppError('Token expired. Please login again.', 401));
    } else if (error.name === 'JsonWebTokenError') {
      next(new AppError('Invalid token', 401));
    } else {
      next(error);
    }
  }
}

// ============================================
// Authorization Middleware
// ============================================

/**
 * Authorize user based on role(s)
 */
function authorize(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return next(new AppError('Authentication required', 401));
    }
    
    if (!roles.includes(req.user.role)) {
      return next(new AppError(`Access denied. Required role: ${roles.join(' or ')}`, 403));
    }
    
    next();
  };
}

// ============================================
// Optional Authentication
// ============================================

/**
 * Optional authentication - doesn't fail if no token
 */
async function optionalAuthenticate(req, res, next) {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      req.user = null;
      return next();
    }
    
    const token = header.split(' ')[1];
    const decoded = jwt.verify(token, env.jwtSecret);
    
    req.user = {
      _id: decoded.userId,
      role: decoded.role || 'user'
    };
    
    next();
  } catch (error) {
    req.user = null;
    next();
  }
}

// ============================================
// Exports
// ============================================

module.exports = {
  authenticate,
  authorize,
  optionalAuthenticate
};
