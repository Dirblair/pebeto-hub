const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const User = require('../models/User');
const Wallet = require('../models/Wallet');
const env = require('../config/env');
const { AppError } = require('../utils/errors');
const { generateUniqueCode } = require('../utils/uniqueCode');

const router = express.Router();

router.post(
  '/register',
  [
    body('email').isEmail().normalizeEmail(),
    body('password').isLength({ min: 8 }),
    body('role').isIn(['business', 'creator']),
    body('profile.refereeName').trim().notEmpty().withMessage("Referee's name is required"),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) throw new AppError(errors.array()[0].msg, 400);

      const {
        email,
        password,
        role,
        profile = {},
        preferredLanguage = 'en',
        preferredCurrency = 'USD',
      } = req.body;
      const existing = await User.findOne({ email });
      if (existing) throw new AppError('Email already registered', 400);

      const passwordHash = await bcrypt.hash(password, 12);
      const userData = {
        email,
        passwordHash,
        role,
        profile: { ...profile, refereeName: profile.refereeName?.trim() },
        preferredLanguage,
        preferredCurrency,
      };

      if (role === 'creator') {
        let code;
        let taken = true;
        while (taken) {
          code = generateUniqueCode();
          taken = await User.exists({ uniqueCode: code });
        }
        userData.uniqueCode = code;
      }

      const user = await User.create(userData);
      const walletType = 'standard';
      await Wallet.create({ userId: user._id, walletType, currency: 'USD' });

      const token = jwt.sign({ userId: user._id, role: user.role }, env.jwtSecret, {
        expiresIn: env.jwtExpiresIn,
      });

      res.status(201).json({
        success: true,
        token,
        user: {
          id: user._id,
          email: user.email,
          role: user.role,
          uniqueCode: user.uniqueCode,
          profile: user.profile,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/login',
  [body('email').isEmail().normalizeEmail(), body('password').notEmpty()],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) throw new AppError('Invalid credentials', 400);

      const { email, password } = req.body;
      const user = await User.findOne({ email });
      if (!user) throw new AppError('Invalid credentials', 401);

      const match = await bcrypt.compare(password, user.passwordHash);
      if (!match) throw new AppError('Invalid credentials', 401);

      const token = jwt.sign({ userId: user._id, role: user.role }, env.jwtSecret, {
        expiresIn: env.jwtExpiresIn,
      });

      res.json({
        success: true,
        token,
        user: {
          id: user._id,
          email: user.email,
          role: user.role,
          uniqueCode: user.uniqueCode,
          profile: user.profile,
          preferredCurrency: user.preferredCurrency,
          preferredLanguage: user.preferredLanguage,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
