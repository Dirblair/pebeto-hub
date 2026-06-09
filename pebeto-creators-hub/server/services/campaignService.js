/**
 * Campaign Service for Pebeto Creator's Hub
 * 
 * Handles all campaign-related business logic including creation,
 * bidding, escrow funding, work submission, and payment processing.
 * 
 * @module services/campaignService
 */

const Campaign = require('../models/Campaign');
const User = require('../models/User');
const { AppError } = require('../utils/errors');
const { roundUsd, MIN_WITHDRAWAL_USD } = require('../services/feeService');
const { processDeposit } = require('./depositService');
const {
  getOrCreateWallet,
  recordTransaction,
  debitWallet,
  creditWallet,
  runInTransaction,
} = require('./walletService');
const logger = require('../utils/logger');

// ============================================
// Constants
// ============================================

const BUSINESS_STAGES = {
  draft: 'Draft',
  open: 'Active',
  in_progress: 'Active',
  submitted_for_review: 'Submitted for Review',
  completed: 'Completed',
  paid: 'Paid',
  disputed: 'Disputed',
  cancelled: 'Cancelled',
};

const CREATOR_STAGES = {
  bid: 'Bid',
  waiting: 'Waiting for Approval',
  completed: 'Completed',
  paid: 'Paid',
};

const DEFAULT_PAGE_LIMIT = 20;
const MAX_PAGE_LIMIT = 100;

// ============================================
// Helper Functions
// ============================================

/**
 * Sanitize user object for public display (remove PII)
 * @param {Object} user - User object
 * @returns {Object} Sanitized user
 */
function sanitizePublicUser(user) {
  if (!user) return null;
  const obj = user.toObject ? user.toObject() : { ...user };
  return {
    _id: obj._id,
    id: obj._id,
    role: obj.role,
    uniqueCode: obj.uniqueCode,
    profile: {
      stageName: obj.profile?.stageName,
      niche: obj.profile?.niche,
      companyName: obj.profile?.companyName,
      avatarUrl: obj.profile?.avatarUrl,
    },
  };
}

/**
 * Determine creator-facing stage based on campaign status and creator ID
 * @param {Object} campaign - Campaign object
 * @param {string} creatorId - Creator user ID
 * @returns {Object} Creator stage
 */
function getCreatorStage(campaign, creatorId) {
  const id = String(creatorId);
  
  if (campaign.status === 'paid') {
    return { key: 'paid', label: CREATOR_STAGES.paid };
  }
  if (campaign.status === 'completed') {
    return { key: 'completed', label: CREATOR_STAGES.completed };
  }
  if (campaign.status === 'submitted_for_review' && String(campaign.assignedCreatorId) === id) {
    return { key: 'completed', label: CREATOR_STAGES.completed };
  }
  if (['in_progress', 'submitted_for_review'].includes(campaign.status) && 
      String(campaign.assignedCreatorId) === id) {
    return { key: 'waiting', label: CREATOR_STAGES.waiting };
  }
  
  const bid = (campaign.bids || []).find((b) => String(b.creatorId) === id);
  if (bid) {
    return { key: 'bid', label: CREATOR_STAGES.bid, bidStatus: bid.status };
  }
  if (campaign.status === 'open') {
    return { key: 'bid', label: CREATOR_STAGES.bid };
  }
  
  return { key: 'bid', label: CREATOR_STAGES.bid };
}

/**
 * Format campaign for API response
 * @param {Object} campaign - Campaign document
 * @param {string} viewerRole - Role of the viewer
 * @param {string} viewerId - ID of the viewer
 * @returns {Object} Formatted campaign
 */
function formatCampaign(campaign, viewerRole, viewerId) {
  const c = campaign.toObject ? campaign.toObject() : campaign;
  const businessStage = BUSINESS_STAGES[c.status] || c.status;
  const creatorStage = viewerRole === 'creator' ? getCreatorStage(c, viewerId) : null;

  const bids = (c.bids || []).map((b) => ({
    _id: b._id,
    uniqueCode: b.uniqueCode,
    amount: b.amount,
    proposal: b.proposal,
    status: b.status,
    submittedWorkUrl: b.submittedWorkUrl,
    submittedAt: b.submittedAt,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
    creatorId: b.creatorId,
  }));

  return {
    ...c,
    businessStage,
    creatorStage,
    bids,
    escrowHeld: c.escrowHeld || 0,
    fundedAmount: c.fundedAmount || 0,
    remainingBudget: Math.max(0, (c.budget || 0) - (c.fundedAmount || 0)),
    isExpired: c.deadline ? new Date() > new Date(c.deadline) : false,
  };
}

