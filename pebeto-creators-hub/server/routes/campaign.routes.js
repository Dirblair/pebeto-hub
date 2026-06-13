/**
 * Campaign Routes for Pebeto Creator's Hub
 * 
 * Handles campaign management, bidding, escrow funding,
 * work submission, and campaign completion.
 * 
 * @module routes/campaign
 */

const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const { authenticate, authorize } = require('../middleware/auth');
const { attachFeeService } = require('../services/feeService');
const { AppError } = require('../utils/errors');
const { catchAsync } = require('../middleware/errorHandler');
const logger = require('../utils/logger');
const {
  listCampaignsForUser,
  createCampaign,
  fundCampaignEscrow,
  placeBid,
  acceptBid,
  submitWork,
  completeAndPay,
  getCampaignById,
  cancelCampaign,
} = require('../services/campaignService');

const router = express.Router();

// ============================================
// Middleware
// ============================================

router.use(authenticate, attachFeeService);

/**
 * Emit platform activity via Socket.IO
 * @param {Object} req - Express request object
 * @param {Object} payload - Activity payload
 */
function emitPlatformActivity(req, payload) {
  const io = req.app.get('io');
  if (io) {
    io.to('status:global').emit('platform:activity', payload);
    logger.debug('Platform activity emitted', payload);
  }
}

/**
 * Check if request is in view-only mode
 * @param {Object} req - Express request object
 * @throws {AppError} If view-only mode is active
 */
function assertWritable(req) {
  if (req.query.viewOnly === '1' && req.user.role === 'admin') {
    throw new AppError('View-only mode: changes are disabled', 403);
  }
  if (req.query.viewOnly === '1') {
    throw new AppError('View-only mode: changes are disabled', 403);
  }
}

// ============================================
// Validation Rules
// ============================================

const createCampaignValidation = [
  body('title')
    .trim()
    .notEmpty()
    .withMessage('Campaign title is required')
    .isLength({ min: 3, max: 200 })
    .withMessage('Title must be between 3 and 200 characters'),
  body('budget')
    .isFloat({ min: 1 })
    .withMessage('Budget must be at least $1'),
  body('description')
    .optional()
    .trim()
    .isLength({ max: 5000 })
    .withMessage('Description cannot exceed 5000 characters'),
  body('instructions')
    .optional()
    .trim()
    .isLength({ max: 2000 })
    .withMessage('Instructions cannot exceed 2000 characters'),
  body('deadline')
    .optional()
    .isISO8601()
    .withMessage('Invalid deadline format')
    .custom((value) => new Date(value) > new Date())
    .withMessage('Deadline must be in the future'),
  body('category')
    .optional()
    .isString()
    .trim(),
  body('requirements')
    .optional()
    .isArray()
    .withMessage('Requirements must be an array'),
];

const fundCampaignValidation = [
  param('id').isMongoId().withMessage('Invalid campaign ID'),
  body('intentUsd')
    .isFloat({ min: 1 })
    .withMessage('Intent amount must be at least $1')
    .toFloat(),
];

const placeBidValidation = [
  param('id').isMongoId().withMessage('Invalid campaign ID'),
  body('amount')
    .isFloat({ min: 1 })
    .withMessage('Bid amount must be at least $1'),
  body('proposal')
    .optional()
    .trim()
    .isLength({ max: 2000 })
    .withMessage('Proposal cannot exceed 2000 characters'),
];

const acceptBidValidation = [
  param('id').isMongoId().withMessage('Invalid campaign ID'),
  param('bidId').isMongoId().withMessage('Invalid bid ID'),
];

const submitWorkValidation = [
  param('id').isMongoId().withMessage('Invalid campaign ID'),
  body('workUrl')
    .notEmpty()
    .withMessage('Work URL is required')
    .isURL({ protocols: ['http', 'https'], require_protocol: true })
    .withMessage('Please provide a valid URL starting with http:// or https://'),
];

const completeCampaignValidation = [
  param('id').isMongoId().withMessage('Invalid campaign ID'),
];

const cancelCampaignValidation = [
  param('id').isMongoId().withMessage('Invalid campaign ID'),
  body('reason')
    .optional()
    .trim()
    .isLength({ max: 500 })
    .withMessage('Reason cannot exceed 500 characters'),
];

const listCampaignsValidation = [
  query('page')
    .optional()
    .isInt({ min: 1 })
    .withMessage('Page must be a positive integer')
    .toInt(),
  query('limit')
    .optional()
    .isInt({ min: 1, max: 100 })
    .withMessage('Limit must be between 1 and 100')
    .toInt(),
  query('status')
    .optional()
    .isIn(['open', 'in_progress', 'submitted_for_review', 'completed', 'paid', 'cancelled'])
    .withMessage('Invalid status filter'),
];

// ============================================
// Routes
// ============================================

/**
 * GET /api/campaigns
 * List campaigns accessible to the authenticated user
 */
