/**
 * Authentication Middleware for Pebeto Creator's Hub
 * 
 * Handles JWT verification, user authorization, token blacklisting,
 * and session management for protected routes.
 * 
 * @module middleware/auth
 */

const jwt = require('jsonwebtoken');
const { RateLimiterMemory } = require('rate-limiter-flexible');
const env = require('../config/env');
const User = require('../models/User');
const { AppError } = require('../utils/errors');
const logger = require('../utils/logger');

// ============================================
// Rate Limiting for Authentication
// ============================================

// Rate limiter for failed authentication attempts
const authRateLimiter = new RateLimiterMemory({
  points: 10, // Number of attempts
  duration: 60, // Per 60 seconds
  blockDuration: 300, // Block for 5 minutes after exceeding
});

// ============================================
// Token Blacklist (In-memory for development)
// In production, use Redis or database
// ============================================

const tokenBlacklist = new Map();
const BLACKLIST_CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hour

// Clean up expired blacklist entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [token, expiry] of tokenBlacklist.entries()) {
    if (expiry < now) {
      tokenBlacklist.delete(token);
    }
  }
}, BLACKLIST_CLEANUP_INTERVAL);

/**
 * Add token to blacklist
 * @param {string} token - JWT token to blacklist
 * @param {number} expiry - Token expiry timestamp
 */
function blacklistToken(token, expiry) {
  tokenBlacklist.set(token, expiry);
  logger.debug('Token blacklisted', { tokenHash: token.substring(0, 10) + '...' });
}

/**
 * Check if token is blacklisted
 * @param {string} token - JWT token to check
 * @returns {boolean} True if token is blacklisted
 */
function isTokenBlacklisted(token) {
  return tokenBlacklist.has(token);
}

// ============================================
// Session Management
// ============================================

// Store active sessions (use Redis in production)
const activeSessions = new Map();

/**
 * Track active user session
 * @param {string} userId - User ID
 * @param {string} token - JWT token
 * @param {number} expiry - Session expiry timestamp
 */
function trackSession(userId, token, expiry) {
  if (!activeSessions.has(userId)) {
    activeSessions.set(userId, new Map());
  }
  const userSessions = activeSessions.get(userId);
  userSessions.set(token, expiry);
  
  // Clean up expired sessions for this user
  const now = Date.now();
  for (const [tok, exp] of userSessions.entries()) {
    if (exp < now) {
      userSessions.delete(tok);
    }
  }
}

/**
 * Invalidate all sessions for a user
 * @param {string} userId - User ID
 */
function invalidateUserSessions(userId) {
  if (activeSessions.has(userId)) {
    const userSessions = activeSessions.get(userId);
    for (const [token] of userSessions) {
      blacklistToken(token, Date.now() + 86400000); // Blacklist for 24 hours
    }
    activeSessions.delete(userId);
    logger.info('All user sessions invalidated', { userId });
  }
}

/**
 * Validate user session
 * @param {string} userId - User ID
 * @param {string} token - JWT token
 * @returns {boolean} True if session is valid
 */
function isSessionValid(userId, token) {
  if (!activeSessions.has(userId)) return false;
  const userSessions = activeSessions.get(userId);
  return userSessions.has(token);
}

// ============================================
// Main Authentication Middleware
// ============================================

