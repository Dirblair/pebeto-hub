/**
 * Rate Limiting Middleware for Pebeto Creator's Hub
 * 
 * Configures rate limits for different API endpoints:
 * - Public API: 100 requests per minute
 * - Authenticated API: 200 requests per minute
 * - Auth endpoints (login/register): 10 attempts per 15 minutes
 * - Campaign creation: 10 campaigns per hour
 * - Bidding: 50 bids per hour
 * - Withdrawals: 5 requests per day
 * 
 * @module middleware/rateLimit
 */

const rateLimit = require('express-rate-limit');

// ============================================
// General Rate Limits
// ============================================

/**
 * Default rate limit for public endpoints
 * 100 requests per minute
 */
const publicLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100,
  message: {
    success: false,
    message: 'Too many requests. Please try again later.',
    error: 'RATE_LIMIT_EXCEEDED'
  },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false,
});

/**
 * Rate limit for authenticated API endpoints
 * 200 requests per minute
 */
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 200,
  message: {
    success: false,
    message: 'Too many requests. Please slow down.',
    error: 'RATE_LIMIT_EXCEEDED'
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?._id?.toString() || req.ip,
});

/**
 * Strict rate limit for authentication endpoints (login, register)
 * 10 attempts per 15 minutes
 */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  message: {
    success: false,
    message: 'Too many login attempts. Please try again after 15 minutes.',
    error: 'RATE_LIMIT_EXCEEDED'
  },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
});

// ============================================
// Feature-Specific Rate Limits
// ============================================

/**
 * Campaign creation rate limit
 * 10 campaigns per hour per user
 */
const campaignCreationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  message: {
    success: false,
    message: 'Campaign creation limit reached. Please wait before creating more campaigns.',
    error: 'RATE_LIMIT_EXCEEDED'
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?._id?.toString() || req.ip,
});

/**
 * Bidding rate limit
 * 50 bids per hour per user
 */
const biddingLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 50,
  message: {
    success: false,
    message: 'Bid limit reached. Please wait before placing more bids.',
    error: 'RATE_LIMIT_EXCEEDED'
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?._id?.toString() || req.ip,
});

/**
 * Deposit rate limit
 * 20 deposit attempts per hour per user
 */
const depositLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20,
  message: {
    success: false,
    message: 'Deposit limit reached. Please try again later.',
    error: 'RATE_LIMIT_EXCEEDED'
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?._id?.toString() || req.ip,
});

/**
 * Withdrawal rate limit
 * 5 withdrawal requests per day per user
 */
const withdrawalLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 5,
  message: {
    success: false,
    message: 'Withdrawal limit reached (5 per day). Please try again tomorrow.',
    error: 'RATE_LIMIT_EXCEEDED'
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?._id?.toString() || req.ip,
});

/**
 * Tip rate limit
 * 30 tips per hour per user
 */
const tipLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 30,
  message: {
    success: false,
    message: 'Tip limit reached. Please wait before sending more tips.',
    error: 'RATE_LIMIT_EXCEEDED'
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?._id?.toString() || req.ip,
});

/**
 * Comment rate limit
 * 50 comments per hour per user
 */
const commentLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 50,
  message: {
    success: false,
    message: 'Comment limit reached. Please wait before posting more comments.',
    error: 'RATE_LIMIT_EXCEEDED'
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?._id?.toString() || req.ip,
});

/**
 * Like rate limit
 * 100 likes per hour per user
 */
const likeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 100,
  message: {
    success: false,
    message: 'Like limit reached. Please slow down.',
    error: 'RATE_LIMIT_EXCEEDED'
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?._id?.toString() || req.ip,
});

/**
 * Admin API rate limit
 * 100 requests per minute (stricter for admin operations)
 */
const adminLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100,
  message: {
    success: false,
    message: 'Too many admin requests. Please try again later.',
    error: 'RATE_LIMIT_EXCEEDED'
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?._id?.toString() || req.ip,
});

// ============================================
// Exports
// ============================================

module.exports = {
  // General limiters
  publicLimiter,
  apiLimiter,
  authLimiter,
  adminLimiter,
  
  // Feature-specific limiters
  campaignCreationLimiter,
  biddingLimiter,
  depositLimiter,
  withdrawalLimiter,
  tipLimiter,
  commentLimiter,
  likeLimiter,
};