router.get('/', listCampaignsValidation, catchAsync(async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    throw new AppError(errors.array()[0].msg, 400);
  }

  const viewUserId = req.query.userId;
  const page = parseInt(req.query.page) || 1;
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const statusFilter = req.query.status;

  if (viewUserId && req.user.role !== 'admin') {
    throw new AppError('Forbidden: Cannot view other users campaigns', 403);
  }

  const result = await listCampaignsForUser(req.user, {
    viewUserId,
    page,
    limit,
    status: statusFilter,
  });

  res.json({
    success: true,
    data: {
      campaigns: result.campaigns,
      pagination: result.pagination,
      viewOnly: req.query.viewOnly === '1',
    },
  });
}));

/**
 * GET /api/campaigns/:id
 * Get a specific campaign by ID
 */
router.get('/:id', [
  param('id').isMongoId().withMessage('Invalid campaign ID'),
], catchAsync(async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    throw new AppError(errors.array()[0].msg, 400);
  }

  const viewUserId = req.query.userId;

  if (viewUserId && req.user.role !== 'admin') {
    throw new AppError('Forbidden', 403);
  }

  const campaign = await getCampaignById(req.user, req.params.id, { viewUserId });

  res.json({
    success: true,
    data: {
      campaign,
      viewOnly: req.query.viewOnly === '1',
    },
  });
}));

/**
 * POST /api/campaigns
 * Create a new campaign (Business only)
 */
router.post(
  '/',
  authorize('business'),
  createCampaignValidation,
  catchAsync(async (req, res, next) => {
    assertWritable(req);

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new AppError(errors.array()[0].msg, 400);
    }

    const campaign = await createCampaign(req.user, req.body);

    emitPlatformActivity(req, {
      type: 'campaign_created',
      campaignId: campaign._id,
      campaignTitle: campaign.title,
      businessId: req.user._id,
    });

    logger.info('Campaign created', {
      campaignId: campaign._id,
      businessId: req.user._id,
      title: campaign.title,
      budget: campaign.budget,
    });

    res.status(201).json({
      success: true,
      data: { campaign },
    });
  })
);

/**
 * POST /api/campaigns/:id/fund
 * Fund escrow for a campaign (Business only)
 */
router.post(
  '/:id/fund',
  authorize('business'),
  fundCampaignValidation,
  catchAsync(async (req, res, next) => {
    assertWritable(req);

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new AppError(errors.array()[0].msg, 400);
    }

    const intentUsd = Number(req.body.intentUsd);
    const preview = req.feeService.calculateDeposit(intentUsd);
    
    const result = await fundCampaignEscrow(req.user, req.params.id, intentUsd);

    emitPlatformActivity(req, {
      type: 'escrow_deposit',
      campaignId: req.params.id,
      amountUsd: preview.escrowCreditUsd,
      feeUsd: preview.feeUsd,
    });

    logger.info('Campaign funded', {
      campaignId: req.params.id,
      businessId: req.user._id,
      intentUsd,
      totalChargeUsd: preview.totalChargeUsd,
    });

    res.json({
      success: true,
      data: {
        campaign: result.campaign,
        breakdown: result.breakdown,
        depositTx: result.depositTx,
      },
    });
  })
);

/**
 * POST /api/campaigns/:id/bids
 * Place a bid on a campaign (Creator only)
 */
router.post(
  '/:id/bids',
  authorize('creator'),
  placeBidValidation,
  catchAsync(async (req, res, next) => {
    assertWritable(req);

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new AppError(errors.array()[0].msg, 400);
    }

    const campaign = await placeBid(req.user, req.params.id, {
      amount: req.body.amount,
      proposal: req.body.proposal,
    });

    emitPlatformActivity(req, {
      type: 'bid_placed',
      campaignId: req.params.id,
      creatorId: req.user._id,
      amount: req.body.amount,
    });

    logger.info('Bid placed', {
      campaignId: req.params.id,
      creatorId: req.user._id,
      amount: req.body.amount,
    });

    res.json({
      success: true,
      data: { campaign },
    });
  })
);

/**
 * POST /api/campaigns/:id/bids/:bidId/accept
 * Accept a bid and assign creator (Business only)
 */
router.post(
  '/:id/bids/:bidId/accept',
  authorize('business'),
  acceptBidValidation,
  catchAsync(async (req, res, next) => {
    assertWritable(req);

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new AppError(errors.array()[0].msg, 400);
    }

    const campaign = await acceptBid(req.user, req.params.id, req.params.bidId);

    emitPlatformActivity(req, {
      type: 'bid_accepted',
      campaignId: req.params.id,
      bidId: req.params.bidId,
    });

    logger.info('Bid accepted', {
      campaignId: req.params.id,
      bidId: req.params.bidId,
      businessId: req.user._id,
    });

    res.json({
      success: true,
      data: { campaign },
    });
  })
);

/**
 * POST /api/campaigns/:id/submit
 * Submit work for a campaign (Creator only)
 */
