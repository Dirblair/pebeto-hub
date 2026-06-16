const express = require('express');
const mongoose = require('mongoose');
const Wallet = require('../models/Wallet');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const Campaign = require('../models/Campaign');
const { authenticate, authorize } = require('../middleware/auth');
const { rateLimit } = require('express-rate-limit');
const { body, query, param, validationResult } = require('express-validator');
const logger = require('../utils/logger');

const router = express.Router();

const adminRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => req.user?._id?.toString() || req.ip,
});

router.use(authenticate, authorize('admin'), adminRateLimit);

const validateDateRange = [
  query('startDate').optional().isISO8601().withMessage('Invalid start date'),
  query('endDate').optional().isISO8601().withMessage('Invalid end date'),
];

const validatePagination = [
  query('page').optional().isInt({ min: 1 }).withMessage('Page must be a positive integer'),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Limit must be between 1 and 100'),
];

// GET /api/admin/metrics
router.get('/metrics', validateDateRange, async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    
    const { startDate, endDate } = req.query;
    const dateFilter = {};
    if (startDate) dateFilter.$gte = new Date(startDate);
    if (endDate) dateFilter.$lte = new Date(endDate);
    const matchStage = dateFilter.createdAt ? { createdAt: dateFilter } : {};
    
    const [
      adminWallet,
      escrowAgg,
      withdrawalAgg,
      feeBreakdown,
      platformStats
    ] = await Promise.all([
      Wallet.findOne({ userId: req.user._id, walletType: 'profit' }).lean(),
      Wallet.aggregate([{ $group: { _id: null, totalEscrow: { $sum: '$balances.escrow' } } }]),
      Transaction.aggregate([{ $match: { type: 'withdrawal', fromUserId: req.user._id, status: 'completed', ...matchStage } }, { $group: { _id: null, total: { $sum: '$grossAmount' } } }]),
      Transaction.aggregate([{ $match: { type: 'platform_fee', feeRecipient: req.user._id, status: 'completed', ...matchStage } }, { $group: { _id: '$feeSource', total: { $sum: '$netAmount' } } }]),
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
    feeBreakdown.forEach((row) => { if (row._id) feesBySource[row._id] = row.total; });
    const totalFees = Object.values(feesBySource).reduce((a, b) => a + b, 0);
    
    const [totalUsers, totalCreators, totalBusinesses, totalCampaigns, openCampaigns, totalDeposits, totalWithdrawals] = platformStats;
    
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
        platformStats: { totalUsers, totalCreators, totalBusinesses, totalCampaigns, openCampaigns, totalDeposits, totalWithdrawals },
        dateRange: { startDate: startDate || null, endDate: endDate || null }
      }
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/registrations
router.get('/registrations', async (_req, res, next) => {
  try {
    const [total, creators, businesses, pending, suspended] = await Promise.all([
      User.countDocuments({ role: { $ne: 'admin' } }),
      User.countDocuments({ role: 'creator', status: 'active' }),
      User.countDocuments({ role: 'business', status: 'active' }),
      User.countDocuments({ status: 'pending' }),
      User.countDocuments({ status: 'suspended' }),
    ]);
    
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    const recentRegistrations = await User.aggregate([
      { $match: { role: { $ne: 'admin' }, createdAt: { $gte: thirtyDaysAgo } } },
      { $group: { _id: { date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, role: '$role' }, count: { $sum: 1 } } },
      { $sort: { '_id.date': 1 } }
    ]);
    
    res.json({ success: true, data: { total, creators, businesses, pending, suspended, recentRegistrations, lastUpdated: new Date() } });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/search
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
      User.find(query).select('-passwordHash -payoutProfiles -resetPasswordToken -emailVerificationToken').sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      User.countDocuments(query)
    ]);
    
    res.json({ success: true, data: { results: users, pagination: { page, limit, total, pages: Math.ceil(total / limit), hasMore: skip + users.length < total }, viewOnly: true } });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/users
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
      User.find(query).select('-passwordHash -payoutProfiles.details -resetPasswordToken -emailVerificationToken').sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      User.countDocuments(query)
    ]);
    
    const userIds = users.map(u => u._id);
    const wallets = await Wallet.find({ userId: { $in: userIds } }).lean();
    const walletMap = new Map(wallets.map(w => [w.userId.toString(), w]));
    const enrichedUsers = users.map(user => ({ ...user, wallet: walletMap.get(user._id.toString()) || null }));
    
    res.json({ success: true, data: { users: enrichedUsers, pagination: { page, limit, total, pages: Math.ceil(total / limit), hasMore: skip + users.length < total } } });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/users/:userId
router.get('/users/:userId', [
  param('userId').isMongoId().withMessage('Invalid user ID')
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    
    const user = await User.findById(req.params.userId).select('-passwordHash -resetPasswordToken -emailVerificationToken').lean();
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    
    const [wallet, transactions, campaigns] = await Promise.all([
      Wallet.findOne({ userId: user._id }).lean(),
      Transaction.find({ $or: [{ fromUserId: user._id }, { toUserId: user._id }] }).sort({ createdAt: -1 }).limit(50).lean(),
      Campaign.find({ $or: [{ businessId: user._id }, { assignedCreatorId: user._id }] }).sort({ createdAt: -1 }).limit(50).lean()
    ]);
    
    res.json({ success: true, data: { user, wallet, recentTransactions: transactions, recentCampaigns: campaigns } });
  } catch (err) {
    next(err);
  }
});

