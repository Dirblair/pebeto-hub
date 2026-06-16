/**
 * Auto-Release Escrow Service for Pebeto Creator's Hub
 * 
 * Handles automatic escrow release when brands fail to approve work within 7 days.
 * Features:
 * - Checks for campaigns pending auto-release
 * - Sends reminder notifications at scheduled intervals
 * - Automatically releases funds to creator when deadline passes
 * - Logs all auto-release actions for audit
 * 
 * @module services/autoReleaseService
 */

const mongoose = require('mongoose');
const Campaign = require('../models/Campaign');
const User = require('../models/User');
const Notification = require('../models/Notification');
const { NOTIFICATION_TYPES, NOTIFICATION_PRIORITIES } = require('../models/Notification');
const {
  getOrCreateWallet,
  getAdminProfitWallet,
  recordTransaction,
  debitWallet,
  creditWallet,
  runInTransaction
} = require('./walletService');
const { roundUsd } = require('./feeService');
const logger = require('../utils/logger');

// ============================================
// Constants
// ============================================

const AUTO_RELEASE_DAYS = parseInt(process.env.AUTO_RELEASE_DAYS) || 7;
const REMINDER_SCHEDULE = [6, 5, 4, 3, 2, 1, 0.5]; // Days before deadline to send reminders
const REMINDER_HOURS = [168, 144, 120, 96, 72, 48, 24, 12]; // Hours before deadline

/**
 * Reminder urgency levels
 */
const REMINDER_URGENCY = {
  LOW: { days: 6, priority: 'low', message: 'reminder' },
  MEDIUM: { days: 3, priority: 'medium', message: 'warning' },
  HIGH: { days: 1, priority: 'high', message: 'urgent' },
  CRITICAL: { hours: 12, priority: 'urgent', message: 'final warning' }
};

// ============================================
// Main Processing Function
// ============================================

/**
 * Process all campaigns pending auto-release
 * This function should be called by a cron job every hour
 * @returns {Promise<Object>} Processing results
 */
async function processAutoReleaseQueue() {
  logger.info('🔄 Processing auto-release queue...');
  const startTime = Date.now();
  
  const results = {
    processed: 0,
    autoReleased: 0,
    remindersSent: 0,
    errors: 0,
    details: []
  };
  
  try {
    // Find campaigns where:
    // 1. Creator marked work completed
    // 2. Business has not approved yet
    // 3. Status is submitted_for_review or in_progress
    // 4. Auto-release status is pending or reminding
    const campaigns = await Campaign.find({
      creatorWorkCompleted: true,
      businessWorkApproved: false,
      status: { $in: ['submitted_for_review', 'in_progress'] },
      autoReleaseStatus: { $in: ['pending', 'reminding'] }
    }).populate('businessId assignedCreatorId');
    
    logger.info(`Found ${campaigns.length} campaigns in auto-release queue`);
    
    for (const campaign of campaigns) {
      try {
        const result = await processSingleCampaign(campaign);
        results.processed++;
        
        if (result.action === 'auto_released') {
          results.autoReleased++;
          results.details.push({
            campaignId: campaign._id,
            campaignTitle: campaign.title,
            action: 'auto_released',
            amount: result.amount,
            creatorId: campaign.assignedCreatorId?._id,
            businessId: campaign.businessId?._id
          });
        } else if (result.action === 'reminder_sent') {
          results.remindersSent++;
          results.details.push({
            campaignId: campaign._id,
            campaignTitle: campaign.title,
            action: 'reminder_sent',
            reminderLevel: result.reminderLevel,
            daysRemaining: result.daysRemaining
          });
        }
      } catch (error) {
        results.errors++;
        results.details.push({
          campaignId: campaign._id,
          error: error.message
        });
        logger.error(`Error processing campaign ${campaign._id}:`, error.message);
      }
    }
  } catch (error) {
    logger.error('Fatal error in auto-release queue:', error);
  }
  
  const duration = Date.now() - startTime;
  logger.info(`✅ Auto-release queue completed: ${results.processed} processed, ${results.autoReleased} released, ${results.remindersSent} reminders in ${duration}ms`);
  
  return results;
}