// ============================================
// Main Service Functions
// ============================================

/**
 * List campaigns accessible to a user with pagination and filtering
 * @param {Object} user - Authenticated user
 * @param {Object} options - Query options
 * @returns {Promise<Object>} Campaigns and pagination info
 */
async function listCampaignsForUser(user, options = {}) {
  const {
    viewUserId,
    page = 1,
    limit = DEFAULT_PAGE_LIMIT,
    status,
    minBudget,
    maxBudget,
    search,
    category,
  } = options;

  const targetId = viewUserId || user._id;
  const targetUser = viewUserId ? await User.findById(viewUserId) : user;
  
  if (!targetUser) throw new AppError('User not found', 404);

  // Build query based on user role
  let query = {};
  if (targetUser.role === 'business') {
    query = { businessId: targetId };
  } else if (targetUser.role === 'creator') {
    query = {
      $or: [
        { status: 'open' },
        { assignedCreatorId: targetId },
        { 'bids.creatorId': targetId },
      ],
    };
  } else if (targetUser.role === 'admin') {
    query = {};
  }

  // Apply filters
  if (status) {
    query.status = status;
  }
  if (minBudget || maxBudget) {
    query.budget = {};
    if (minBudget) query.budget.$gte = Number(minBudget);
    if (maxBudget) query.budget.$lte = Number(maxBudget);
  }
  if (category) {
    query.category = category;
  }
  if (search) {
    query.$text = { $search: search };
  }

  const skip = (page - 1) * limit;
  const effectiveLimit = Math.min(limit, MAX_PAGE_LIMIT);

  const [campaigns, total] = await Promise.all([
    Campaign.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(effectiveLimit),
    Campaign.countDocuments(query),
  ]);

  const formattedCampaigns = campaigns.map((c) =>
    formatCampaign(c, targetUser.role, targetId)
  );

  return {
    campaigns: formattedCampaigns,
    pagination: {
      page,
      limit: effectiveLimit,
      total,
      pages: Math.ceil(total / effectiveLimit),
      hasMore: skip + campaigns.length < total,
    },
  };
}

/**
 * Get a single campaign by ID
 * @param {Object} user - Authenticated user
 * @param {string} campaignId - Campaign ID
 * @param {Object} options - Query options
 * @returns {Promise<Object>} Formatted campaign
 */
async function getCampaignById(user, campaignId, options = {}) {
  const { viewUserId } = options;
  
  const campaign = await Campaign.findById(campaignId);
  if (!campaign) throw new AppError('Campaign not found', 404);

  const role = viewUserId
    ? (await User.findById(viewUserId))?.role
    : user.role;
  const viewerId = viewUserId || user._id;

  // Authorization check
  if (user.role !== 'admin') {
    const isOwner = String(campaign.businessId) === String(viewerId);
    const isCreator =
      String(campaign.assignedCreatorId) === String(viewerId) ||
      campaign.bids.some((b) => String(b.creatorId) === String(viewerId));
    const isOpen = campaign.status === 'open';
    
    if (!isOwner && !isCreator && !isOpen) {
      throw new AppError('Forbidden: You do not have access to this campaign', 403);
    }
  }

  return formatCampaign(campaign, role, viewerId);
}

/**
 * Create a new campaign
 * @param {Object} businessUser - Business user object
 * @param {Object} payload - Campaign data
 * @returns {Promise<Object>} Created campaign
 */
