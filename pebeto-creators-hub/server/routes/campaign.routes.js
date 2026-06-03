const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticate, authorize } = require('../middleware/auth');
const { attachFeeService } = require('../middleware/feeService');
const { AppError } = require('../utils/errors');
const {
  listCampaignsForUser,
  createCampaign,
  fundCampaignEscrow,
  placeBid,
  acceptBid,
  submitWork,
  completeAndPay,
  getCampaignById,
} = require('../services/campaignService');

const router = express.Router();

router.use(authenticate, attachFeeService);

function emitPlatformActivity(req, payload) {
  const io = req.app.get('io');
  if (io) io.to('status:global').emit('platform:activity', payload);
}

function assertWritable(req) {
  if (req.query.viewOnly === '1' && req.user.role === 'admin') {
    throw new AppError('View-only mode: changes are disabled', 403);
  }
  if (req.query.viewOnly === '1') {
    throw new AppError('View-only mode: changes are disabled', 403);
  }
}

router.get('/', async (req, res, next) => {
  try {
    const viewUserId = req.query.userId;
    if (viewUserId && req.user.role !== 'admin') {
      throw new AppError('Forbidden', 403);
    }
    const campaigns = await listCampaignsForUser(req.user, { viewUserId });
    res.json({ success: true, campaigns, viewOnly: req.query.viewOnly === '1' });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const viewUserId = req.query.userId;
    if (viewUserId && req.user.role !== 'admin') {
      throw new AppError('Forbidden', 403);
    }
    const campaign = await getCampaignById(req.user, req.params.id, { viewUserId });
    res.json({ success: true, campaign, viewOnly: req.query.viewOnly === '1' });
  } catch (err) {
    next(err);
  }
});

router.post(
  '/',
  authorize('business'),
  [body('title').trim().notEmpty(), body('budget').isFloat({ min: 1 })],
  async (req, res, next) => {
    try {
      assertWritable(req);
      const errors = validationResult(req);
      if (!errors.isEmpty()) throw new AppError(errors.array()[0].msg, 400);
      const campaign = await createCampaign(req.user, req.body);
      emitPlatformActivity(req, { type: 'campaign_created', campaignId: campaign._id });
      res.status(201).json({ success: true, campaign });
    } catch (err) {
      next(err);
    }
  }
);

router.post('/:id/fund', authorize('business'), async (req, res, next) => {
  try {
    assertWritable(req);
    const intentUsd = Number(req.body.intentUsd);
    if (!intentUsd || intentUsd <= 0) throw new AppError('intentUsd must be positive', 400);

    const preview = req.feeService.calculateDeposit(intentUsd);
    const result = await fundCampaignEscrow(req.user, req.params.id, intentUsd);
    emitPlatformActivity(req, {
      type: 'escrow_deposit',
      campaignId: req.params.id,
      amountUsd: preview.escrowCreditUsd,
      feeUsd: preview.feeUsd,
    });
    res.json({
      success: true,
      campaign: result.campaign,
      breakdown: result.breakdown,
      depositTx: result.depositTx,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/bids', authorize('creator'), async (req, res, next) => {
  try {
    assertWritable(req);
    const campaign = await placeBid(req.user, req.params.id, {
      amount: req.body.amount,
      proposal: req.body.proposal,
    });
    emitPlatformActivity(req, { type: 'bid_placed', campaignId: req.params.id });
    res.json({ success: true, campaign });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/bids/:bidId/accept', authorize('business'), async (req, res, next) => {
  try {
    assertWritable(req);
    const campaign = await acceptBid(req.user, req.params.id, req.params.bidId);
    emitPlatformActivity(req, { type: 'bid_accepted', campaignId: req.params.id });
    res.json({ success: true, campaign });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/submit', authorize('creator'), async (req, res, next) => {
  try {
    assertWritable(req);
    const campaign = await submitWork(req.user, req.params.id, { workUrl: req.body.workUrl });
    emitPlatformActivity(req, { type: 'work_submitted', campaignId: req.params.id });
    res.json({ success: true, campaign });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/complete', authorize('business'), async (req, res, next) => {
  try {
    assertWritable(req);
    const campaign = await completeAndPay(req.user, req.params.id);
    emitPlatformActivity(req, {
      type: 'escrow_release',
      campaignId: req.params.id,
      status: 'paid',
    });
    res.json({ success: true, campaign });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