/**
 * Process a single campaign
 * @param {Object} campaign - Campaign document
 * @returns {Promise<Object>} Result object
 */
async function processSingleCampaign(campaign) {
  const now = new Date();
  const deadline = new Date(campaign.autoReleaseDeadline);
  const hoursRemaining = (deadline - now) / (1000 * 60 * 60);
  const daysRemaining = hoursRemaining / 24;
  
  // Case 1: Deadline has passed - AUTO RELEASE
  if (now >= deadline) {
    return await executeAutoRelease(campaign);
  }
  
  // Case 2: Send reminders at scheduled intervals
  const reminderNeeded = shouldSendReminder(campaign, daysRemaining, hoursRemaining);
  if (reminderNeeded) {
    return await sendReminder(campaign, daysRemaining, hoursRemaining);
  }
  
  return { action: 'none' };
}

/**
 * Determine if a reminder should be sent
 * @param {Object} campaign - Campaign document
 * @param {number} daysRemaining - Days until deadline
 * @param {number} hoursRemaining - Hours until deadline
 * @returns {boolean}
 */
function shouldSendReminder(campaign, daysRemaining, hoursRemaining) {
  // Don't send more than one reminder per 12 hours
  const lastReminder = campaign.lastReminderSentAt;
  const now = new Date();
  
  if (lastReminder && (now - lastReminder) < (12 * 60 * 60 * 1000)) {
    return false;
  }
  
  // Check if we should send reminder at this threshold
  const sentCount = campaign.autoReleaseReminderSent || 0;
  
  // Check day-based reminders
  for (let i = 0; i < REMINDER_SCHEDULE.length; i++) {
    const reminderDay = REMINDER_SCHEDULE[i];
    if (daysRemaining <= reminderDay && daysRemaining > reminderDay - 1) {
      if (sentCount <= i) {
        return true;
      }
    }
  }
  
  // Check hour-based for final hours
  if (hoursRemaining <= 24 && hoursRemaining > 0) {
    if (hoursRemaining <= 12 && sentCount < 7) {
      return true;
    }
    if (hoursRemaining <= 24 && hoursRemaining > 12 && sentCount < 6) {
      return true;
    }
  }
  
  return false;
}

/**
 * Send reminder notification to business
 * @param {Object} campaign - Campaign document
 * @param {number} daysRemaining - Days until deadline
 * @param {number} hoursRemaining - Hours until deadline
 * @returns {Promise<Object>} Result object
 */
