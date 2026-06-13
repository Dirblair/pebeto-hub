/**
 * Admin Routes for Pebeto Creator's Hub
 * 
 * Provides administrative endpoints for platform metrics, user management,
 * transaction monitoring, and system configuration.
 * 
 * @module routes/admin
 */

const express = require('express');
const mongoose = require('mongoose');
const Wallet = require('../models/Wallet');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const Campaign = require('../models/Campaign');
const { authenticate, authorize } = require('../middleware/auth');
// attachFeeService is already applied globally in server.js
const { rateLimit } = require('express-rate-limit');
const { body, query, param, validationResult } = require('express-validator');

const router = express.Router();

// ============================================
// Rate Limiting for Admin Routes
// ============================================

const adminRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute
  skipSuccessfulRequests: true,
  keyGenerator: (req) => req.user?._id?.toString() || req.ip,
});

router.use(authenticate, authorize('admin'), adminRateLimit);

// ============================================
// Validation Helpers
// ============================================

const validateDateRange = [
  query('startDate').optional().isISO8601().withMessage('Invalid start date'),
  query('endDate').optional().isISO8601().withMessage('Invalid end date'),
];

const validatePagination = [
  query('page').optional().isInt({ min: 1 }).withMessage('Page must be a positive integer'),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Limit must be between 1 and 100'),
];

// ============================================
// Metrics Endpoint
// ============================================

/**
 * GET /api/admin/metrics
 * Get platform-wide metrics including profit wallet, escrow total, and fee breakdown
 */
router.get('/metrics', validateDateRange, async (req, res, next) => {
  try {
    // Validate query parameters
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    
    const { startDate, endDate } = req.query;
    const dateFilter = {};
    
    if (startDate) dateFilter.$gte = new Date(startDate);
    if (endDate) dateFilter.$lte = new Date(endDate);
    
    const matchStage = dateFilter.createdAt ? { createdAt: dateFilter } : {};
    
    // Run queries in parallel for better performance
    const [
      adminWallet,
      escrowAgg,
      withdrawalAgg,
      feeBreakdown,
      platformStats
    ] = await Promise.all([
      // Admin profit wallet
      Wallet.findOne({ userId: req.user._id, walletType: 'profit' }).lean(),
      
      // Total escrow across all wallets
      Wallet.aggregate([
        { $group: { _id: null, totalEscrow: { $sum: '$balances.escrow' } } }
      ]),
      
      // Admin withdrawals
      Transaction.aggregate([
        {
          $match: {
            type: 'withdrawal',
            fromUserId: req.user._id,
            status: 'completed',
            ...matchStage
          }
        },
        { $group: { _id: null, total: { $sum: '$grossAmount' } } }
      ]),
      
      // Fee breakdown by source
      Transaction.aggregate([
        {
          $match: {
            type: 'platform_fee',
            feeRecipient: req.user._id,
            status: 'completed',
            ...matchStage
          }
        },
        { $group: { _id: '$feeSource', total: { $sum: '$netAmount' } } }
      ]),
      
      // Additional platform stats
      Promise.all([
        User.countDocuments(),
        User.countDocuments({ role: 'creator', status: 'active' }),
        User.countDocuments({ role: 'business', status: 'active' }),
        Campaign.countDocuments(),
        Campaign.countDocuments({ status: 'open' }),
        Transaction.countDocuments({ type: 'deposit', status: 'completed', ...matchStage }),
        Transaction.countDocuments({ type: 'withdrawal', status: 'completed', ...matchStage })
      ])
    ]);
    
    const profitBalance = adminWallet?.balances?.available || 0;
    const totalEscrow = escrowAgg[0]?.totalEscrow || 0;
    const totalAdminWithdrawals = withdrawalAgg[0]?.total || 0;
    
    const feesBySource = { deposit: 0, tip: 0, withdrawal: 0, escrow: 0 };
    feeBreakdown.forEach((row) => {
      if (row._id) feesBySource[row._id] = row.total;
    });
    
    const totalFees = Object.values(feesBySource).reduce((a, b) => a + b, 0);
    
    const [
      totalUsers,
      totalCreators,
      totalBusinesses,
      totalCampaigns,
      openCampaigns,
      totalDeposits,
      totalWithdrawals
    ] = platformStats;
    
    res.json({
      success: true,
      data: {
        profitWallet: profitBalance,
        totalEscrow,
        totalAdminWithdrawals,
        feeBreakdown: {
          deposit: feesBySource.deposit,
          tip: feesBySource.tip,
          withdrawal: feesBySource.withdrawal,
          escrow: feesBySource.escrow,
          total: totalFees,
          percentages: {
            deposit: totalFees ? ((feesBySource.deposit / totalFees) * 100).toFixed(2) : '0',
            tip: totalFees ? ((feesBySource.tip / totalFees) * 100).toFixed(2) : '0',
            withdrawal: totalFees ? ((feesBySource.withdrawal / totalFees) * 100).toFixed(2) : '0',
            escrow: totalFees ? ((feesBySource.escrow / totalFees) * 100).toFixed(2) : '0',
          },
        },
        platformStats: {
          totalUsers,
          totalCreators,
          totalBusinesses,
          totalCampaigns,
          openCampaigns,
          totalDeposits,
          totalWithdrawals,
        },
        dateRange: { startDate: startDate || null, endDate: endDate || null }
      }
    });
  } catch (err) {
    next(err);
  }
});

