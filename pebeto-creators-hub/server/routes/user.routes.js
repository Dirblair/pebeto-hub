/**
 * User Routes for Pebeto Creator's Hub
 * 
 * Handles user profile, activity log, sessions, 2FA, API keys, and notification preferences.
 * 
 * @module routes/user
 */

const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const { authenticate, authorize } = require('../middleware/auth');
const { AppError } = require('../utils/errors');
const { catchAsync } = require('../middleware/errorHandler');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const logger = require('../utils/logger');
const crypto = require('crypto');

const router = express.Router();

// ============================================
// Middleware
// ============================================

router.use(authenticate);

// ============================================
// Activity Log
// ============================================

/**
 * GET /api/user/activity
 * Get user's activity log (login attempts, actions)
 */
router.get('/activity', catchAsync(async (req, res) => {
  const { limit = 50, page = 1 } = req.query;
  const skip = (parseInt(page) - 1) * parseInt(limit);
  const effectiveLimit = Math.min(parseInt(limit), 100);
  
  const user = await User.findById(req.user._id).select('loginAttempts');
  
  if (!user) {
    throw new AppError('User not found', 404);
  }
  
  const activities = (user.loginAttempts || []).reverse();
  const paginatedActivities = activities.slice(skip, skip + effectiveLimit);
  
  // Also get campaign-related activities from transactions
  const campaignActivities = await Transaction.find({
    $or: [{ fromUserId: req.user._id }, { toUserId: req.user._id }],
    type: { $in: ['deposit', 'withdrawal', 'tip', 'escrow_release'] }
  })
    .sort({ createdAt: -1 })
    .limit(parseInt(limit))
    .lean();
  
  // Format activities
  const formattedActivities = [
    ...paginatedActivities.map(a => ({
      action: a.success ? `Login successful from ${a.ipAddress || 'unknown IP'}` : `Failed login attempt from ${a.ipAddress || 'unknown IP'}`,
      ipAddress: a.ipAddress,
      device: a.userAgent,
      createdAt: a.timestamp,
      type: 'login'
    })),
    ...campaignActivities.map(t => ({
      action: `${t.type === 'deposit' ? 'Deposit' : t.type === 'withdrawal' ? 'Withdrawal' : t.type === 'tip' ? 'Tip sent' : 'Campaign payment'} of $${t.grossAmount}`,
      ipAddress: t.metadata?.ipAddress,
      device: t.metadata?.userAgent,
      createdAt: t.createdAt,
      type: 'transaction'
    }))
  ];
  
  // Sort by date (newest first)
  formattedActivities.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  
  res.json({
    success: true,
    data: {
      activities: formattedActivities.slice(0, effectiveLimit),
      pagination: {
        page: parseInt(page),
        limit: effectiveLimit,
        total: activities.length + campaignActivities.length,
        hasMore: formattedActivities.length > effectiveLimit
      }
    }
  });
}));

// ============================================
// User Sessions
// ============================================

/**
 * GET /api/user/sessions
 * Get user's active sessions
 */
router.get('/sessions', catchAsync(async (req, res) => {
  // Get all sessions from the session store
  // Since we're using JWT, we'll track sessions in the user document
  
  const user = await User.findById(req.user._id).select('loginAttempts lastLoginAt lastLoginIp');
  
  // Get recent successful logins (last 30 days)
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  
  const recentSessions = (user.loginAttempts || [])
    .filter(a => a.success && new Date(a.timestamp) > thirtyDaysAgo)
    .map(a => ({
      device: a.userAgent || 'Unknown device',
      ipAddress: a.ipAddress,
      lastActive: a.timestamp,
      isCurrent: a.timestamp === user.lastLoginAt
    }));
  
  // Add current session info
  const currentSession = {
    device: req.headers['user-agent'] || 'Unknown device',
    ipAddress: req.ip || req.connection?.remoteAddress,
    lastActive: new Date(),
    isCurrent: true
  };
  
  res.json({
    success: true,
    data: {
      sessions: [currentSession, ...recentSessions],
      currentSession: currentSession,
      totalActiveSessions: recentSessions.length + 1
    }
  });
}));