/**
 * Authenticate user using JWT token from Authorization header
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
async function authenticate(req, res, next) {
  const clientIp = req.ip || req.connection.remoteAddress;
  const requestId = req.id || Math.random().toString(36).substring(7);
  
  try {
    // Extract token from header
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw new AppError('Authentication required. Please provide a valid token.', 401, 'AUTH_TOKEN_MISSING');
    }
    
    const token = header.split(' ')[1];
    
    // Check token format (basic validation)
    if (!token || token.length < 20) {
      throw new AppError('Invalid token format', 401, 'AUTH_TOKEN_INVALID');
    }
    
    // Check if token is blacklisted
    if (isTokenBlacklisted(token)) {
      logger.warn('Attempt to use blacklisted token', { 
        requestId, 
        clientIp,
        tokenHash: token.substring(0, 10) + '...'
      });
      throw new AppError('Token has been revoked. Please log in again.', 401, 'AUTH_TOKEN_REVOKED');
    }
    
    // Verify JWT token
    let decoded;
    try {
      decoded = jwt.verify(token, env.jwtSecret, {
        algorithms: ['HS256'],
        issuer: env.jwtIssuer || 'pebeto',
        audience: env.jwtAudience || 'pebeto-api',
      });
    } catch (jwtError) {
      if (jwtError.name === 'TokenExpiredError') {
        throw new AppError('Token has expired. Please log in again.', 401, 'AUTH_TOKEN_EXPIRED');
      }
      if (jwtError.name === 'JsonWebTokenError') {
        throw new AppError('Invalid token signature.', 401, 'AUTH_TOKEN_INVALID');
      }
      throw new AppError('Token verification failed.', 401, 'AUTH_TOKEN_VERIFICATION_FAILED');
    }
    
    // Validate required claims
    if (!decoded.userId) {
      throw new AppError('Invalid token payload: missing userId', 401, 'AUTH_TOKEN_MISSING_USER_ID');
    }
    
    // Rate limiting for failed auth (successful auth doesn't count)
    try {
      await authRateLimiter.consume(clientIp);
    } catch (rateError) {
      logger.warn('Rate limit exceeded for authentication', { requestId, clientIp });
      throw new AppError('Too many authentication attempts. Please try again later.', 429, 'AUTH_RATE_LIMIT');
    }
    
    // Fetch user from database
    const user = await User.findById(decoded.userId).select('+passwordHash +emailVerificationToken');
    
    if (!user) {
      logger.warn('Authentication failed: user not found', { 
        requestId, 
        userId: decoded.userId,
        clientIp 
      });
      throw new AppError('User not found. Please check your credentials.', 401, 'AUTH_USER_NOT_FOUND');
    }
    
    // Check user status
    if (user.status !== 'active') {
      let message = 'Account is not active. ';
      if (user.status === 'suspended') {
        message += 'Your account has been suspended. Please contact support.';
      } else if (user.status === 'banned') {
        message += 'Your account has been permanently banned.';
      } else if (user.status === 'pending') {
        message += 'Please verify your email address to activate your account.';
      } else {
        message += `Account status: ${user.status}`;
      }
      throw new AppError(message, 401, `AUTH_USER_${user.status.toUpperCase()}`);
    }
    
    // Check if email is verified (except for certain routes)
    const publicPaths = ['/api/auth/resend-verification', '/api/auth/verify-email'];
    if (!user.emailVerified && !publicPaths.includes(req.path)) {
      throw new AppError('Please verify your email address before continuing.', 403, 'AUTH_EMAIL_NOT_VERIFIED');
    }
    
    // Check if token version matches (for password change invalidation)
    if (decoded.tokenVersion !== undefined && user.tokenVersion !== decoded.tokenVersion) {
      logger.warn('Token version mismatch - user changed password', { 
        requestId, 
        userId: user._id 
      });
      throw new AppError('Session invalidated due to password change. Please log in again.', 401, 'AUTH_TOKEN_VERSION_MISMATCH');
    }
    
    // Validate session (if enabled)
    if (env.SESSION_TRACKING_ENABLED !== false) {
      if (!isSessionValid(user._id.toString(), token)) {
        // Session not found - maybe logged out elsewhere
        logger.info('Session not found for token', { 
          requestId, 
          userId: user._id 
        });
        throw new AppError('Session expired. Please log in again.', 401, 'AUTH_SESSION_EXPIRED');
      }
      
      // Extend session expiry
      const sessionExpiry = Date.now() + (parseInt(env.JWT_ACCESS_EXPIRES_IN_MS) || 15 * 60 * 1000);
      trackSession(user._id.toString(), token, sessionExpiry);
    }
    
    // Attach user and token info to request
    req.user = user;
    req.token = token;
    req.tokenDecoded = decoded;
    req.requestId = requestId;
    
    // Log successful authentication (optional, can be debug level)
    logger.debug('Authentication successful', {
      requestId,
      userId: user._id,
      role: user.role,
      clientIp
    });
    
    next();
    
  } catch (error) {
    // Log authentication failures
    if (error.statusCode === 401 || error.statusCode === 403) {
      logger.warn('Authentication failed', {
        requestId,
        path: req.path,
        method: req.method,
        clientIp,
        error: error.message,
        code: error.code
      });
    }
    
    next(error);
  }
}

// ============================================
// Authorization Middleware
// ============================================

/**
 * Authorize user based on role(s)
 * 
 * @param {...string} roles - Allowed roles
 * @returns {Function} Express middleware
 */
function authorize(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return next(new AppError('Authentication required before authorization', 401, 'AUTH_REQUIRED'));
    }
    
    if (!roles.includes(req.user.role)) {
      logger.warn('Authorization failed', {
        userId: req.user._id,
        userRole: req.user.role,
        requiredRoles: roles,
        path: req.path,
        method: req.method
      });
      
      return next(new AppError(
        `Access denied. Required role: ${roles.join(' or ')}. Your role: ${req.user.role}`,
        403,
        'AUTH_FORBIDDEN'
      ));
    }
    
    next();
  };
}