// ============================================
// Registrations Endpoint
// ============================================

/**
 * GET /api/admin/registrations
 * Get user registration counts by role
 */
router.get('/registrations', async (_req, res, next) => {
  try {
    const [total, creators, businesses, pending, suspended] = await Promise.all([
      User.countDocuments({ role: { $ne: 'admin' } }),
      User.countDocuments({ role: 'creator', status: 'active' }),
      User.countDocuments({ role: 'business', status: 'active' }),
      User.countDocuments({ status: 'pending' }),
      User.countDocuments({ status: 'suspended' }),
    ]);
    
    // Get registration trends (last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    const recentRegistrations = await User.aggregate([
      {
        $match: {
          role: { $ne: 'admin' },
          createdAt: { $gte: thirtyDaysAgo }
        }
      },
      {
        $group: {
          _id: {
            date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            role: '$role'
          },
          count: { $sum: 1 }
        }
      },
      { $sort: { '_id.date': 1 } }
    ]);
    
    res.json({
      success: true,
      data: {
        total,
        creators,
        businesses,
        pending,
        suspended,
        recentRegistrations,
        lastUpdated: new Date()
      }
    });
  } catch (err) {
    next(err);
  }
});

// ============================================
// Search Endpoint
// ============================================

/**
 * GET /api/admin/search
 * Search users by unique code, name, email, or company
 */
router.get('/search', [
  query('q').notEmpty().withMessage('Search query is required'),
  query('q').isLength({ min: 2 }).withMessage('Search query must be at least 2 characters'),
  validatePagination
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    
    const q = (req.query.q || '').trim();
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const skip = (page - 1) * limit;
    
    // Use text search or regex
    const searchRegex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    
    const query = {
      $or: [
        { uniqueCode: searchRegex },
        { email: searchRegex },
        { 'profile.displayName': searchRegex },
        { 'profile.companyName': searchRegex },
        { 'profile.stageName': searchRegex },
      ]
    };
    
    const [users, total] = await Promise.all([
      User.find(query)
        .select('-passwordHash -payoutProfiles -resetPasswordToken -emailVerificationToken')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      User.countDocuments(query)
    ]);
    
    res.json({
      success: true,
      data: {
        results: users,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit),
          hasMore: skip + users.length < total
        },
        viewOnly: true
      }
    });
  } catch (err) {
    next(err);
  }
});

// ============================================
// User Management Endpoints
// ============================================

/**
 * GET /api/admin/users
 * List all users with pagination and filtering
 */