async function createCampaign(businessUser, payload) {
  const { title, description, instructions, budget, deadline, category, requirements } = payload;
  
  if (!title || !budget || budget <= 0) {
    throw new AppError('Title and positive budget are required', 400);
  }

  const campaignData = {
    businessId: businessUser._id,
    title: title.trim(),
    description: description?.trim() || '',
    instructions: instructions?.trim() || '',
    budget: roundUsd(Number(budget)),
    status: 'open',
    category: category?.trim().toLowerCase(),
    requirements: requirements || [],
  };

  if (deadline) {
    campaignData.deadline = new Date(deadline);
    if (campaignData.deadline <= new Date()) {
      throw new AppError('Deadline must be in the future', 400);
    }
  }

  const campaign = await Campaign.create(campaignData);

  logger.info('Campaign created', {
    campaignId: campaign._id,
    businessId: businessUser._id,
    title: campaign.title,
    budget: campaign.budget,
  });

  return formatCampaign(campaign, 'business', businessUser._id);
}

/**
 * Fund escrow for a campaign
 * @param {Object} businessUser - Business user object
 * @param {string} campaignId - Campaign ID
 * @param {number} intentUsd - Amount to fund in USD
 * @returns {Promise<Object>} Updated campaign and transaction details
 */
async function fundCampaignEscrow(businessUser, campaignId, intentUsd) {
  const campaign = await Campaign.findOne({ _id: campaignId, businessId: businessUser._id });
  if (!campaign) throw new AppError('Campaign not found', 404);
  
  if (['paid', 'cancelled'].includes(campaign.status)) {
    throw new AppError('Cannot fund a closed campaign', 400);
  }

  const result = await processDeposit({
    businessUser,
    intentUsd: Number(intentUsd),
    campaignId: campaign._id,
    idempotencyKey: `fund-${campaign._id}-${Date.now()}`,
  });

  campaign.fundedAmount = roundUsd((campaign.fundedAmount || 0) + result.breakdown.escrowCreditUsd);
  campaign.escrowHeld = roundUsd((campaign.escrowHeld || 0) + result.breakdown.escrowCreditUsd);
  
  if (campaign.status === 'draft') {
    campaign.status = 'open';
  }
  
  await campaign.save();

  logger.info('Campaign funded', {
    campaignId: campaign._id,
    businessId: businessUser._id,
    amount: result.breakdown.escrowCreditUsd,
    fee: result.breakdown.feeUsd,
  });

  return {
    campaign: formatCampaign(campaign, 'business', businessUser._id),
    breakdown: result.breakdown,
    depositTx: result.transactionId,
  };
}

/**
 * Place a bid on a campaign
 * @param {Object} creatorUser - Creator user object
 * @param {string} campaignId - Campaign ID
 * @param {Object} bidData - Bid data (amount, proposal)
 * @returns {Promise<Object>} Updated campaign
 */
async function placeBid(creatorUser, campaignId, { amount, proposal }) {
  if (!creatorUser.uniqueCode) {
    throw new AppError('Unique code required for creators. Please complete your profile.', 400);
  }

  const campaign = await Campaign.findById(campaignId);
  if (!campaign) throw new AppError('Campaign not found', 404);
  
  if (campaign.status !== 'open') {
    throw new AppError('Campaign is not open for bids', 400);
  }

  const amt = roundUsd(Number(amount));
  if (!amt || amt <= 0) throw new AppError('Bid amount must be positive', 400);
  
  // Validate bid amount against campaign budget
  if (amt > campaign.budget) {
    throw new AppError(`Bid amount cannot exceed campaign budget of $${campaign.budget}`, 400);
  }

  // Check for existing bid
  const existingBid = campaign.bids.find((b) => String(b.creatorId) === String(creatorUser._id));
  if (existingBid) {
    throw new AppError('You have already placed a bid on this campaign', 400);
  }

  campaign.bids.push({
    creatorId: creatorUser._id,
    uniqueCode: creatorUser.uniqueCode,
    amount: amt,
    proposal: proposal?.trim() || '',
    status: 'pending',
  });
  
  await campaign.save();

  logger.info('Bid placed', {
    campaignId: campaign._id,
    creatorId: creatorUser._id,
    amount: amt,
  });

  return formatCampaign(campaign, 'creator', creatorUser._id);
}

/**
 * Accept a bid and assign the creator
 * @param {Object} businessUser - Business user object
 * @param {string} campaignId - Campaign ID
 * @param {string} bidId - Bid ID to accept
 * @returns {Promise<Object>} Updated campaign
 */
