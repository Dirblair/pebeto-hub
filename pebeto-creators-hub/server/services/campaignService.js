const Campaign = require('../models/Campaign');
const User = require('../models/User');
const { AppError } = require('../utils/errors');
const { roundUsd } = require('../middleware/feeService');
const { processDeposit } = require('./depositService');
const {
  getOrCreateWallet,
  recordTransaction,
  debitWallet,
  creditWallet,
  runInTransaction,
} = require('./walletService');

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

function getCreatorStage(campaign, creatorId) {
  const id = String(creatorId);
  if (campaign.status === 'paid') return { key: 'paid', label: CREATOR_STAGES.paid };
  if (campaign.status === 'completed') return { key: 'completed', label: CREATOR_STAGES.completed };
  if (campaign.status === 'submitted_for_review' && String(campaign.assignedCreatorId) === id) {
    return { key: 'completed', label: CREATOR_STAGES.completed };
  }
  if (['in_progress', 'submitted_for_review'].includes(campaign.status) && String(campaign.assignedCreatorId) === id) {
    return { key: 'waiting', label: CREATOR_STAGES.waiting };
  }
  const bid = (campaign.bids || []).find((b) => String(b.creatorId) === id);
  if (bid) return { key: 'bid', label: CREATOR_STAGES.bid, bidStatus: bid.status };
  if (campaign.status === 'open') return { key: 'bid', label: CREATOR_STAGES.bid };
  return { key: 'bid', label: CREATOR_STAGES.bid };
}

function formatCampaign(campaign, viewerRole, viewerId) {
  const c = campaign.toObject ? campaign.toObject() : campaign;
  const businessStage = BUSINESS_STAGES[c.status] || c.status;
  const creatorStage =
    viewerRole === 'creator' ? getCreatorStage(c, viewerId) : null;

  const bids = (c.bids || []).map((b) => ({
    _id: b._id,
    uniqueCode: b.uniqueCode,
    amount: b.amount,
    proposal: b.proposal,
    status: b.status,
    submittedWorkUrl: b.submittedWorkUrl,
    submittedAt: b.submittedAt,
    creatorId: b.creatorId,
  }));

  return {
    ...c,
    businessStage,
    creatorStage,
    bids,
    escrowHeld: c.escrowHeld || 0,
    fundedAmount: c.fundedAmount || 0,
  };
}

async function listCampaignsForUser(user, { viewUserId } = {}) {
  const targetId = viewUserId || user._id;
  const targetUser = viewUserId ? await User.findById(viewUserId) : user;
  if (!targetUser) throw new AppError('User not found', 404);

  let query;
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
  } else {
    query = {};
  }

  const campaigns = await Campaign.find(query).sort({ updatedAt: -1 }).limit(100);
  return campaigns.map((c) =>
    formatCampaign(c, targetUser.role, targetId)
  );
}

async function createCampaign(businessUser, payload) {
  const { title, description, instructions, budget } = payload;
  if (!title || !budget || budget <= 0) {
    throw new AppError('Title and positive budget are required', 400);
  }
  const campaign = await Campaign.create({
    businessId: businessUser._id,
    title,
    description,
    instructions,
    budget: roundUsd(Number(budget)),
    status: 'open',
  });
  return formatCampaign(campaign, 'business', businessUser._id);
}

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
  if (campaign.status === 'draft') campaign.status = 'open';
  await campaign.save();

  return { campaign: formatCampaign(campaign, 'business', businessUser._id), ...result };
}

async function placeBid(creatorUser, campaignId, { amount, proposal }) {
  if (!creatorUser.uniqueCode) throw new AppError('Unique code required for creators', 400);
  const campaign = await Campaign.findById(campaignId);
  if (!campaign || campaign.status !== 'open') {
    throw new AppError('Campaign is not open for bids', 400);
  }
  const amt = roundUsd(Number(amount));
  if (!amt || amt <= 0) throw new AppError('Bid amount must be positive', 400);

  const existing = campaign.bids.find((b) => String(b.creatorId) === String(creatorUser._id));
  if (existing) throw new AppError('You already placed a bid on this campaign', 400);

  campaign.bids.push({
    creatorId: creatorUser._id,
    uniqueCode: creatorUser.uniqueCode,
    amount: amt,
    proposal: proposal || '',
    status: 'pending',
  });
  await campaign.save();
  return formatCampaign(campaign, 'creator', creatorUser._id);
}

