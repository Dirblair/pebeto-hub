const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const User = require('../models/User');
const Wallet = require('../models/Wallet');
const env = require('../config/env');
const { AppError } = require('../utils/errors');

const router = express.Router();

// ============================================
// LOGIN ROUTE
// ============================================
router.post('/login', async (req, res) => {
  console.log('📝 [LOGIN] Attempt for email:', req.body.email);
  
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password required' });
    }
    
    // Find user - now User.findOne works correctly
    const user = await User.findOne({ email });
    console.log('👤 [LOGIN] User found:', user ? 'Yes' : 'No');
    
    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }
    
    // Check password
    const valid = await bcrypt.compare(password, user.passwordHash);
    console.log('🔐 [LOGIN] Password valid:', valid);
    
    if (!valid) {
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }
    
    // Check account status
    if (user.status !== 'active') {
      return res.status(403).json({ success: false, message: 'Account is not active. Please contact support.' });
    }
    
    // Update last login
    user.lastLoginAt = new Date();
    user.lastLoginIp = req.ip || req.connection?.remoteAddress;
    await user.save();
    
    // Create token
    const token = jwt.sign(
      { userId: user._id, role: user.role },
      env.jwtSecret,
      { expiresIn: '7d' }
    );
    
    console.log('✅ [LOGIN] Success for:', email);
    
    res.json({
      success: true,
      token,
      user: {
        id: user._id,
        email: user.email,
        role: user.role,
        uniqueCode: user.uniqueCode,
        profile: user.profile,
        emailVerified: user.emailVerified,
        status: user.status
      }
    });
    
  } catch (err) {
    console.error('❌ [LOGIN] Error:', err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
});

// ============================================
// REGISTER ROUTE
// ============================================
router.post('/register', async (req, res) => {
  console.log('📝 [REGISTER] Attempt for email:', req.body.email);
  
  try {
    const { email, password, role, profile } = req.body;
    
    if (!email || !password || !role) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }
    
    // Check if user exists
    const existing = await User.findOne({ email });
    if (existing) {
      return res.status(400).json({ success: false, message: 'Email already registered' });
    }
    
    // Hash password
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);
    
    // Create user
    const user = await User.create({
      email,
      passwordHash,
      role,
      profile: profile || {},
      status: 'active',
      emailVerified: true,
      createdAt: new Date()
    });
    
    console.log('✅ [REGISTER] User created:', user._id);
    
    // Create wallet for user
    await Wallet.create({
      userId: user._id,
      walletType: 'standard',
      currency: 'USD',
      balances: { available: 0, escrow: 0, tips: 0, pending: 0 }
    });
    
    console.log('✅ [REGISTER] Wallet created for user:', user._id);
    
    // Create token
    const token = jwt.sign(
      { userId: user._id, role: user.role },
      env.jwtSecret,
      { expiresIn: '7d' }
    );
    
    res.status(201).json({
      success: true,
      token,
      user: {
        id: user._id,
        email: user.email,
        role: user.role,
        uniqueCode: user.uniqueCode,
        profile: user.profile,
        emailVerified: user.emailVerified,
        status: user.status
      }
    });
    
  } catch (err) {
    console.error('❌ [REGISTER] Error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================
// TEST ROUTE - Check if server is working
// ============================================
router.get('/test', (req, res) => {
  res.json({ success: true, message: 'Auth routes are working!' });
});

// ============================================
// GET CURRENT USER (from token)
// ============================================
router.get('/me', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ success: false, message: 'No token provided' });
    }
    
    const decoded = jwt.verify(token, env.jwtSecret);
    const user = await User.findById(decoded.userId).select('-passwordHash');
    
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    
    res.json({
      success: true,
      user: {
        id: user._id,
        email: user.email,
        role: user.role,
        uniqueCode: user.uniqueCode,
        profile: user.profile,
        emailVerified: user.emailVerified,
        status: user.status
      }
    });
  } catch (err) {
    console.error('❌ [ME] Error:', err);
    res.status(401).json({ success: false, message: 'Invalid token' });
  }
});

module.exports = router;