async function sendReminder(campaign, daysRemaining, hoursRemaining) {
  let urgency = REMINDER_URGENCY.LOW;
  let title = '';
  let message = '';
  let priority = NOTIFICATION_PRIORITIES.MEDIUM;
  
  // Determine urgency level
  if (hoursRemaining <= 12) {
    urgency = REMINDER_URGENCY.CRITICAL;
    title = '⏰ FINAL WARNING: Auto-Release Imminent';
    message = `Funds for "${campaign.title}" will be AUTO-RELEASED to the creator in ${Math.ceil(hoursRemaining)} hours because you have not approved the work. Please review immediately!`;
    priority = NOTIFICATION_PRIORITIES.URGENT;
  } else if (daysRemaining <= 1) {
    urgency = REMINDER_URGENCY.HIGH;
    title = '⚠️ URGENT: Approve Work Within 24 Hours';
    message = `You have less than 24 hours to review "${campaign.title}". Funds will auto-release to the creator if no action is taken.`;
    priority = NOTIFICATION_PRIORITIES.HIGH;
  } else if (daysRemaining <= 3) {
    urgency = REMINDER_URGENCY.MEDIUM;
    title = '📋 Reminder: Work Awaiting Your Approval';
    message = `You have ${Math.ceil(daysRemaining)} days left to review "${campaign.title}". Please approve the work or contact the creator.`;
    priority = NOTIFICATION_PRIORITIES.MEDIUM;
  } else {
    urgency = REMINDER_URGENCY.LOW;
    title = '📋 Work Ready for Review';
    message = `The creator has completed work for "${campaign.title}". Please review and approve within ${Math.ceil(daysRemaining)} days.`;
    priority = NOTIFICATION_PRIORITIES.LOW;
  }
  
  // Save notification to database
  if (campaign.businessId) {
    await Notification.createNotification({
      userId: campaign.businessId._id,
      type: NOTIFICATION_TYPES.WORK_SUBMITTED,
      title,
      message,
      priority,
      actionUrl: `/campaign.html?id=${campaign._id}`,
      actionType: 'campaign',
      metadata: {
        campaignTitle: campaign.title,
        daysRemaining: daysRemaining.toFixed(1),
        hoursRemaining: Math.ceil(hoursRemaining),
        autoReleaseDate: campaign.autoReleaseDeadline,
        reminderNumber: (campaign.autoReleaseReminderSent || 0) + 1
      }
    });
    
    // Send real-time notification via Socket.IO
    const io = require('../sockets');
    if (io && io.sendNotificationToUser) {
      io.sendNotificationToUser(global.io, campaign.businessId._id, {
        title,
        message,
        type: 'auto_release_reminder',
        campaignId: campaign._id,
        daysRemaining: daysRemaining.toFixed(1)
      });
    }
    
    // Send email notification if enabled
    const emailService = require('./emailService');
    if (emailService && emailService.sendWorkReminderEmail) {
      await emailService.sendWorkReminderEmail(campaign.businessId.email, {
        campaignTitle: campaign.title,
        daysRemaining: daysRemaining.toFixed(1),
        hoursRemaining: Math.ceil(hoursRemaining),
        deadline: campaign.autoReleaseDeadline,
        campaignUrl: `${process.env.CLIENT_ORIGIN}/campaign.html?id=${campaign._id}`
      }).catch(e => logger.warn('Email reminder failed:', e.message));
    }
  }
  
  // Update campaign reminder tracking
  campaign.autoReleaseReminderSent = (campaign.autoReleaseReminderSent || 0) + 1;
  campaign.lastReminderSentAt = new Date();
  campaign.autoReleaseStatus = 'reminding';
  await campaign.save();
  
  logger.info(`Reminder sent for campaign ${campaign._id}`, {
    campaignTitle: campaign.title,
    daysRemaining: daysRemaining.toFixed(1),
    reminderCount: campaign.autoReleaseReminderSent,
    businessEmail: campaign.businessId?.email
  });
  
  return {
    action: 'reminder_sent',
    reminderLevel: urgency.message,
    daysRemaining: daysRemaining.toFixed(1),
    hoursRemaining: Math.ceil(hoursRemaining)
  };
}

/**
 * Execute auto-release of escrow funds
 * @param {Object} campaign - Campaign document
 * @returns {Promise<Object>} Result object
 */
