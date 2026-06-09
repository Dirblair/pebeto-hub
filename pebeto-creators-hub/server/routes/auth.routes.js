/**
 * Authentication Routes for Pebeto Creator's Hub
 * 
 * Handles user registration, login, email verification, and password reset.
 * 
 * @module routes/auth
 */

const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const User = require('../models/User');
const Wallet = require('../models/Wallet');
const env = require('../config/env');
const { AppError } = require('../utils/errors');
const logger = require('../utils/logger');

const router = express.Router();

// ============================================
// Validation Rules
// ============================================

const registerValidation = [
  body('email')
    .isEmail()
    .withMessage('Please provide a valid email address')
    .normalizeEmail(),
  body('password')
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters long')
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
    .withMessage('Password must contain at least one uppercase letter, one lowercase letter, and one number'),
  body('confirmPassword')
    .notEmpty()
    .withMessage('Please confirm your password')
    .custom((value, { req }) => value === req.body.password)
    .withMessage('Passwords do not match'),
  body('role')
    .isIn(['business', 'creator'])
    .withMessage('Role must be either "business" or "creator"'),
  body('preferredLanguage')
    .optional()
    .isString()
    .isLength({ min: 2, max: 5 }),
  body('preferredCurrency')
    .optional()
    .isIn(['USD', 'KES', 'EUR', 'GBP', 'NGN', 'ZAR', 'GHS'])
    .withMessage('Unsupported currency'),
  
  // Creator-specific validation
  body('profile.stageName')
    .if(body('role').equals('creator'))
    .notEmpty()
    .withMessage('Stage name is required for creators')
    .isLength({ min: 2, max: 50 })
    .withMessage('Stage name must be between 2 and 50 characters'),
  body('profile.niche')
    .if(body('role').equals('creator'))
    .notEmpty()
    .withMessage('Niche is required for creators')
    .isLength({ min: 2, max: 50 }),
  
  // Business-specific validation
  body('profile.companyName')
    .if(body('role').equals('business'))
    .notEmpty()
    .withMessage('Company name is required for businesses')
    .isLength({ min: 2, max: 100 }),
  body('profile.website')
    .if(body('role').equals('business'))
    .optional()
    .isURL()
    .withMessage('Please provide a valid website URL'),
];

const loginValidation = [
  body('email')
    .isEmail()
    .withMessage('Please provide a valid email address')
    .normalizeEmail(),
  body('password')
    .notEmpty()
    .withMessage('Password is required'),
];

const forgotPasswordValidation = [
  body('email')
    .isEmail()
    .withMessage('Please provide a valid email address')
    .normalizeEmail(),
];

const resetPasswordValidation = [
  body('token')
    .notEmpty()
    .withMessage('Reset token is required'),
  body('password')
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters long')
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
    .withMessage('Password must contain at least one uppercase letter, one lowercase letter, and one number'),
  body('confirmPassword')
    .notEmpty()
    .withMessage('Please confirm your password')
    .custom((value, { req }) => value === req.body.password)
    .withMessage('Passwords do not match'),
];

const verifyEmailValidation = [
  body('token')
    .notEmpty()
    .withMessage('Verification token is required'),
];

// ============================================
// Helper Functions
// ============================================

/**
 * Generate JWT access token
 * @param {Object} user - User object
 * @returns {string} JWT token
 */
function generateAccessToken(user) {
  return jwt.sign(
    { 
      userId: user._id, 
      role: user.role,
      tokenVersion: user.tokenVersion || 0
    },
    env.jwtSecret,
    { 
      expiresIn: env.jwtExpiresIn || '7d',
      issuer: env.jwtIssuer || 'pebeto',
      audience: env.jwtAudience || 'pebeto-api'
    }
  );
}

/**
 * Generate unique code for creator
 * @returns {Promise<string>} Unique code
 */
async function generateUniqueCreatorCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code;
  let taken = true;
  
  while (taken) {
    code = '';
    for (let i = 0; i < 8; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    taken = await User.exists({ uniqueCode: code });
  }
  
  return code;
}

/**
 * Send welcome email (placeholder - integrate with email service)
 * @param {Object} user - User object
 * @param {string} verificationToken - Email verification token
 */