router.get('/users', [
  query('role').optional().isIn(['creator', 'business', 'admin']),
  query('status').optional().isIn(['active', 'suspended', 'pending', 'banned']),
  validatePagination
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    
    const { role, status } = req.query;
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const skip = (page - 1) * limit;
    
    const query = {};
    if (role) query.role = role;
    if (status) query.status = status;
    
    const [users, total] = await Promise.all([
      User.find(query)
        .select('-passwordHash -payoutProfiles.details -resetPasswordToken -emailVerificationToken')
        .populate('userId', 'balances.available balances.escrow')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      User.countDocuments(query)
    ]);
    
    // Get wallet balances for each user
    const userIds = users.map(u => u._id);
    const wallets = await Wallet.find({ userId: { $in: userIds } }).lean();
    const walletMap = new Map(wallets.map(w => [w.userId.toString(), w]));
    
    const enrichedUsers = users.map(user => ({
      ...user,
      wallet: walletMap.get(user._id.toString()) || null
    }));
    
    res.json({
      success: true,
      data: {
        users: enrichedUsers,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit),
          hasMore: skip + users.length < total
        }
      }
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/users/:userId
 * Get detailed user information
 */
router.get('/users/:userId', [
  param('userId').isMongoId().withMessage('Invalid user ID')
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    
    const user = await User.findById(req.params.userId)
      .select('-passwordHash -resetPasswordToken -emailVerificationToken')
      .lean();
    
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    
    const [wallet, transactions, campaigns] = await Promise.all([
      Wallet.findOne({ userId: user._id }).lean(),
      Transaction.find({
        $or: [{ fromUserId: user._id }, { toUserId: user._id }]
      })
        .sort({ createdAt: -1 })
        .limit(50)
        .lean(),
      Campaign.find({
        $or: [{ businessId: user._id }, { assignedCreatorId: user._id }]
      })
        .sort({ createdAt: -1 })
        .limit(50)
        .lean()
    ]);
    
    res.json({
      success: true,
      data: {
        user,
        wallet,
        recentTransactions: transactions,
        recentCampaigns: campaigns
      }
    });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/admin/users/:userId/status
 * Update user status (suspend, activate, ban)
 */
router.put('/users/:userId/status', [
  param('userId').isMongoId().withMessage('Invalid user ID'),
  body('status').isIn(['active', 'suspended', 'banned']).withMessage('Invalid status'),
  body('reason').optional().isString().trim().isLength({ max: 500 })
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    
    const { status, reason } = req.body;
    
    const user = await User.findById(req.params.userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    
    // Don't allow changing admin status
    if (user.role === 'admin') {
      return res.status(403).json({ success: false, message: 'Cannot modify admin user status' });
    }
    
    const oldStatus = user.status;
    user.status = status;
    user.statusReason = reason || null;
    
    if (status === 'suspended') {
      // Freeze user's wallet
      const wallet = await Wallet.findOne({ userId: user._id });
      if (wallet) await wallet.freeze(`Account suspended: ${reason || 'Violation of terms'}`);
    } else if (status === 'active' && oldStatus === 'suspended') {
      // Unfreeze wallet
      const wallet = await Wallet.findOne({ userId: user._id });
      if (wallet) await wallet.unfreeze();
    }
    
    await user.save();
    
    // Log admin action (implement audit logging)
    console.log(`[ADMIN] User ${req.user._id} changed status of ${user._id} from ${oldStatus} to ${status}`);
    
    res.json({
      success: true,
      message: `User status updated to ${status}`,
      data: { userId: user._id, oldStatus, newStatus: status }
    });
  } catch (err) {
    next(err);
  }
});

// ============================================
// Transaction History Endpoints
// ============================================

/**
 * GET /api/admin/escrow-history
 * Get escrow transaction history
 */
router.get('/escrow-history', [
  validatePagination,
  query('fromDate').optional().isISO8601(),
  query('toDate').optional().isISO8601()
], async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const skip = (page - 1) * limit;
    
    const match = { type: 'deposit', status: 'completed' };
    
    if (req.query.fromDate || req.query.toDate) {
      match.createdAt = {};
      if (req.query.fromDate) match.createdAt.$gte = new Date(req.query.fromDate);
      if (req.query.toDate) match.createdAt.$lte = new Date(req.query.toDate);
    }
    
    const [history, total] = await Promise.all([
      Transaction.find(match)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('fromUserId', 'email profile.companyName uniqueCode role')
        .populate('toUserId', 'email profile.companyName uniqueCode role')
        .lean(),
      Transaction.countDocuments(match)
    ]);
    
    res.json({
      success: true,
      data: {
        history,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit),
          hasMore: skip + history.length < total
        }
      }
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/transactions
 * Get all platform transactions with filtering
 */
router.get('/transactions', [
  query('type').optional().isIn(['deposit', 'withdrawal', 'tip', 'platform_fee', 'escrow_release']),
  query('status').optional().isIn(['pending', 'completed', 'failed']),
  validatePagination,
  query('fromDate').optional().isISO8601(),
  query('toDate').optional().isISO8601()
], async (req, res, next) => {
  try {
    const { type, status, fromDate, toDate } = req.query;
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const skip = (page - 1) * limit;
    
    const match = {};
    if (type) match.type = type;
    if (status) match.status = status;
    if (fromDate || toDate) {
      match.createdAt = {};
      if (fromDate) match.createdAt.$gte = new Date(fromDate);
      if (toDate) match.createdAt.$lte = new Date(toDate);
    }
    
    const [transactions, total] = await Promise.all([
      Transaction.find(match)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('fromUserId', 'email uniqueCode role')
        .populate('toUserId', 'email uniqueCode role')
        .populate('feeRecipient', 'email uniqueCode role')
        .lean(),
      Transaction.countDocuments(match)
    ]);
    
    res.json({
      success: true,
      data: {
        transactions,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit),
          hasMore: skip + transactions.length < total
        }
      }
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/profit-withdrawal-history
 * Get admin profit withdrawal history
 */
router.get('/profit-withdrawal-history', [
  validatePagination,
  query('fromDate').optional().isISO8601(),
  query('toDate').optional().isISO8601()
], async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const skip = (page - 1) * limit;
    
    const match = {
      type: 'withdrawal',
      fromUserId: req.user._id,
      status: 'completed'
    };
    
    if (req.query.fromDate || req.query.toDate) {
      match.createdAt = {};
      if (req.query.fromDate) match.createdAt.$gte = new Date(req.query.fromDate);
      if (req.query.toDate) match.createdAt.$lte = new Date(req.query.toDate);
    }
    
    const [history, total] = await Promise.all([
      Transaction.find(match)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Transaction.countDocuments(match)
    ]);
    
    // Calculate summary
    const summary = {
      totalWithdrawn: history.reduce((sum, t) => sum + t.grossAmount, 0),
      totalFees: history.reduce((sum, t) => sum + t.feeAmount, 0),
      transactionCount: total,
      averageWithdrawal: total > 0 ? history.reduce((sum, t) => sum + t.grossAmount, 0) / total : 0
    };
    
    res.json({
      success: true,
      data: {
        history,
        summary,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit),
          hasMore: skip + history.length < total
        }
      }
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/activity
 * Get recent platform activity feed
 */
router.get('/activity', [
  validatePagination,
  query('type').optional().isIn(['deposit', 'escrow_release', 'platform_fee', 'withdrawal', 'tip', 'campaign_created'])
], async (req, res, next) => {
  try {
    const { type } = req.query;
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const skip = (page - 1) * limit;
    
    const types = type ? [type] : ['deposit', 'escrow_release', 'platform_fee', 'withdrawal', 'tip'];
    
    const [transactions, total] = await Promise.all([
      Transaction.find({
        type: { $in: types },
        status: 'completed'
      })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('fromUserId', 'email profile.companyName uniqueCode role profile.stageName')
        .populate('toUserId', 'email profile.companyName uniqueCode role profile.stageName')
        .lean(),
      Transaction.countDocuments({
        type: { $in: types },
        status: 'completed'
      })
    ]);
    
    // Enrich activity with formatted messages
    const enrichedActivity = transactions.map(t => ({
      ...t,
      formattedMessage: formatActivityMessage(t)
    }));
    
    res.json({
      success: true,
      data: {
        activity: enrichedActivity,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit),
          hasMore: skip + transactions.length < total
        }
      }
    });
  } catch (err) {
    next(err);
  }
});

// Helper function to format activity messages
function formatActivityMessage(transaction) {
  const fromUser = transaction.fromUserId;
  const toUser = transaction.toUserId;
  
  switch (transaction.type) {
    case 'deposit':
      return `${fromUser?.profile?.companyName || fromUser?.email} deposited ${transaction.grossAmount} USD`;
    case 'withdrawal':
      return `${fromUser?.email} withdrew ${transaction.grossAmount} USD via ${transaction.metadata?.payoutMethod}`;
    case 'tip':
      return `${fromUser?.email} tipped ${toUser?.profile?.stageName || toUser?.email} ${transaction.grossAmount} USD`;
    case 'platform_fee':
      return `Platform earned ${transaction.grossAmount} USD from ${transaction.feeSource} fees`;
    default:
      return `${transaction.type}: ${transaction.grossAmount} USD`;
  }
}

// ============================================
// Dashboard Stats Endpoint
// ============================================

/**
 * GET /api/admin/dashboard-stats
 * Get comprehensive dashboard statistics
 */
router.get('/dashboard-stats', async (_req, res, next) => {
  try {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const thisWeek = new Date(now.setDate(now.getDate() - 7));
    const thisMonth = new Date(now.setMonth(now.getMonth() - 1));
    
    const [
      totalUsers,
      todayRegistrations,
      weekRegistrations,
      monthRegistrations,
      totalTransactions,
      todayVolume,
      weekVolume,
      monthVolume
    ] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ createdAt: { $gte: today } }),
      User.countDocuments({ createdAt: { $gte: thisWeek } }),
      User.countDocuments({ createdAt: { $gte: thisMonth } }),
      Transaction.countDocuments({ status: 'completed' }),
      Transaction.aggregate([
        { $match: { status: 'completed', createdAt: { $gte: today } } },
        { $group: { _id: null, total: { $sum: '$grossAmount' } } }
      ]),
      Transaction.aggregate([
        { $match: { status: 'completed', createdAt: { $gte: thisWeek } } },
        { $group: { _id: null, total: { $sum: '$grossAmount' } } }
      ]),
      Transaction.aggregate([
        { $match: { status: 'completed', createdAt: { $gte: thisMonth } } },
        { $group: { _id: null, total: { $sum: '$grossAmount' } } }
      ])
    ]);
    
    res.json({
      success: true,
      data: {
        users: {
          total: totalUsers,
          today: todayRegistrations,
          week: weekRegistrations,
          month: monthRegistrations
        },
        volume: {
          total: totalTransactions,
          today: todayVolume[0]?.total || 0,
          week: weekVolume[0]?.total || 0,
          month: monthVolume[0]?.total || 0
        }
      }
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