async function acceptBid(businessUser, campaignId, bidId) {
  const campaign = await Campaign.findOne({ _id: campaignId, businessId: businessUser._id });
  if (!campaign) throw new AppError('Campaign not found', 404);
  
  if (campaign.status !== 'open') {
    throw new AppError('Campaign must be open to accept bids', 400);
  }

  const bid = campaign.bids.id(bidId);
  if (!bid) throw new AppError('Bid not found', 404);
  if (bid.status !== 'pending') throw new AppError('Bid is not pending', 400);

  const payoutAmount = roundUsd(bid.amount);
  if ((campaign.escrowHeld || 0) < payoutAmount) {
    throw new AppError(
      `Insufficient escrow funds. Need $${payoutAmount} USD to accept this bid. Please fund the campaign escrow.`,
      400
    );
  }

  // Accept this bid, reject all others
  campaign.bids.forEach((b) => {
    if (String(b._id) === String(bidId)) {
      b.status = 'accepted';
    } else if (b.status === 'pending') {
      b.status = 'rejected';
    }
  });
  
  campaign.assignedCreatorId = bid.creatorId;
  campaign.status = 'in_progress';
  await campaign.save();

  logger.info('Bid accepted', {
    campaignId: campaign._id,
    businessId: businessUser._id,
    creatorId: bid.creatorId,
    amount: payoutAmount,
  });

  return formatCampaign(campaign, 'business', businessUser._id);
}

/**
 * Submit work for a campaign
 * @param {Object} creatorUser - Creator user object
 * @param {string} campaignId - Campaign ID
 * @param {Object} workData - Work data (workUrl)
 * @returns {Promise<Object>} Updated campaign
 */
async function submitWork(creatorUser, campaignId, { workUrl }) {
  const campaign = await Campaign.findOne({
    _id: campaignId,
    assignedCreatorId: creatorUser._id,
  });
  
  if (!campaign) throw new AppError('Campaign not found or you are not the assigned creator', 404);
  
  if (!['in_progress', 'submitted_for_review'].includes(campaign.status)) {
    throw new AppError(`Cannot submit work for campaign with status: ${campaign.status}`, 400);
  }
  
  if (!workUrl || !workUrl.trim()) {
    throw new AppError('Work URL is required', 400);
  }

  // Validate URL format
  const urlPattern = /^https?:\/\//i;
  if (!urlPattern.test(workUrl)) {
    throw new AppError('Work URL must start with http:// or https://', 400);
  }

  const bid = campaign.bids.find(
    (b) => String(b.creatorId) === String(creatorUser._id) && b.status === 'accepted'
  );
  
  if (bid) {
    bid.submittedWorkUrl = workUrl.trim();
    bid.submittedAt = new Date();
  }
  
  campaign.status = 'submitted_for_review';
  await campaign.save();

  logger.info('Work submitted', {
    campaignId: campaign._id,
    creatorId: creatorUser._id,
    workUrl,
  });

  return formatCampaign(campaign, 'creator', creatorUser._id);
}

/**
 * Complete campaign and release payment to creator
 * @param {Object} businessUser - Business user object
 * @param {string} campaignId - Campaign ID
 * @returns {Promise<Object>} Updated campaign
 */