router.post(
  '/:id/submit',
  authorize('creator'),
  submitWorkValidation,
  catchAsync(async (req, res, next) => {
    assertWritable(req);

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new AppError(errors.array()[0].msg, 400);
    }

    const campaign = await submitWork(req.user, req.params.id, {
      workUrl: req.body.workUrl,
    });

    emitPlatformActivity(req, {
      type: 'work_submitted',
      campaignId: req.params.id,
      creatorId: req.user._id,
    });

    logger.info('Work submitted', {
      campaignId: req.params.id,
      creatorId: req.user._id,
      workUrl: req.body.workUrl,
    });

    res.json({
      success: true,
      data: { campaign },
    });
  })
);

/**
 * POST /api/campaigns/:id/complete
 * Complete campaign and release payment (Business only)
 */
router.post(
  '/:id/complete',
  authorize('business'),
  completeCampaignValidation,
  catchAsync(async (req, res, next) => {
    assertWritable(req);

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new AppError(errors.array()[0].msg, 400);
    }

    const campaign = await completeAndPay(req.user, req.params.id);

    emitPlatformActivity(req, {
      type: 'escrow_release',
      campaignId: req.params.id,
      status: 'paid',
    });

    logger.info('Campaign completed and paid', {
      campaignId: req.params.id,
      businessId: req.user._id,
      assignedCreatorId: campaign.assignedCreatorId,
    });

    res.json({
      success: true,
      data: { campaign },
    });
  })
);

/**
 * POST /api/campaigns/:id/cancel
 * Cancel a campaign (Business only)
 */
router.post(
  '/:id/cancel',
  authorize('business'),
  cancelCampaignValidation,
  catchAsync(async (req, res, next) => {
    assertWritable(req);

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new AppError(errors.array()[0].msg, 400);
    }

    const { reason } = req.body;
    const campaign = await cancelCampaign(req.user, req.params.id, reason);

    emitPlatformActivity(req, {
      type: 'campaign_cancelled',
      campaignId: req.params.id,
      reason: reason || 'No reason provided',
    });

    logger.info('Campaign cancelled', {
      campaignId: req.params.id,
      businessId: req.user._id,
      reason,
    });

    res.json({
      success: true,
      message: 'Campaign cancelled successfully',
      data: { campaign },
    });
  })
);

// ============================================
// NEW: GET /api/campaigns/performance
// Get campaign performance metrics for analytics
// ============================================
router.get('/performance', catchAsync(async (req, res) => {
  const userId = req.user._id;
  const userRole = req.user.role;
  
  let campaignQuery = {};
  
  if (userRole === 'business') {
    campaignQuery = { businessId: userId };
  } else if (userRole === 'creator') {
    campaignQuery = { assignedCreatorId: userId };
  }
  // Admin sees all campaigns
  
  const Campaign = require('../models/Campaign');
  const campaigns = await Campaign.find(campaignQuery)
    .select('title status budget views bids createdAt completedAt ctr roi')
    .sort({ createdAt: -1 })
    .limit(10);
  
  // Calculate performance metrics
  const totalViews = campaigns.reduce((sum, c) => sum + (c.views || 0), 0);
  const totalBudget = campaigns.reduce((sum, c) => sum + (c.budget || 0), 0);
  const completedCampaigns = campaigns.filter(c => c.status === 'paid').length;
  const totalCampaigns = campaigns.length;
  
  // Calculate average CTR (Click Through Rate)
  const avgCtr = totalCampaigns > 0 
    ? campaigns.reduce((sum, c) => sum + (c.ctr || 0), 0) / totalCampaigns 
    : 0;
  
  // Calculate ROI for completed campaigns
  let totalRoi = 0;
  let roiCount = 0;
  campaigns.forEach(c => {
    if (c.status === 'paid' && c.roi) {
      totalRoi += c.roi;
      roiCount++;
    }
  });
  const avgRoi = roiCount > 0 ? totalRoi / roiCount : 0;
  
  // Engagement score calculation
  const engagementScore = totalCampaigns > 0
    ? Math.min(100, Math.round((totalViews / Math.max(totalBudget, 1)) * 10))
    : 0;
  
  // Prepare chart data
  const labels = campaigns.slice(0, 7).map(c => c.title?.substring(0, 20) || 'Untitled');
  const viewsData = campaigns.slice(0, 7).map(c => c.views || 0);
  const engagementData = campaigns.slice(0, 7).map(c => {
    const engagement = c.status === 'paid' ? 85 : c.status === 'in_progress' ? 45 : 20;
    return engagement;
  });
  
  res.json({
    success: true,
    data: {
      performance: {
        totalViews,
        totalBudget,
        completedCampaigns,
        totalCampaigns,
        ctr: Math.round(avgCtr * 100) / 100,
        roi: Math.round(avgRoi * 100) / 100,
        engagementScore
      },
      chart: {
        labels,
        views: viewsData,
        engagement: engagementData
      },
      campaigns: campaigns.map(c => ({
        id: c._id,
        title: c.title,
        status: c.status,
        budget: c.budget,
        views: c.views || 0,
        ctr: c.ctr || 0,
        roi: c.roi || 0,
        createdAt: c.createdAt
      }))
    }
  });
}));

module.exports = router;