// PUT /api/admin/users/:userId/status
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
    
    if (user.role === 'admin') {
      return res.status(403).json({ success: false, message: 'Cannot modify admin user status' });
    }
    
    const oldStatus = user.status;
    user.status = status;
    user.statusReason = reason || null;
    
    if (status === 'suspended') {
      const wallet = await Wallet.findOne({ userId: user._id });
      if (wallet) await wallet.freeze(`Account suspended: ${reason || 'Violation of terms'}`);
    } else if (status === 'active' && oldStatus === 'suspended') {
      const wallet = await Wallet.findOne({ userId: user._id });
      if (wallet) await wallet.unfreeze();
    }
    
    await user.save();
    logger.info(`[ADMIN] User ${req.user._id} changed status of ${user._id} from ${oldStatus} to ${status}`);
    
    res.json({ success: true, message: `User status updated to ${status}`, data: { userId: user._id, oldStatus, newStatus: status } });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/escrow-history
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
      Transaction.find(match).sort({ createdAt: -1 }).skip(skip).limit(limit).populate('fromUserId', 'email profile.companyName uniqueCode role').populate('toUserId', 'email profile.companyName uniqueCode role').lean(),
      Transaction.countDocuments(match)
    ]);
    
    res.json({ success: true, data: { history, pagination: { page, limit, total, pages: Math.ceil(total / limit), hasMore: skip + history.length < total } } });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/transactions
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
      Transaction.find(match).sort({ createdAt: -1 }).skip(skip).limit(limit).populate('fromUserId', 'email uniqueCode role').populate('toUserId', 'email uniqueCode role').populate('feeRecipient', 'email uniqueCode role').lean(),
      Transaction.countDocuments(match)
    ]);
    
    res.json({ success: true, data: { transactions, pagination: { page, limit, total, pages: Math.ceil(total / limit), hasMore: skip + transactions.length < total } } });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/profit-withdrawal-history