async function acceptBid(businessUser, campaignId, bidId) {
  const campaign = await Campaign.findOne({ _id: campaignId, businessId: businessUser._id });
  if (!campaign) throw new AppError('Campaign not found', 404);

  const bid = campaign.bids.id(bidId);
  if (!bid) throw new AppError('Bid not found', 404);
  if (bid.status !== 'pending') throw new AppError('Bid is not pending', 400);

  const payoutAmount = roundUsd(bid.amount);
  if ((campaign.escrowHeld || 0) < payoutAmount) {
    throw new AppError(
      `Escrow must cover the bid ($${payoutAmount} USD). Fund escrow before accepting.`,
      400
    );
  }

  campaign.bids.forEach((b) => {
    if (String(b._id) === String(bidId)) b.status = 'accepted';
    else if (b.status === 'pending') b.status = 'rejected';
  });
  campaign.assignedCreatorId = bid.creatorId;
  campaign.status = 'in_progress';
  await campaign.save();
  return formatCampaign(campaign, 'business', businessUser._id);
}

async function submitWork(creatorUser, campaignId, { workUrl }) {
  const campaign = await Campaign.findOne({
    _id: campaignId,
    assignedCreatorId: creatorUser._id,
  });
  if (!campaign) throw new AppError('Campaign not found', 404);
  if (!['in_progress', 'completed'].includes(campaign.status)) {
    throw new AppError('Cannot submit work for this campaign status', 400);
  }
  if (!workUrl) throw new AppError('Work URL is required', 400);

  const bid = campaign.bids.find((b) => String(b.creatorId) === String(creatorUser._id) && b.status === 'accepted');
  if (bid) {
    bid.submittedWorkUrl = workUrl;
    bid.submittedAt = new Date();
  }
  campaign.status = 'submitted_for_review';
  await campaign.save();
  return formatCampaign(campaign, 'creator', creatorUser._id);
}

async function completeAndPay(businessUser, campaignId) {
  const campaign = await Campaign.findOne({ _id: campaignId, businessId: businessUser._id });
  if (!campaign) throw new AppError('Campaign not found', 404);
  if (!['submitted_for_review', 'completed'].includes(campaign.status)) {
    throw new AppError('Campaign must be submitted for review before completing payment', 400);
  }
  if (!campaign.assignedCreatorId) throw new AppError('No creator assigned', 400);

  const bid = campaign.bids.find(
    (b) => String(b.creatorId) === String(campaign.assignedCreatorId) && b.status === 'accepted'
  );
  const payoutAmount = roundUsd(bid?.amount || campaign.escrowHeld || 0);
  if (payoutAmount <= 0) throw new AppError('Invalid payout amount', 400);

  const businessWallet = await getOrCreateWallet(businessUser._id);
  const creatorWallet = await getOrCreateWallet(campaign.assignedCreatorId);

  if (businessWallet.balances.escrow < payoutAmount) {
    throw new AppError(
      `Insufficient escrow balance. Need $${payoutAmount} USD in escrow.`,
      400
    );
  }

  await runInTransaction(async (session) => {
    await debitWallet(businessWallet._id, 'escrow', payoutAmount, session);
    await creditWallet(creatorWallet._id, 'available', payoutAmount, session);

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
          note: 'Campaign complete — escrow to creator wallet',
        },
      },
      session
    );

    campaign.status = 'paid';
    campaign.escrowHeld = roundUsd(Math.max(0, (campaign.escrowHeld || 0) - payoutAmount));
    await campaign.save({ session });
  });

  const updated = await Campaign.findById(campaignId);
  return formatCampaign(updated, 'business', businessUser._id);
}

async function getCampaignById(user, campaignId, { viewUserId } = {}) {
  const campaign = await Campaign.findById(campaignId);
  if (!campaign) throw new AppError('Campaign not found', 404);

  const role = viewUserId
    ? (await User.findById(viewUserId))?.role
    : user.role;
  const viewerId = viewUserId || user._id;

  if (user.role !== 'admin') {
    const isOwner = String(campaign.businessId) === String(viewerId);
    const isCreator =
      String(campaign.assignedCreatorId) === String(viewerId) ||
      campaign.bids.some((b) => String(b.creatorId) === String(viewerId));
    const isOpen = campaign.status === 'open';
    if (!isOwner && !isCreator && !isOpen) throw new AppError('Forbidden', 403);
  }

  return formatCampaign(campaign, role, viewerId);
}

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
  getCampaignById,
};