/**
 * DELETE /api/user/sessions/revoke
 * Revoke all other sessions (logout from other devices)
 */
router.post('/sessions/revoke', catchAsync(async (req, res) => {
  // Increment token version to invalidate all existing tokens
  const user = await User.findById(req.user._id);
  if (user) {
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();
    logger.info(`User ${req.user._id} revoked all other sessions`);
  }
  
  res.json({
    success: true,
    message: 'All other sessions have been revoked. Please log in again on other devices.'
  });
}));

// ============================================
// Two-Factor Authentication (2FA)
// ============================================

const speakeasy = require('speakeasy');
const QRCode = require('qrcode');

/**
 * POST /api/user/2fa/setup
 * Setup 2FA for user account
 */
router.post('/2fa/setup', catchAsync(async (req, res) => {
  const user = await User.findById(req.user._id);
  
  if (!user) {
    throw new AppError('User not found', 404);
  }
  
  if (user.twoFactorEnabled) {
    throw new AppError('2FA is already enabled for this account', 400);
  }
  
  // Generate secret
  const secret = speakeasy.generateSecret({
    name: `Pebeto:${user.email}`,
    length: 20
  });
  
  // Store secret temporarily (will be confirmed on verification)
  user.twoFactorSecret = secret.base32;
  await user.save();
  
  // Generate QR code
  const otpauthUrl = secret.otpauth_url;
  const qrCode = await QRCode.toDataURL(otpauthUrl);
  
  res.json({
    success: true,
    data: {
      secret: secret.base32,
      qrCode,
      otpauthUrl
    }
  });
}));

/**
 * POST /api/user/2fa/verify
 * Verify and enable 2FA
 */
router.post('/2fa/verify', [
  body('code').isLength({ min: 6, max: 6 }).withMessage('6-digit code is required')
], catchAsync(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    throw new AppError(errors.array()[0].msg, 400);
  }
  
  const { code } = req.body;
  const user = await User.findById(req.user._id);
  
  if (!user) {
    throw new AppError('User not found', 404);
  }
  
  if (!user.twoFactorSecret) {
    throw new AppError('2FA not initialized. Please setup 2FA first.', 400);
  }
  
  // Verify the code
  const verified = speakeasy.totp.verify({
    secret: user.twoFactorSecret,
    encoding: 'base32',
    token: code
  });
  
  if (!verified) {
    throw new AppError('Invalid verification code', 400);
  }
  
  // Enable 2FA
  user.twoFactorEnabled = true;
  await user.save();
  
  logger.info(`2FA enabled for user ${req.user._id}`);
  
  res.json({
    success: true,
    message: 'Two-factor authentication has been enabled successfully'
  });
}));

/**
 * POST /api/user/2fa/disable
 * Disable 2FA for user account
 */
router.post('/2fa/disable', [
  body('code').isLength({ min: 6, max: 6 }).withMessage('6-digit code is required')
], catchAsync(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    throw new AppError(errors.array()[0].msg, 400);
  }
  
  const { code } = req.body;
  const user = await User.findById(req.user._id);
  
  if (!user) {
    throw new AppError('User not found', 404);
  }
  
  if (!user.twoFactorEnabled) {
    throw new AppError('2FA is not enabled for this account', 400);
  }
  
  // Verify the code before disabling
  const verified = speakeasy.totp.verify({
    secret: user.twoFactorSecret,
    encoding: 'base32',
    token: code
  });
  
  if (!verified) {
    throw new AppError('Invalid verification code', 400);
  }
  
  // Disable 2FA
  user.twoFactorEnabled = false;
  user.twoFactorSecret = null;
  await user.save();
  
  logger.info(`2FA disabled for user ${req.user._id}`);
  
  res.json({
    success: true,
    message: 'Two-factor authentication has been disabled'
  });
}));

/**
 * POST /api/user/2fa/verify-login
 * Verify 2FA code during login (separate endpoint for login flow)
 */