async function executeAutoRelease(campaign) {
  // Check if already processed
  if (campaign.autoReleaseStatus === 'completed') {
    return { action: 'already_processed' };
  }
  
  if (!campaign.assignedCreatorId) {
    logger.error(`Cannot auto-release campaign ${campaign._id}: No creator assigned`);
    campaign.autoReleaseStatus = 'failed';
    await campaign.save();
    return { action: 'failed', reason: 'No creator assigned' };
  }
  
  const bid = campaign.bids.find(
    b => String(b.creatorId) === String(campaign.assignedCreatorId) && b.status === 'accepted'
  );
  
  const payoutAmount = roundUsd(bid?.amount || campaign.escrowHeld || 0);
  if (payoutAmount <= 0) {
    logger.error(`Cannot auto-release campaign ${campaign._id}: Invalid payout amount`);
    campaign.autoReleaseStatus = 'failed';
    await campaign.save();
    return { action: 'failed', reason: 'Invalid payout amount' };
  }
  
  const businessWallet = await getOrCreateWallet(campaign.businessId._id);
  const creatorWallet = await getOrCreateWallet(campaign.assignedCreatorId._id);
  
  if ((businessWallet.balances.escrow || 0) < payoutAmount) {
    logger.error(`Cannot auto-release campaign ${campaign._id}: Insufficient escrow balance`);
    campaign.autoReleaseStatus = 'failed';
    await campaign.save();
    return { action: 'failed', reason: 'Insufficient escrow balance' };
  }
  
  campaign.autoReleaseStatus = 'processing';
  await campaign.save();
  
  try {
    await runInTransaction(async (session) => {
      // Move funds from business escrow to creator available balance
      await debitWallet(businessWallet._id, 'escrow', payoutAmount, session);
      await creditWallet(creatorWallet._id, 'available', payoutAmount, session);
      
      // Record the auto-release transaction
      await recordTransaction(
        {
          type: 'escrow_release',
          status: 'completed',
          fromUserId: campaign.businessId._id,
          toUserId: campaign.assignedCreatorId._id,
          fromWalletId: businessWallet._id,
          toWalletId: creatorWallet._id,
          grossAmount: payoutAmount,
          feeAmount: 0,
          netAmount: payoutAmount,
          metadata: {
            campaignId: campaign._id,
            campaignTitle: campaign.title,
            note: `Auto-released after ${AUTO_RELEASE_DAYS} days (business did not approve)`,
            autoRelease: true,
            daysOverdue: Math.floor((Date.now() - campaign.autoReleaseDeadline) / (1000 * 60 * 60 * 24))
          }
        },
        session
      );
      
      // Update campaign status
      campaign.status = 'paid';
      campaign.businessWorkApproved = false; // Auto-release counts as approved for payment
      campaign.autoReleaseStatus = 'completed';
      campaign.autoReleaseCompletedAt = new Date();
      campaign.escrowHeld = roundUsd(Math.max(0, (campaign.escrowHeld || 0) - payoutAmount));
      campaign.completedAt = new Date();
      campaign.paidAt = new Date();
      await campaign.save({ session });
    });
    
    // Send notification to creator
    if (campaign.assignedCreatorId) {
      await Notification.createNotification({
        userId: campaign.assignedCreatorId._id,
        type: NOTIFICATION_TYPES.WORK_APPROVED,
        title: '💰 Payment Auto-Released!',
        message: `Payment for "${campaign.title}" has been automatically released to your wallet because the business did not respond within ${AUTO_RELEASE_DAYS} days. Amount: $${payoutAmount}`,
        priority: NOTIFICATION_PRIORITIES.HIGH,
        actionUrl: `/wallet.html`,
        actionType: 'transaction',
        metadata: { autoRelease: true, campaignTitle: campaign.title }
      });
      
      // Send real-time notification
      const io = require('../sockets');
      if (io && io.sendNotificationToUser) {
        io.sendNotificationToUser(global.io, campaign.assignedCreatorId._id, {
          title: '💰 Payment Auto-Released!',
          message: `$${payoutAmount} released for "${campaign.title}"`,
          type: 'payment_released',
          campaignId: campaign._id
        });
      }
    }
    
    // Send notification to business (warning)
    if (campaign.businessId) {
      await Notification.createNotification({
        userId: campaign.businessId._id,
        type: NOTIFICATION_TYPES.WORK_APPROVED,
        title: '⚠️ Funds Auto-Released Due to No Action',
        message: `Funds ($${payoutAmount}) for "${campaign.title}" have been automatically released to the creator because you did not approve the work within ${AUTO_RELEASE_DAYS} days.`,
        priority: NOTIFICATION_PRIORITIES.HIGH,
        actionUrl: `/campaign.html?id=${campaign._id}`,
        actionType: 'campaign',
        metadata: { autoRelease: true, amount: payoutAmount }
      });
    }
    
    logger.info(`Auto-released campaign ${campaign._id}`, {
      campaignTitle: campaign.title,
      amount: payoutAmount,
      creatorId: campaign.assignedCreatorId._id,
      businessId: campaign.businessId._id
    });
    
    return {
      action: 'auto_released',
      amount: payoutAmount,
      campaignId: campaign._id,
      creatorId: campaign.assignedCreatorId._id,
      businessId: campaign.businessId._id
    };
    
  } catch (error) {
    logger.error(`Auto-release failed for campaign ${campaign._id}:`, error);
    campaign.autoReleaseStatus = 'failed';
    await campaign.save();
    return { action: 'failed', reason: error.message };
  }
}