router.get('/profit-withdrawal-history', [
  validatePagination,
  query('fromDate').optional().isISO8601(),
  query('toDate').optional().isISO8601()
], async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const skip = (page - 1) * limit;
    
    const match = { type: 'withdrawal', fromUserId: req.user._id, status: 'completed' };
    if (req.query.fromDate || req.query.toDate) {
      match.createdAt = {};
      if (req.query.fromDate) match.createdAt.$gte = new Date(req.query.fromDate);
      if (req.query.toDate) match.createdAt.$lte = new Date(req.query.toDate);
    }
    
    const [history, total] = await Promise.all([
      Transaction.find(match).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Transaction.countDocuments(match)
    ]);
    
    const summary = {
      totalWithdrawn: history.reduce((sum, t) => sum + t.grossAmount, 0),
      totalFees: history.reduce((sum, t) => sum + t.feeAmount, 0),
      transactionCount: total,
      averageWithdrawal: total > 0 ? history.reduce((sum, t) => sum + t.grossAmount, 0) / total : 0
    };
    
    res.json({ success: true, data: { history, summary, pagination: { page, limit, total, pages: Math.ceil(total / limit), hasMore: skip + history.length < total } } });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/activity
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
      Transaction.find({ type: { $in: types }, status: 'completed' }).sort({ createdAt: -1 }).skip(skip).limit(limit).populate('fromUserId', 'email profile.companyName uniqueCode role profile.stageName').populate('toUserId', 'email profile.companyName uniqueCode role profile.stageName').lean(),
      Transaction.countDocuments({ type: { $in: types }, status: 'completed' })
    ]);
    
    function formatActivityMessage(transaction) {
      const fromUser = transaction.fromUserId;
      const toUser = transaction.toUserId;
      switch (transaction.type) {
        case 'deposit': return `${fromUser?.profile?.companyName || fromUser?.email} deposited ${transaction.grossAmount} USD`;
        case 'withdrawal': return `${fromUser?.email} withdrew ${transaction.grossAmount} USD via ${transaction.metadata?.payoutMethod}`;
        case 'tip': return `${fromUser?.email} tipped ${toUser?.profile?.stageName || toUser?.email} ${transaction.grossAmount} USD`;
        case 'platform_fee': return `Platform earned ${transaction.grossAmount} USD from ${transaction.feeSource} fees`;
        default: return `${transaction.type}: ${transaction.grossAmount} USD`;
      }
    }
    
    const enrichedActivity = transactions.map(t => ({ ...t, formattedMessage: formatActivityMessage(t) }));
    res.json({ success: true, data: { activity: enrichedActivity, pagination: { page, limit, total, pages: Math.ceil(total / limit), hasMore: skip + transactions.length < total } } });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/dashboard-stats
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
      Transaction.aggregate([{ $match: { status: 'completed', createdAt: { $gte: today } } }, { $group: { _id: null, total: { $sum: '$grossAmount' } } }]),
      Transaction.aggregate([{ $match: { status: 'completed', createdAt: { $gte: thisWeek } } }, { $group: { _id: null, total: { $sum: '$grossAmount' } } }]),
      Transaction.aggregate([{ $match: { status: 'completed', createdAt: { $gte: thisMonth } } }, { $group: { _id: null, total: { $sum: '$grossAmount' } } }])
    ]);
    
    res.json({
      success: true,
      data: {
        users: { total: totalUsers, today: todayRegistrations, week: weekRegistrations, month: monthRegistrations },
        volume: { total: totalTransactions, today: todayVolume[0]?.total || 0, week: weekVolume[0]?.total || 0, month: monthVolume[0]?.total || 0 }
      }
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/auto-release/stats
router.get('/auto-release/stats', async (req, res, next) => {
  try {
    const now = new Date();
    const todayStart = new Date(now.setHours(0, 0, 0, 0));
    
    const pendingAutoRelease = await Campaign.countDocuments({
      creatorWorkCompleted: true,
      businessWorkApproved: false,
      autoReleaseDeadline: { $gt: new Date() },
      autoReleaseStatus: { $in: ['pending', 'reminding'] }
    });
    
    const autoReleasedToday = await Campaign.countDocuments({
      autoReleaseStatus: 'completed',
      autoReleaseCompletedAt: { $gte: todayStart }
    });
    
    const autoReleaseTransactions = await Transaction.aggregate([
      { $match: { type: 'escrow_release', 'metadata.autoRelease': true, status: 'completed' } },
      { $group: { _id: null, totalAmount: { $sum: '$grossAmount' }, count: { $sum: 1 } } }
    ]);
    
    const remindersSentToday = await Campaign.countDocuments({
      lastReminderSentAt: { $gte: todayStart }
    });
    
    res.json({
      success: true,
      data: {
        pendingAutoRelease,
        autoReleasedToday,
        totalAutoReleasedAmount: autoReleaseTransactions[0]?.totalAmount || 0,
        totalAutoReleasedCount: autoReleaseTransactions[0]?.count || 0,
        remindersSentToday
      }
    });
  } catch (err) {
    logger.error('Error fetching auto-release stats:', err);
    next(err);
  }
});

// GET /api/admin/auto-release/campaigns
router.get('/auto-release/campaigns', [
  validatePagination,
  query('status').optional().isIn(['pending', 'warning', 'urgent', 'all'])
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const skip = (page - 1) * limit;
    const statusFilter = req.query.status || 'all';
    
    const now = new Date();
    const query = {
      creatorWorkCompleted: true,
      businessWorkApproved: false,
      autoReleaseDeadline: { $gt: now },
      autoReleaseStatus: { $in: ['pending', 'reminding'] }
    };
    
    const campaigns = await Campaign.find(query)
      .populate('businessId', 'email profile.companyName profile.displayName')
      .populate('assignedCreatorId', 'email uniqueCode profile.stageName profile.displayName')
      .sort({ autoReleaseDeadline: 1 })
      .skip(skip)
      .limit(limit)
      .lean();
    
    const enrichedCampaigns = campaigns.map(campaign => {
      const deadline = new Date(campaign.autoReleaseDeadline);
      const daysRemaining = Math.max(0, Math.ceil((deadline - now) / (1000 * 60 * 60 * 24)));
      const hoursRemaining = Math.max(0, Math.ceil((deadline - now) / (1000 * 60 * 60)));
      const acceptedBid = campaign.bids?.find(b => b.status === 'accepted');
      const amount = acceptedBid?.amount || campaign.escrowHeld || 0;
      let urgency = 'normal';
      if (daysRemaining <= 1) urgency = 'urgent';
      else if (daysRemaining <= 3) urgency = 'warning';
      
      return {
        _id: campaign._id,
        title: campaign.title,
        businessId: campaign.businessId?._id,
        businessEmail: campaign.businessId?.email,
        businessName: campaign.businessId?.profile?.companyName || campaign.businessId?.profile?.displayName,
        creatorId: campaign.assignedCreatorId?._id,
        creatorEmail: campaign.assignedCreatorId?.email,
        creatorName: campaign.assignedCreatorId?.profile?.stageName || campaign.assignedCreatorId?.profile?.displayName || campaign.assignedCreatorId?.uniqueCode,
        amount,
        autoReleaseDeadline: campaign.autoReleaseDeadline,
        daysRemaining,
        hoursRemaining,
        urgency,
        reminderCount: campaign.autoReleaseReminderSent || 0,
        lastReminderSentAt: campaign.lastReminderSentAt
      };
    });
    
    let filteredCampaigns = enrichedCampaigns;
    if (statusFilter === 'urgent') filteredCampaigns = enrichedCampaigns.filter(c => c.urgency === 'urgent');
    else if (statusFilter === 'warning') filteredCampaigns = enrichedCampaigns.filter(c => c.urgency === 'warning');
    
    const total = filteredCampaigns.length;
    const paginatedCampaigns = filteredCampaigns.slice(0, limit);
    
    res.json({
      success: true,
      data: {
        campaigns: paginatedCampaigns,
        pagination: { page, limit, total, pages: Math.ceil(total / limit), hasMore: skip + paginatedCampaigns.length < total },
        summary: { totalPending: enrichedCampaigns.length, urgent: enrichedCampaigns.filter(c => c.urgency === 'urgent').length, warning: enrichedCampaigns.filter(c => c.urgency === 'warning').length }
      }
    });
  } catch (err) {
    logger.error('Error fetching auto-release campaigns:', err);
    next(err);
  }
});

// POST /api/admin/auto-release/:campaignId/manual
router.post('/auto-release/:campaignId/manual', [
  param('campaignId').isMongoId().withMessage('Invalid campaign ID'),
  body('reason').optional().isString().trim().isLength({ max: 500 })
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    
    const { campaignId } = req.params;
    const { reason } = req.body;
    
    const campaign = await Campaign.findById(campaignId);
    if (!campaign) {
      return res.status(404).json({ success: false, message: 'Campaign not found' });
    }
    
    if (!campaign.creatorWorkCompleted) {
      return res.status(400).json({ success: false, message: 'Creator has not marked work as completed' });
    }
    
    if (campaign.businessWorkApproved) {
      return res.status(400).json({ success: false, message: 'Business has already approved this work' });
    }
    
    if (campaign.autoReleaseStatus === 'completed') {
      return res.status(400).json({ success: false, message: 'Funds have already been released' });
    }
    
    const { executeAutoRelease } = require('../services/autoReleaseService');
    campaign.autoReleaseDeadline = new Date();
    campaign.autoReleaseStatus = 'processing';
    await campaign.save();
    const result = await executeAutoRelease(campaign);
    logger.info(`Manual auto-release triggered by admin ${req.user._id} for campaign ${campaignId}`, { reason });
    res.json({ success: true, message: 'Manual auto-release completed', data: result });
  } catch (err) {
    logger.error('Error in manual auto-release:', err);
    next(err);
  }
});