async function completeAndPay(businessUser, campaignId) {
  const campaign = await Campaign.findOne({ _id: campaignId, businessId: businessUser._id });
  if (!campaign) throw new AppError('Campaign not found', 404);
  
  if (!['submitted_for_review', 'in_progress'].includes(campaign.status)) {
    throw new AppError(`Campaign must be submitted for review before completing payment. Current status: ${campaign.status}`, 400);
  }
  
  if (!campaign.assignedCreatorId) {
    throw new AppError('No creator assigned to this campaign', 400);
  }

  const bid = campaign.bids.find(
    (b) => String(b.creatorId) === String(campaign.assignedCreatorId) && b.status === 'accepted'
  );
  
  const payoutAmount = roundUsd(bid?.amount || campaign.escrowHeld || 0);
  if (payoutAmount <= 0) {
    throw new AppError('Invalid payout amount', 400);
  }

  const businessWallet = await getOrCreateWallet(businessUser._id);
  const creatorWallet = await getOrCreateWallet(campaign.assignedCreatorId);

  if ((businessWallet.balances.escrow || 0) < payoutAmount) {
    throw new AppError(
      `Insufficient escrow balance. Need $${payoutAmount} USD. Current escrow: $${businessWallet.balances.escrow}`,
      400
    );
  }

  await runInTransaction(async (session) => {
    // Move funds from business escrow to creator available balance
    await debitWallet(businessWallet._id, 'escrow', payoutAmount, session);
    await creditWallet(creatorWallet._id, 'available', payoutAmount, session);

    // Record the transaction
    await recordTransaction(
      {
        type: 'escrow_release',
        status: 'completed',
        fromUserId: businessUser._id,
        toUserId: campaign.assignedCreatorId,
        fromWalletId: businessWallet._id,
        toWalletId: creatorWallet._id,
        grossAmount: payoutAmount,
        feeAmount: 0,
        netAmount: payoutAmount,
        metadata: {
          campaignId: campaign._id,
          campaignTitle: campaign.title,
          note: 'Campaign completed — escrow released to creator wallet',
        },
      },
      session
    );

    campaign.status = 'paid';
    campaign.escrowHeld = roundUsd(Math.max(0, (campaign.escrowHeld || 0) - payoutAmount));
    campaign.completedAt = new Date();
    campaign.paidAt = new Date();
    await campaign.save({ session });
  });

  const updated = await Campaign.findById(campaignId);
  
  logger.info('Campaign completed and paid', {
    campaignId: campaign._id,
    businessId: businessUser._id,
    creatorId: campaign.assignedCreatorId,
    amount: payoutAmount,
  });

  return formatCampaign(updated, 'business', businessUser._id);
}

/**
 * Cancel a campaign and refund escrow if applicable
 * @param {Object} businessUser - Business user object
 * @param {string} campaignId - Campaign ID
 * @param {string} reason - Cancellation reason
 * @returns {Promise<Object>} Updated campaign
 */
async function cancelCampaign(businessUser, campaignId, reason = null) {
  const campaign = await Campaign.findOne({ _id: campaignId, businessId: businessUser._id });
  if (!campaign) throw new AppError('Campaign not found', 404);
  
  if (['paid', 'cancelled'].includes(campaign.status)) {
    throw new AppError(`Cannot cancel a campaign with status: ${campaign.status}`, 400);
  }

  const businessWallet = await getOrCreateWallet(businessUser._id);
  const escrowAmount = campaign.escrowHeld || 0;

  await runInTransaction(async (session) => {
    // Refund escrow to available balance if any funds are in escrow
    if (escrowAmount > 0) {
      await debitWallet(businessWallet._id, 'escrow', escrowAmount, session);
      await creditWallet(businessWallet._id, 'available', escrowAmount, session);

      await recordTransaction(
        {
          type: 'escrow_refund',
          status: 'completed',
          fromUserId: businessUser._id,
          toUserId: businessUser._id,
          fromWalletId: businessWallet._id,
          toWalletId: businessWallet._id,
          grossAmount: escrowAmount,
          feeAmount: 0,
          netAmount: escrowAmount,
          metadata: {
            campaignId: campaign._id,
            campaignTitle: campaign.title,
            note: `Campaign cancelled. Escrow refunded. Reason: ${reason || 'Not provided'}`,
          },
        },
        session
      );
    }

    campaign.status = 'cancelled';
    campaign.cancelledAt = new Date();
    campaign.disputeReason = reason;
    campaign.escrowHeld = 0;
    await campaign.save({ session });
  });

  logger.info('Campaign cancelled', {
    campaignId: campaign._id,
    businessId: businessUser._id,
    escrowRefunded: escrowAmount,
    reason,
  });

  return formatCampaign(campaign, 'business', businessUser._id);
}

// ============================================
// Exports
// ============================================

module.exports = {
  BUSINESS_STAGES,
  CREATOR_STAGES,
  sanitizePublicUser,
  listCampaignsForUser,
  createCampaign,
  fundCampaignEscrow,
  placeBid,
  acceptBid,
  submitWork,
  completeAndPay,
  cancelCampaign,
  getCampaignById,
};