async function sendWelcomeEmail(user, verificationToken) {
  const verificationUrl = `${env.clientOrigin}/verify-email?token=${verificationToken}`;
  logger.info(`Welcome email would be sent to ${user.email} with verification URL: ${verificationUrl}`);
  
  // In production, send actual email
  if (env.isProduction) {
    // await emailService.send({
    //   to: user.email,
    //   subject: 'Welcome to Pebeto Creator\'s Hub',
    //   template: 'welcome',
    //   data: { userName: user.displayName, verificationUrl }
    // });
  }
}

// ============================================
// Routes
// ============================================

/**
 * POST /api/auth/register
 * Register a new user (creator or business)
 */
router.post('/register', registerValidation, async (req, res, next) => {
  try {
    // Validate request
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      const firstError = errors.array()[0];
      throw new AppError(firstError.msg, 400);
    }

    const {
      email,
      password,
      role,
      profile = {},
      preferredLanguage = 'en',
      preferredCurrency = 'USD',
    } = req.body;

    // Check if user already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      throw new AppError('Email already registered. Please log in instead.', 400);
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 12);

    // Prepare user data
    const userData = {
      email,
      passwordHash,
      role,
      profile: {
        ...profile,
        displayName: role === 'creator' ? profile.stageName : profile.companyName,
      },
      preferredLanguage,
      preferredCurrency,
      status: 'active', // Set to active directly (skip email verification for now)
      emailVerified: true, // Skip email verification for now
    };

    // Generate unique code for creators
    if (role === 'creator') {
      userData.uniqueCode = await generateUniqueCreatorCode();
    }

    // Create user
    const user = await User.create(userData);

    // Create wallet for user
    await Wallet.create({ userId: user._id, walletType: 'standard', currency: 'USD' });

    // Generate access token
    const accessToken = generateAccessToken(user);

    // Log registration
    logger.info('New user registered', {
      userId: user._id,
      email: user.email,
      role: user.role,
      uniqueCode: user.uniqueCode
    });

    // Return response (without sensitive data)
    res.status(201).json({
      success: true,
      message: 'Registration successful!',
      data: {
        token: accessToken,
        user: {
          id: user._id,
          email: user.email,
          role: user.role,
          uniqueCode: user.uniqueCode,
          profile: user.profile,
          preferredCurrency: user.preferredCurrency,
          preferredLanguage: user.preferredLanguage,
          emailVerified: user.emailVerified,
          status: user.status,
        },
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/login
 * Login existing user
 */
router.post('/login', loginValidation, async (req, res, next) => {
  try {
    // Validate request
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new AppError('Invalid credentials', 401);
    }

    const { email, password } = req.body;
    const clientIp = req.ip || req.connection?.remoteAddress;

    // Find user with password hash - CRITICAL FIX: Use .findOne() correctly
    const user = await User.findOne({ email });
    
    if (!user) {
      throw new AppError('Invalid email or password', 401);
    }

    // Verify password
    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);
    if (!isPasswordValid) {
      throw new AppError('Invalid email or password', 401);
    }

    // Check account status
    if (user.status !== 'active') {
      let message = 'Your account is not active. ';
      if (user.status === 'suspended') {
        message += 'Your account has been suspended. Please contact support.';
      } else if (user.status === 'banned') {
        message += 'Your account has been permanently banned.';
      }
      throw new AppError(message, 403);
    }

    // Update last login
    user.lastLoginAt = new Date();
    user.lastLoginIp = clientIp;
    await user.save();

    // Generate access token
    const accessToken = generateAccessToken(user);

    // Log successful login
    logger.info('User logged in', {
      userId: user._id,
      email: user.email,
      role: user.role,
      ip: clientIp
    });

    // Return response
    res.json({
      success: true,
      token: accessToken,
      user: {
        id: user._id,
        email: user.email,
        role: user.role,
        uniqueCode: user.uniqueCode,
        profile: user.profile,
        preferredCurrency: user.preferredCurrency,
        preferredLanguage: user.preferredLanguage,
        emailVerified: user.emailVerified,
        status: user.status,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/verify-email
 * Verify user's email address
 */
router.post('/verify-email', verifyEmailValidation, async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new AppError('Invalid verification token', 400);
    }

    const { token } = req.body;

    // Find user by verification token
    const user = await User.findOne({
      emailVerificationToken: token,
      emailVerificationExpires: { $gt: new Date() }
    });

    if (!user) {
      throw new AppError('Invalid or expired verification token', 400);
    }

    // Verify email
    user.emailVerified = true;
    user.emailVerificationToken = null;
    user.emailVerificationExpires = null;
    if (user.status === 'pending') {
      user.status = 'active';
    }
    await user.save();

    logger.info('Email verified', { userId: user._id, email: user.email });

    res.json({
      success: true,
      message: 'Email verified successfully. You can now log in.',
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/resend-verification
 * Resend email verification link
 */
router.post('/resend-verification', [
  body('email').isEmail().normalizeEmail(),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new AppError('Please provide a valid email address', 400);
    }

    const { email } = req.body;

    const user = await User.findOne({ email });
    if (!user) {
      // Don't reveal that user doesn't exist for security
      return res.json({
        success: true,
        message: 'If an account with that email exists, a verification link has been sent.',
      });
    }

    if (user.emailVerified) {
      return res.json({
        success: true,
        message: 'Email is already verified. You can log in.',
      });
    }

    // Generate new verification token
    const verificationToken = require('crypto').randomBytes(32).toString('hex');
    user.emailVerificationToken = verificationToken;
    user.emailVerificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await user.save();

    // Send verification email
    await sendWelcomeEmail(user, verificationToken);

    res.json({
      success: true,
      message: 'Verification link sent. Please check your inbox.',
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/forgot-password
 * Send password reset link
 */
router.post('/forgot-password', forgotPasswordValidation, async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new AppError('Please provide a valid email address', 400);
    }

    const { email } = req.body;

    const user = await User.findOne({ email });
    if (!user) {
      // Don't reveal that user doesn't exist for security
      return res.json({
        success: true,
        message: 'If an account with that email exists, a password reset link has been sent.',
      });
    }

    // Generate reset token
    const resetToken = require('crypto').randomBytes(32).toString('hex');
    user.resetPasswordToken = resetToken;
    user.resetPasswordExpires = new Date(Date.now() + 1 * 60 * 60 * 1000);
    await user.save();

    // Send reset email
    const resetUrl = `${env.clientOrigin}/reset-password?token=${resetToken}`;
    logger.info(`Password reset link for ${user.email}: ${resetUrl}`);

    res.json({
      success: true,
      message: 'If an account with that email exists, a password reset link has been sent.',
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/reset-password
 * Reset password using token
 */
router.post('/reset-password', resetPasswordValidation, async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new AppError(errors.array()[0].msg, 400);
    }

    const { token, password } = req.body;

    // Find user by reset token
    const user = await User.findOne({
      resetPasswordToken: token,
      resetPasswordExpires: { $gt: new Date() }
    });

    if (!user) {
      throw new AppError('Invalid or expired reset token', 400);
    }

    // Hash new password
    const passwordHash = await bcrypt.hash(password, 12);
    user.passwordHash = passwordHash;
    user.resetPasswordToken = null;
    user.resetPasswordExpires = null;
    user.tokenVersion += 1; // Invalidate all existing sessions
    
    await user.save();

    logger.info('Password reset successful', { userId: user._id, email: user.email });

    res.json({
      success: true,
      message: 'Password reset successful. You can now log in with your new password.',
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/logout
 * Logout user
 */
router.post('/logout', async (req, res, next) => {
  try {
    res.json({
      success: true,
      message: 'Logged out successfully',
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/auth/me
 * Get current authenticated user
 */
router.get('/me', async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new AppError('Not authenticated', 401);
    }

    const token = authHeader.split(' ')[1];
    let decoded;
    try {
      decoded = jwt.verify(token, env.jwtSecret);
    } catch (err) {
      throw new AppError('Invalid token', 401);
    }

    const user = await User.findById(decoded.userId)
      .select('-passwordHash -resetPasswordToken -emailVerificationToken');

    if (!user) {
      throw new AppError('User not found', 404);
    }

    res.json({
      success: true,
      data: {
        user: {
          id: user._id,
          email: user.email,
          role: user.role,
          uniqueCode: user.uniqueCode,
          profile: user.profile,
          preferredCurrency: user.preferredCurrency,
          preferredLanguage: user.preferredLanguage,
          emailVerified: user.emailVerified,
          status: user.status,
        },
      },
    });
  } catch (err) {
    next(err);
  }
});

// ============================================
// Exports
// ============================================

module.exports = router;