/**
 * Get auto-release statistics for admin dashboard
 * @returns {Promise<Object>} Statistics
 */
async function getAutoReleaseStats() {
  const now = new Date();
  
  const [pendingAutoRelease, autoReleasedToday, autoReleasedTotal, remindersSentToday] = await Promise.all([
    Campaign.countDocuments({
      creatorWorkCompleted: true,
      businessWorkApproved: false,
      autoReleaseDeadline: { $gt: now },
      autoReleaseStatus: { $in: ['pending', 'reminding'] }
    }),
    Campaign.countDocuments({
      autoReleaseStatus: 'completed',
      autoReleaseCompletedAt: { $gte: new Date(now.setHours(0, 0, 0, 0)) }
    }),
    Campaign.countDocuments({ autoReleaseStatus: 'completed' }),
    Campaign.countDocuments({
      lastReminderSentAt: { $gte: new Date(now.setHours(0, 0, 0, 0)) }
    })
  ]);
  
  // Get total auto-released amount
  const Transaction = require('../models/Transaction');
  const totalAmount = await Transaction.aggregate([
    {
      $match: {
        type: 'escrow_release',
        'metadata.autoRelease': true,
        status: 'completed'
      }
    },
    {
      $group: {
        _id: null,
        total: { $sum: '$grossAmount' },
        count: { $sum: 1 }
      }
    }
  ]);
  
  return {
    pendingAutoRelease,
    autoReleasedToday,
    autoReleasedTotal,
    remindersSentToday,
    totalAutoReleasedAmount: totalAmount[0]?.total || 0,
    totalAutoReleasedCount: totalAmount[0]?.count || 0,
    autoReleaseDays: AUTO_RELEASE_DAYS
  };
}

/**
 * Manually trigger auto-release for a specific campaign (admin only)
 * @param {string} campaignId - Campaign ID
 * @param {string} adminId - Admin user ID
 * @returns {Promise<Object>} Result
 */
async function manualAutoRelease(campaignId, adminId) {
  const campaign = await Campaign.findById(campaignId);
  if (!campaign) {
    throw new Error('Campaign not found');
  }
  
  if (!campaign.creatorWorkCompleted) {
    throw new Error('Creator has not marked work as completed');
  }
  
  if (campaign.businessWorkApproved) {
    throw new Error('Business has already approved this work');
  }
  
  if (campaign.autoReleaseStatus === 'completed') {
    throw new Error('Funds have already been released');
  }
  
  logger.info(`Manual auto-release triggered by admin ${adminId} for campaign ${campaignId}`);
  
  // Force deadline to now and process
  campaign.autoReleaseDeadline = new Date();
  await campaign.save();
  
  return executeAutoRelease(campaign);
}

// ============================================
// Exports
// ============================================

module.exports = {
  processAutoReleaseQueue,
  executeAutoRelease,
  sendReminder,
  shouldSendReminder,
  getAutoReleaseStats,
  manualAutoRelease,
  AUTO_RELEASE_DAYS,
  REMINDER_SCHEDULE,
  REMINDER_HOURS
};
