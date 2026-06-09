const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const db = require('../models/User');
const Wallet = require('../models/Wallet');
const env = require('../config/env');
const { AppError } = require('../utils/errors');

const router = express.Router();

// Get User model correctly - THIS FIXES THE ERROR
const User = db.User || db;

// LOGIN ROUTE
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password required' });
    }
    
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
    
    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
    
    const token = jwt.sign(
      { userId: user._id, role: user.role },
      env.jwtSecret,
      { expiresIn: '7d' }
    );
    
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
    console.error('Login error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// REGISTER ROUTE
router.post('/register', async (req, res, next) => {
  try {
    const { email, password, role, profile } = req.body;
    
    if (!email || !password || !role) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }
    
    const existing = await User.findOne({ email });
    if (existing) {
      return res.status(400).json({ success: false, message: 'Email already registered' });
    }
    
    const passwordHash = await bcrypt.hash(password, 10);
    
    const user = await User.create({
      email,
      passwordHash,
      role,
      profile: profile || {},
      status: 'active',
      emailVerified: true
    });
    
    await Wallet.create({ userId: user._id, walletType: 'standard', currency: 'USD' });
    
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
        profile: user.profile
      }
    });
    
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