// GET /api/admin/reports
router.get('/reports', [
  query('status').optional().isIn(['pending', 'reviewing', 'resolved', 'dismissed']),
  validatePagination
], async (req, res, next) => {
  try {
    const { status = 'pending' } = req.query;
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const skip = (page - 1) * limit;
    
    const Report = require('../models/Report');
    
    const [reports, total] = await Promise.all([
      Report.find({ status }).sort({ createdAt: 1 }).skip(skip).limit(limit).populate('reporterId', 'email uniqueCode role profile.stageName profile.companyName').populate('reportedUserId', 'email uniqueCode role profile.stageName profile.companyName profile.avatarUrl').populate('reportedPostId', 'caption mediaUrl mediaType createdAt').lean(),
      Report.countDocuments({ status })
    ]);
    
    res.json({ success: true, data: { reports, pagination: { page, limit, total, pages: Math.ceil(total / limit), hasMore: skip + reports.length < total } } });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/reports/:reportId
router.get('/reports/:reportId', [
  param('reportId').isMongoId().withMessage('Invalid report ID')
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    
    const { reportId } = req.params;
    const Report = require('../models/Report');
    
    const report = await Report.findById(reportId)
      .populate('reporterId', 'email uniqueCode role profile.stageName profile.companyName profile.avatarUrl')
      .populate('reportedUserId', 'email uniqueCode role profile.stageName profile.companyName profile.avatarUrl')
      .populate('reportedPostId', 'caption mediaUrl mediaType createdAt likeCount commentCount')
      .lean();
    
    if (!report) {
      return res.status(404).json({ success: false, message: 'Report not found' });
    }
    
    res.json({ success: true, data: report });
  } catch (err) {
    next(err);
  }
});

// PUT /api/admin/reports/:reportId
router.put('/reports/:reportId', [
  param('reportId').isMongoId().withMessage('Invalid report ID'),
  body('status').isIn(['resolved', 'dismissed', 'reviewing']).withMessage('Invalid status'),
  body('resolution').optional().isString().trim().isLength({ max: 1000 }),
  body('action').optional().isIn(['none', 'warn', 'suspend', 'ban', 'delete_post'])
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    
    const { reportId } = req.params;
    const { status, resolution, action = 'none' } = req.body;
    const Report = require('../models/Report');
    
    const report = await Report.findById(reportId);
    if (!report) {
      return res.status(404).json({ success: false, message: 'Report not found' });
    }
    
    report.status = status;
    report.resolution = resolution || report.resolution;
    report.reviewedBy = req.user._id;
    report.reviewedAt = new Date();
    await report.save();
    
    if (status === 'resolved') {
      switch (action) {
        case 'warn':
          await User.findByIdAndUpdate(report.reportedUserId, { $push: { warnings: { message: resolution, issuedBy: req.user._id, issuedAt: new Date() } } });
          logger.info(`[ADMIN] Warning issued to user ${report.reportedUserId} by ${req.user._id}`);
          break;
        case 'suspend':
          await User.findByIdAndUpdate(report.reportedUserId, { status: 'suspended', statusReason: resolution });
          logger.info(`[ADMIN] User ${report.reportedUserId} suspended by ${req.user._id}`);
          break;
        case 'ban':
          await User.findByIdAndUpdate(report.reportedUserId, { status: 'banned', statusReason: resolution });
          logger.info(`[ADMIN] User ${report.reportedUserId} banned by ${req.user._id}`);
          break;
        case 'delete_post':
          if (report.reportedPostId) {
            const CommunityPost = require('../models/CommunityPost');
            await CommunityPost.findByIdAndDelete(report.reportedPostId);
            logger.info(`[ADMIN] Post ${report.reportedPostId} deleted by ${req.user._id}`);
          }
          break;
        default: break;
      }
    }
    
    logger.info(`Report ${reportId} ${status} by admin ${req.user._id}, action: ${action}`);
    res.json({ success: true, message: `Report ${status}`, data: report });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/reports/stats
router.get('/reports/stats', async (req, res, next) => {
  try {
    const Report = require('../models/Report');
    
    const stats = await Report.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]);
    const byReason = await Report.aggregate([{ $group: { _id: '$reason', count: { $sum: 1 } } }, { $sort: { count: -1 } }]);
    const pendingCount = await Report.countDocuments({ status: 'pending' });
    const resolvedToday = await Report.countDocuments({ status: 'resolved', reviewedAt: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) } });
    
    res.json({ success: true, data: { byStatus: stats, byReason, pendingCount, resolvedToday, totalReports: await Report.countDocuments() } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
