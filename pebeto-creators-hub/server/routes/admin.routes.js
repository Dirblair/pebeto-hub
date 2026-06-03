const express = require('express');
const Wallet = require('../models/Wallet');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const { authenticate, authorize } = require('../middleware/auth');
const { attachFeeService } = require('../middleware/feeService');

const router = express.Router();

router.use(authenticate, authorize('admin'), attachFeeService);

router.get('/metrics', async (req, res, next) => {
  try {
    const adminWallet = await Wallet.findOne({ userId: req.user._id, walletType: 'profit' });
    const profitBalance = adminWallet?.balances?.available || 0;

    const escrowAgg = await Wallet.aggregate([
      { $group: { _id: null, totalEscrow: { $sum: '$balances.escrow' } } },
    ]);
    const totalEscrow = escrowAgg[0]?.totalEscrow || 0;

    const withdrawalAgg = await Transaction.aggregate([
      {
        $match: {
          type: 'withdrawal',
          fromUserId: req.user._id,
          status: 'completed',
        },
      },
      { $group: { _id: null, total: { $sum: '$grossAmount' } } },
    ]);
    const totalAdminWithdrawals = withdrawalAgg[0]?.total || 0;

    const feeBreakdown = await Transaction.aggregate([
      {
        $match: {
          type: 'platform_fee',
          feeRecipient: req.user._id,
          status: 'completed',
        },
      },
      { $group: { _id: '$feeSource', total: { $sum: '$netAmount' } } },
    ]);

    const feesBySource = { deposit: 0, tip: 0, withdrawal: 0 };
    feeBreakdown.forEach((row) => {
      if (row._id) feesBySource[row._id] = row.total;
    });
    const totalFees = feesBySource.deposit + feesBySource.tip + feesBySource.withdrawal;

    res.json({
      success: true,
      profitWallet: profitBalance,
      totalEscrow,
      totalAdminWithdrawals,
      feeBreakdown: {
        ...feesBySource,
        percentages: {
          deposit: totalFees ? ((feesBySource.deposit / totalFees) * 100).toFixed(2) : '0',
          tip: totalFees ? ((feesBySource.tip / totalFees) * 100).toFixed(2) : '0',
          withdrawal: totalFees ? ((feesBySource.withdrawal / totalFees) * 100).toFixed(2) : '0',
        },
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get('/registrations', async (_req, res, next) => {
  try {
    const [total, creators, businesses] = await Promise.all([
      User.countDocuments({ role: { $ne: 'admin' } }),
      User.countDocuments({ role: 'creator' }),
      User.countDocuments({ role: 'business' }),
    ]);
    res.json({ success: true, total, creators, businesses });
  } catch (err) {
    next(err);
  }
});

router.get('/search', async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json({ success: true, results: [] });

    const users = await User.find({
      $or: [
        { uniqueCode: new RegExp(q, 'i') },
        { 'profile.displayName': new RegExp(q, 'i') },
        { 'profile.companyName': new RegExp(q, 'i') },
        { 'profile.stageName': new RegExp(q, 'i') },
      ],
    })
      .select('-passwordHash -payoutProfiles')
      .limit(20);

    res.json({ success: true, results: users, viewOnly: true });
  } catch (err) {
    next(err);
  }
});

router.get('/escrow-history', async (_req, res, next) => {
  try {
    const history = await Transaction.find({ type: 'deposit', status: 'completed' })
      .sort({ createdAt: -1 })
      .limit(200)
      .populate('fromUserId', 'email profile.companyName uniqueCode role');
    res.json({ success: true, history });
  } catch (err) {
    next(err);
  }
});

router.get('/activity', async (_req, res, next) => {
  try {
    const activity = await Transaction.find({
      type: { $in: ['deposit', 'escrow_release', 'platform_fee', 'withdrawal', 'tip'] },
      status: 'completed',
    })
      .sort({ createdAt: -1 })
      .limit(100)
      .populate('fromUserId', 'email profile.companyName uniqueCode role')
      .populate('toUserId', 'email profile.companyName uniqueCode role');
    res.json({ success: true, activity });
  } catch (err) {
    next(err);
  }
});

router.get('/profit-withdrawal-history', async (req, res, next) => {
  try {
    const history = await Transaction.find({
      type: 'withdrawal',
      fromUserId: req.user._id,
      status: 'completed',
    })
      .sort({ createdAt: -1 })
      .limit(200);
    res.json({ success: true, history });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
