const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { body, query, validationResult } = require('express-validator');
const User = require('../models/User');
const Wallet = require('../models/Wallet');
const env = require('../config/env');
const { sendVerificationEmail, sendPasswordResetEmail, sendLoginAlertEmail } = require('../services/emailService');
const { catchAsync, AppError } = require('../middleware/errorHandler');

const router = express.Router();

// ============================================
// Validation Helpers
// ============================================

const validateEmail = body('email').isEmail().withMessage('Valid email required');
const validatePassword = body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters');

// ============================================
// REGISTER
// ============================================
router.post('/register', async (req, res) => {
  console.log('📝 REGISTER:', req.body.email);
  
  try {
    const { email, password, role, profile } = req.body;
    
    if (!email || !password || !role) {
      return res.status(400).json({ success: false, message: 'Email, password, and role required' });
    }
    
    const existing = await User.findOne({ email });
    if (existing) {
      return res.status(400).json({ success: false, message: 'Email already registered' });
    }
    
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);
    
    const user = await User.create({
      email,
      passwordHash,
      role,
      profile: profile || {},
      status: 'pending',
      emailVerified: false
    });
    
    // Create wallet
    try {
      await Wallet.create({
        userId: user._id,
        walletType: 'standard',
        currency: 'USD',
        balances: { available: 0, escrow: 0, tips: 0, pending: 0 }
      });
      console.log('✅ Wallet created for:', email);
    } catch (err) {
      console.log('⚠️ Wallet note:', err.message);
    }
    
    // Generate and send verification email
    const verificationToken = user.generateEmailVerificationToken();
    await user.save();
    
    const verificationUrl = `${process.env.CLIENT_ORIGIN || 'https://pebeto.com'}/verify-email?token=${verificationToken}&id=${user._id}`;
    await sendVerificationEmail(user.email, verificationUrl);
    
    // Don't send token until email is verified
    res.json({
      success: true,
      message: 'Registration successful! Please check your email to verify your account.',
      requiresVerification: true
    });
    
  } catch (err) {
    console.error('REGISTER ERROR:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================
// LOGIN
// ============================================
router.post('/login', async (req, res) => {
  console.log('📝 LOGIN:', req.body.email);
  
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password required' });
    }
    
    const user = await User.findOne({ email }).select('+passwordHash');
    
    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
    
    // Check if email is verified
    if (!user.emailVerified) {
      return res.status(401).json({ 
        success: false, 
        message: 'Please verify your email before logging in. Check your inbox for the verification link.',
        requiresVerification: true
      });
    }
    
    // Check if account is locked
    if (user.isLocked) {
      return res.status(401).json({ 
        success: false, 
        message: 'Account is temporarily locked due to too many failed attempts. Please try again later.' 
      });
    }
    
    if (!user.passwordHash) {
      console.error('❌ No passwordHash found for user:', email);
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
    
    const isValid = await bcrypt.compare(password, user.passwordHash);
    if (!isValid) {
      await user.recordFailedLogin({ ipAddress: req.ip, userAgent: req.headers['user-agent'] });
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
    
    // Send login alert if enabled
    if (user.notificationPreferences?.emailOnLogin !== false) {
      await sendLoginAlertEmail(user.email, {
        time: new Date().toLocaleString(),
        device: req.headers['user-agent'],
        location: req.ip,
        resetUrl: `${process.env.CLIENT_ORIGIN || 'https://pebeto.com'}/forgot-password`
      });
    }
    
    await user.recordSuccessfulLogin({ ipAddress: req.ip, userAgent: req.headers['user-agent'] });
    
    const token = jwt.sign(
      { userId: user._id, role: user.role, tokenVersion: user.tokenVersion },
      env.jwtSecret,
      { expiresIn: '30d' }
    );
    
    console.log('✅ LOGIN SUCCESS:', email);
    
    res.json({
      success: true,
      token,
      user: {
        id: user._id,
        email: user.email,
        role: user.role,
        profile: user.profile,
        emailVerified: user.emailVerified
      }
    });
    
  } catch (err) {
    console.error('LOGIN ERROR:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================
// Email Verification
// ============================================

/**
 * POST /api/auth/verify-email/resend
 * Resend verification email
 */
router.post('/verify-email/resend', [
  body('email').isEmail().withMessage('Valid email required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg });
    }

    const { email } = req.body;
    const user = await User.findOne({ email });

    if (!user) {
      return res.json({
        success: true,
        message: 'If an account exists, a verification email has been sent.'
      });
    }

    if (user.emailVerified) {
      return res.status(400).json({ success: false, message: 'Email already verified' });
    }

    const verificationToken = user.generateEmailVerificationToken();
    await user.save();

    const verificationUrl = `${process.env.CLIENT_ORIGIN || 'https://pebeto.com'}/verify-email?token=${verificationToken}&id=${user._id}`;
    await sendVerificationEmail(user.email, verificationUrl);

    res.json({
      success: true,
      message: 'Verification email sent. Please check your inbox.'
    });
  } catch (err) {
    console.error('Resend verification error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/auth/verify-email
 * Verify email with token
 */
router.get('/verify-email', [
  query('token').notEmpty().withMessage('Verification token required'),
  query('id').isMongoId().withMessage('Invalid user ID')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg });
    }

    const { token, id } = req.query;
    const user = await User.findById(id);

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    if (user.emailVerified) {
      return res.json({
        success: true,
        message: 'Email already verified. You can now log in.'
      });
    }

    const verified = await user.verifyEmail(token);

    if (!verified) {
      return res.status(400).json({ success: false, message: 'Invalid or expired verification token' });
    }

    res.json({
      success: true,
      message: 'Email verified successfully! You can now log in.'
    });
  } catch (err) {
    console.error('Verify email error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================
// Password Reset Flow
// ============================================

/**
 * POST /api/auth/forgot-password
 * Request password reset
 */
router.post('/forgot-password', [
  body('email').isEmail().withMessage('Valid email required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg });
    }

    const { email } = req.body;
    const user = await User.findOne({ email });

    // For security, always return success even if user not found
    if (!user) {
      return res.json({
        success: true,
        message: 'If an account exists with that email, you will receive a password reset link.'
      });
    }

    const resetToken = user.generatePasswordResetToken();
    await user.save();

    const resetUrl = `${process.env.CLIENT_ORIGIN || 'https://pebeto.com'}/reset-password?token=${resetToken}`;
    await sendPasswordResetEmail(user.email, resetUrl);

    res.json({
      success: true,
      message: 'Password reset email sent. Please check your inbox.'
    });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/auth/reset-password
 * Reset password with token
 */
router.post('/reset-password', [
  body('token').notEmpty().withMessage('Reset token required'),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  body('confirmPassword').custom((value, { req }) => {
    if (value !== req.body.password) {
      throw new Error('Passwords do not match');
    }
    return true;
  })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg });
    }

    const { token, password } = req.body;
    const user = await User.findOne({
      resetPasswordToken: token,
      resetPasswordExpires: { $gt: new Date() }
    });

    if (!user) {
      return res.status(400).json({ success: false, message: 'Invalid or expired reset token' });
    }

    const salt = await bcrypt.genSalt(10);
    user.passwordHash = await bcrypt.hash(password, salt);
    user.resetPasswordToken = null;
    user.resetPasswordExpires = null;
    user.tokenVersion += 1; // Invalidate all existing sessions

    await user.save();

    res.json({
      success: true,
      message: 'Password reset successfully. You can now log in with your new password.'
    });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================
// Test Endpoint
// ============================================
router.get('/test', (req, res) => {
  res.json({ success: true, message: 'Auth working!' });
});

module.exports = router;