router.post('/2fa/verify-login', [
  body('userId').isMongoId().withMessage('Invalid user ID'),
  body('code').isLength({ min: 6, max: 6 }).withMessage('6-digit code is required')
], catchAsync(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    throw new AppError(errors.array()[0].msg, 400);
  }
  
  const { userId, code } = req.body;
  const user = await User.findById(userId).select('+twoFactorSecret twoFactorEnabled');
  
  if (!user) {
    throw new AppError('User not found', 404);
  }
  
  if (!user.twoFactorEnabled) {
    throw new AppError('2FA is not enabled for this account', 400);
  }
  
  const verified = speakeasy.totp.verify({
    secret: user.twoFactorSecret,
    encoding: 'base32',
    token: code
  });
  
  if (!verified) {
    throw new AppError('Invalid verification code', 400);
  }
  
  // Generate temporary token for 2FA verification
  const jwt = require('jsonwebtoken');
  const env = require('../config/env');
  const twoFactorToken = jwt.sign(
    { userId: user._id, twoFactorVerified: true },
    env.jwtSecret,
    { expiresIn: '15m' }
  );
  
  res.json({
    success: true,
    twoFactorToken
  });
}));

// ============================================
// API Keys
// ============================================

/**
 * GET /api/user/api-keys
 * Get user's API keys
 */
router.get('/api-keys', catchAsync(async (req, res) => {
  const user = await User.findById(req.user._id).select('apiKeys');
  
  const apiKeys = user.apiKeys || [];
  
  // Mask the keys for security
  const maskedKeys = apiKeys.map(key => ({
    id: key.id,
    name: key.name,
    key: key.key.substring(0, 8) + '...' + key.key.substring(key.key.length - 8),
    createdAt: key.createdAt,
    lastUsedAt: key.lastUsedAt,
    isActive: key.isActive
  }));
  
  res.json({
    success: true,
    data: {
      apiKeys: maskedKeys
    }
  });
}));

/**
 * POST /api/user/api-keys
 * Create a new API key
 */
router.post('/api-keys', [
  body('name').optional().isString().trim().isLength({ max: 50 })
], catchAsync(async (req, res) => {
  const { name = 'Default API Key' } = req.body;
  
  const user = await User.findById(req.user._id);
  
  if (!user) {
    throw new AppError('User not found', 404);
  }
  
  // Generate a secure API key
  const apiKey = `pbt_${crypto.randomBytes(32).toString('hex')}`;
  const keyId = crypto.randomBytes(8).toString('hex');
  
  if (!user.apiKeys) {
    user.apiKeys = [];
  }
  
  user.apiKeys.push({
    id: keyId,
    name,
    key: apiKey,
    createdAt: new Date(),
    isActive: true
  });
  
  await user.save();
  
  logger.info(`New API key created for user ${req.user._id}`);
  
  res.json({
    success: true,
    data: {
      id: keyId,
      name,
      key: apiKey,  // Only shown once!
      createdAt: new Date()
    },
    message: 'Copy your API key now. It will not be shown again.'
  });
}));

/**
 * DELETE /api/user/api-keys/:keyId
 * Revoke/Delete an API key
 */
router.delete('/api-keys/:keyId', [
  param('keyId').isString().withMessage('Invalid key ID')
], catchAsync(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    throw new AppError(errors.array()[0].msg, 400);
  }
  
  const { keyId } = req.params;
  const user = await User.findById(req.user._id);
  
  if (!user) {
    throw new AppError('User not found', 404);
  }
  
  if (!user.apiKeys) {
    throw new AppError('No API keys found', 404);
  }
  
  const keyIndex = user.apiKeys.findIndex(k => k.id === keyId);
  if (keyIndex === -1) {
    throw new AppError('API key not found', 404);
  }
  
  user.apiKeys.splice(keyIndex, 1);
  await user.save();
  
  logger.info(`API key revoked for user ${req.user._id}`);
  
  res.json({
    success: true,
    message: 'API key revoked successfully'
  });
}));

/**
 * POST /api/user/api-keys/:keyId/regenerate
 * Regenerate an API key
 */
