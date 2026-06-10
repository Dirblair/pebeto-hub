const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Wallet = require('../models/Wallet');
const env = require('../config/env');

const router = express.Router();

// REGISTER
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
      status: 'active',
      emailVerified: true
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
    
    const token = jwt.sign(
      { userId: user._id, role: user.role },
      env.jwtSecret,
      { expiresIn: '30d' }
    );
    
    res.json({
      success: true,
      token,
      user: {
        id: user._id,
        email: user.email,
        role: user.role,
        profile: user.profile
      }
    });
    
  } catch (err) {
    console.error('REGISTER ERROR:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// LOGIN - FIXED to retrieve passwordHash correctly
router.post('/login', async (req, res) => {
  console.log('📝 LOGIN:', req.body.email);
  
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password required' });
    }
    
    // IMPORTANT: Use .select('+passwordHash') to include the password field
    const user = await User.findOne({ email }).select('+passwordHash');
    
    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
    
    // Check if passwordHash exists
    if (!user.passwordHash) {
      console.error('❌ No passwordHash found for user:', email);
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
    
    const isValid = await bcrypt.compare(password, user.passwordHash);
    if (!isValid) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
    
    user.lastLoginAt = new Date();
    await user.save();
    
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
        profile: user.profile
      }
    });
    
  } catch (err) {
    console.error('LOGIN ERROR:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/test', (req, res) => {
  res.json({ success: true, message: 'Auth working!' });
});

module.exports = router;