/**
 * Check if user has specific permission (RBAC)
 * 
 * @param {string} permission - Permission to check
 * @returns {Function} Express middleware
 */
function hasPermission(permission) {
  return (req, res, next) => {
    if (!req.user) {
      return next(new AppError('Authentication required', 401));
    }
    
    // Define role-based permissions
    const rolePermissions = {
      admin: ['*'], // Admin has all permissions
      business: [
        'create:campaign',
        'edit:campaign',
        'view:campaign',
        'fund:campaign',
        'accept:bid',
        'complete:campaign',
        'view:analytics'
      ],
      creator: [
        'view:campaign',
        'create:bid',
        'submit:work',
        'view:wallet',
        'withdraw:funds',
        'view:profile'
      ]
    };
    
    const userPermissions = rolePermissions[req.user.role] || [];
    
    if (userPermissions.includes('*') || userPermissions.includes(permission)) {
      next();
    } else {
      next(new AppError(`Permission denied: ${permission}`, 403, 'AUTH_PERMISSION_DENIED'));
    }
  };
}

// ============================================
// Optional Authentication (doesn't fail if no token)
// ============================================

/**
 * Optional authentication - doesn't throw error if no token
 * Useful for routes that work for both authenticated and unauthenticated users
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
async function optionalAuthenticate(req, res, next) {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      req.user = null;
      return next();
    }
    
    const token = header.split(' ')[1];
    
    if (isTokenBlacklisted(token)) {
      req.user = null;
      return next();
    }
    
    const decoded = jwt.verify(token, env.jwtSecret);
    const user = await User.findById(decoded.userId);
    
    if (user && user.status === 'active') {
      req.user = user;
      req.token = token;
    } else {
      req.user = null;
    }
    
    next();
  } catch (error) {
    // Don't fail on auth errors for optional auth
    req.user = null;
    next();
  }
}

// ============================================
// Token Refresh Helper
// ============================================

/**
 * Generate new access token from refresh token
 * This should be used by the refresh token endpoint
 * 
 * @param {string} refreshToken - Valid refresh token
 * @returns {Promise<Object>} New tokens
 */
async function refreshAccessToken(refreshToken) {
  try {
    const decoded = jwt.verify(refreshToken, env.jwtSecret);
    
    const user = await User.findById(decoded.userId);
    if (!user || user.status !== 'active') {
      throw new AppError('Invalid refresh token', 401);
    }
    
    // Generate new access token
    const newAccessToken = jwt.sign(
      { 
        userId: user._id, 
        role: user.role,
        tokenVersion: user.tokenVersion 
      },
      env.jwtSecret,
      { 
        expiresIn: env.JWT_ACCESS_EXPIRES_IN || '15m',
        issuer: env.jwtIssuer || 'pebeto',
        audience: env.jwtAudience || 'pebeto-api'
      }
    );
    
    // Track new session
    const expiry = Date.now() + (parseInt(env.JWT_ACCESS_EXPIRES_IN_MS) || 15 * 60 * 1000);
    trackSession(user._id.toString(), newAccessToken, expiry);
    
    return {
      accessToken: newAccessToken,
      expiresIn: env.JWT_ACCESS_EXPIRES_IN || '15m'
    };
    
  } catch (error) {
    throw new AppError('Invalid or expired refresh token', 401);
  }
}

// ============================================
// Logout Helper
// ============================================

/**
 * Logout user by blacklisting their token and removing session
 * 
 * @param {string} token - JWT token to invalidate
 * @param {string} userId - User ID
 */
async function logout(token, userId) {
  try {
    // Decode token to get expiry
    const decoded = jwt.decode(token);
    const expiry = decoded?.exp ? decoded.exp * 1000 : Date.now() + 86400000;
    
    // Blacklist the token
    blacklistToken(token, expiry);
    
    // Remove from active sessions
    if (userId && activeSessions.has(userId)) {
      const userSessions = activeSessions.get(userId);
      userSessions.delete(token);
      if (userSessions.size === 0) {
        activeSessions.delete(userId);
      }
    }
    
    logger.info('User logged out', { userId, tokenHash: token.substring(0, 10) + '...' });
    
  } catch (error) {
    logger.error('Logout error', { error: error.message });
  }
}

// ============================================
// Exports
// ============================================

module.exports = {
  authenticate,
  authorize,
  optionalAuthenticate,
  hasPermission,
  logout,
  refreshAccessToken,
  blacklistToken,
  isTokenBlacklisted,
  invalidateUserSessions,
  trackSession,
  isSessionValid
};