router.post('/api-keys/:keyId/regenerate', [
  param('keyId').isString().withMessage('Invalid key ID')
], catchAsync(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    throw new AppError(errors.array()[0].msg, 400);
  }
  
  const { keyId } = req.params;
  const user = await User.findById(req.user._id);
  
  if (!user) {
    throw new AppError('User not found', 404);
  }
  
  if (!user.apiKeys) {
    throw new AppError('No API keys found', 404);
  }
  
  const keyIndex = user.apiKeys.findIndex(k => k.id === keyId);
  if (keyIndex === -1) {
    throw new AppError('API key not found', 404);
  }
  
  // Generate new key
  const newApiKey = `pbt_${crypto.randomBytes(32).toString('hex')}`;
  user.apiKeys[keyIndex].key = newApiKey;
  user.apiKeys[keyIndex].regeneratedAt = new Date();
  user.apiKeys[keyIndex].lastUsedAt = null;
  
  await user.save();
  
  logger.info(`API key regenerated for user ${req.user._id}`);
  
  res.json({
    success: true,
    data: {
      id: keyId,
      name: user.apiKeys[keyIndex].name,
      key: newApiKey,  // Only shown once!
      regeneratedAt: new Date()
    },
    message: 'API key regenerated successfully. Copy your new key now.'
  });
}));

// ============================================
// ============================================
// NEW: Email Notification Preferences
// ============================================
// ============================================

/**
 * GET /api/user/notification-preferences
 * Get user's notification preferences
 */
router.get('/notification-preferences', catchAsync(async (req, res) => {
  const user = await User.findById(req.user._id).select('notificationPreferences');
  
  const defaultPreferences = {
    emailOnLogin: true,
    emailOnTip: true,
    emailOnBidAccepted: true,
    emailOnCampaignUpdate: true,
    emailOnWithdrawal: true,
    pushOnTip: true,
    pushOnMessage: true
  };
  
  const preferences = user.notificationPreferences || defaultPreferences;
  
  res.json({
    success: true,
    data: preferences
  });
}));

/**
 * PUT /api/user/notification-preferences
 * Update notification preferences
 */
router.put('/notification-preferences', [
  body('emailOnLogin').optional().isBoolean(),
  body('emailOnTip').optional().isBoolean(),
  body('emailOnBidAccepted').optional().isBoolean(),
  body('emailOnCampaignUpdate').optional().isBoolean(),
  body('emailOnWithdrawal').optional().isBoolean(),
  body('pushOnTip').optional().isBoolean(),
  body('pushOnMessage').optional().isBoolean()
], catchAsync(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    throw new AppError(errors.array()[0].msg, 400);
  }
  
  const user = await User.findById(req.user._id);
  
  if (!user) {
    throw new AppError('User not found', 404);
  }
  
  if (!user.notificationPreferences) {
    user.notificationPreferences = {};
  }
  
  // Update only the fields provided
  Object.keys(req.body).forEach(key => {
    if (typeof req.body[key] === 'boolean') {
      user.notificationPreferences[key] = req.body[key];
    }
  });
  
  await user.save();
  
  logger.info(`Notification preferences updated for user ${req.user._id}`);
  
  res.json({
    success: true,
    message: 'Notification preferences updated',
    data: user.notificationPreferences
  });
}));

// ============================================
// Avatar Upload
// ============================================

/**
 * POST /api/user/avatar
 * Upload user avatar
 */
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const streamifier = require('streamifier');

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const upload = multer({ storage: multer.memoryStorage() });

router.post('/avatar', upload.single('avatar'), catchAsync(async (req, res) => {
  if (!req.file) {
    throw new AppError('No file uploaded', 400);
  }
  
  const file = req.file;
  
  // Upload to Cloudinary
  const uploadResult = await new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: 'pebeto/avatars',
        transformation: [{ width: 500, height: 500, crop: 'fill' }]
      },
      (error, result) => {
        if (error) reject(error);
        else resolve(result);
      }
    );
    streamifier.createReadStream(file.buffer).pipe(uploadStream);
  });
  
  // Update user profile
  const user = await User.findById(req.user._id);
  if (!user.profile) user.profile = {};
  user.profile.avatarUrl = uploadResult.secure_url;
  await user.save();
  
  logger.info(`Avatar updated for user ${req.user._id}`);
  
  res.json({
    success: true,
    data: {
      avatarUrl: uploadResult.secure_url
    },
    message: 'Profile picture updated successfully'
  });
}));

// ============================================
// Exports
// ============================================

module.exports = router;
