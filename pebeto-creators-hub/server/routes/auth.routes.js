const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Wallet = require('../models/Wallet');
const env = require('../config/env');

const router = express.Router();

// ============================================
// REGISTER ROUTE
// ============================================
router.post('/register', async (req, res) => {
  console.log('📝 REGISTER:', req.body.email);
  
  try {
    const { email, password, role, profile } = req.body;
    
    if (!email || !password || !role) {
      return res.status(400).json({ 
        success: false, 
        message: 'Email, password, and role are required' 
      });
    }
    
    // Check if user exists
    const existing = await User.findOne({ email });
    if (existing) {
      return res.status(400).json({ 
        success: false, 
        message: 'Email already registered' 
      });
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
      emailVerified: true
    });
    
    // Create wallet
    await Wallet.create({
      userId: user._id,
      walletType: 'standard',
      currency: 'USD',
      balances: { available: 0, escrow: 0, tips: 0, pending: 0 }
    });
    
    // Create token
    const token = jwt.sign(
      { userId: user._id, role: user.role },
      env.jwtSecret,
      { expiresIn: '30d' }
    );
    
    console.log('✅ REGISTER SUCCESS:', email);
    
    res.json({
      success: true,
      token,
      user: {
        id: user._id,
        email: user.email,
        role: user.role,
        uniqueCode: user.uniqueCode,
        profile: user.profile
      }
    });
    
  } catch (err) {
    console.error('❌ REGISTER ERROR:', err);
    res.status(500).json({ 
      success: false, 
      message: err.message 
    });
  }
});

// ============================================
// LOGIN ROUTE
// ============================================
router.post('/login', async (req, res) => {
  console.log('📝 LOGIN:', req.body.email);
  
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ 
        success: false, 
        message: 'Email and password required' 
      });
    }
    
    // Find user
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid email or password' 
      });
    }
    
    // Check password
    const isValid = await bcrypt.compare(password, user.passwordHash);
    if (!isValid) {
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid email or password' 
      });
    }
    
    // Check account status
    if (user.status !== 'active') {
      return res.status(403).json({ 
        success: false, 
        message: 'Account is not active' 
      });
    }
    
    // Update last login
    user.lastLoginAt = new Date();
    await user.save();
    
    // Create token
    const token = jwt.sign(
      { userId: user._id, role: user.role },
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
        uniqueCode: user.uniqueCode,
        profile: user.profile
      }
    });
    
  } catch (err) {
    console.error('❌ LOGIN ERROR:', err);
    res.status(500).json({ 
      success: false, 
      message: err.message 
    });
  }
});

// ============================================
// TEST ROUTE
// ============================================
router.get('/test', (req, res) => {
  res.json({ success: true, message: 'Auth routes are working!' });
});

// ============================================
// GET CURRENT USER
// ============================================
router.get('/me', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ success: false, message: 'No token' });
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
        profile: user.profile
      }
    });
  } catch (err) {
    res.status(401).json({ success: false, message: 'Invalid token' });
  }
});

module.exports = router;
