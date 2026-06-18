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
// Lazy load models to avoid circular dependencies
// ============================================

let Campaign = null;
let User = null;
let Notification = null;
let NotificationTypes = null;
let NotificationPriorities = null;
let walletService = null;
let feeService = null;
let socketsService = null;
let TransactionModel = null;

function loadModels() {
  try {
    if (!Campaign) {
      const CampaignModule = require('../models/Campaign');
      Campaign = CampaignModule.Campaign || CampaignModule;
    }
  } catch (e) {
    logger.error('Failed to load Campaign model:', e.message);
  }

  try {
    if (!User) {
      User = require('../models/User');
    }
  } catch (e) {
    logger.error('Failed to load User model:', e.message);
  }

  try {
    if (!Notification) {
      const NotificationModule = require('../models/Notification');
      Notification = NotificationModule.Notification || NotificationModule;
      NotificationTypes = NotificationModule.NOTIFICATION_TYPES;
      NotificationPriorities = NotificationModule.NOTIFICATION_PRIORITIES;
    }
  } catch (e) {
    logger.error('Failed to load Notification model:', e.message);
  }

  try {
    if (!walletService) {
      walletService = require('./walletService');
    }
  } catch (e) {
    logger.error('Failed to load walletService:', e.message);
  }

  try {
    if (!feeService) {
      feeService = require('./feeService');
    }
  } catch (e) {
    logger.error('Failed to load feeService:', e.message);
  }

  try {
    if (!socketsService) {
      socketsService = require('../sockets');
    }
  } catch (e) {
    // Sockets is optional - don't log as error
  }

  try {
    if (!TransactionModel) {
      TransactionModel = require('../models/Transaction').Transaction;
    }
  } catch (e) {
    logger.error('Failed to load Transaction model:', e.message);
  }

  return { Campaign, User, Notification, walletService, feeService, socketsService, TransactionModel };
}

// ============================================
// Helper to safely call sendNotificationToUser
// ============================================

function safeSendNotification(userId, notification) {
  try {
    const io = global.io;
    if (io && socketsService && socketsService.sendNotificationToUser) {
      socketsService.sendNotificationToUser(io, userId, notification);
    }
  } catch (e) {
    // Silent fail - notifications are not critical
  }
}

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
    // Load models
    const { Campaign: CampaignModel } = loadModels();
    if (!CampaignModel) {
      logger.error('Campaign model not available for auto-release');
      return results;
    }

    // Find campaigns where:
    // 1. Creator marked work completed
    // 2. Business has not approved yet
    // 3. Status is submitted_for_review or in_progress
    // 4. Auto-release status is pending or reminding
    const campaigns = await CampaignModel.find({
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
    logger.error('Fatal error in auto-release queue:', error.message);
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
  
  // Check if deadline is valid
  if (!deadline || isNaN(deadline.getTime())) {
    return { action: 'none', reason: 'Invalid deadline' };
  }
  
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
  const { Notification: NotificationModel, NotificationTypes: NT, NotificationPriorities: NP } = loadModels();
  
  if (!NotificationModel) {
    logger.warn('Notification model not available, skipping reminder');
    return { action: 'none', reason: 'Notification model unavailable' };
  }

  let urgency = REMINDER_URGENCY.LOW;
  let title = '';
  let message = '';
  let priority = NP?.MEDIUM || 'medium';
  
  // Determine urgency level
  if (hoursRemaining <= 12) {
    urgency = REMINDER_URGENCY.CRITICAL;
    title = '⏰ FINAL WARNING: Auto-Release Imminent';
    message = `Funds for "${campaign.title}" will be AUTO-RELEASED to the creator in ${Math.ceil(hoursRemaining)} hours because you have not approved the work. Please review immediately!`;
    priority = NP?.URGENT || 'urgent';
  } else if (daysRemaining <= 1) {
    urgency = REMINDER_URGENCY.HIGH;
    title = '⚠️ URGENT: Approve Work Within 24 Hours';
    message = `You have less than 24 hours to review "${campaign.title}". Funds will auto-release to the creator if no action is taken.`;
    priority = NP?.HIGH || 'high';
  } else if (daysRemaining <= 3) {
    urgency = REMINDER_URGENCY.MEDIUM;
    title = '📋 Reminder: Work Awaiting Your Approval';
    message = `You have ${Math.ceil(daysRemaining)} days left to review "${campaign.title}". Please approve the work or contact the creator.`;
    priority = NP?.MEDIUM || 'medium';
  } else {
    urgency = REMINDER_URGENCY.LOW;
    title = '📋 Work Ready for Review';
    message = `The creator has completed work for "${campaign.title}". Please review and approve within ${Math.ceil(daysRemaining)} days.`;
    priority = NP?.LOW || 'low';
  }
  
  // Save notification to database
  if (campaign.businessId) {
    try {
      await NotificationModel.create({
        userId: campaign.businessId._id,
        type: NT?.WORK_SUBMITTED || 'work_submitted',
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
    } catch (e) {
      logger.warn('Failed to create notification:', e.message);
    }
    
    // Send real-time notification via Socket.IO
    safeSendNotification(campaign.businessId._id, {
      title,
      message,
      type: 'auto_release_reminder',
      campaignId: campaign._id,
      daysRemaining: daysRemaining.toFixed(1)
    });
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
  const { Campaign: CampaignModel, walletService: ws, feeService: fs } = loadModels();
  
  if (!CampaignModel) {
    logger.error('Campaign model not available for auto-release');
    return { action: 'failed', reason: 'Campaign model unavailable' };
  }

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
  
  const roundUsd = fs?.roundUsd || ((amt) => Math.round(amt * 100) / 100);
  const payoutAmount = roundUsd(bid?.amount || campaign.escrowHeld || 0);
  
  if (payoutAmount <= 0) {
    logger.error(`Cannot auto-release campaign ${campaign._id}: Invalid payout amount`);
    campaign.autoReleaseStatus = 'failed';
    await campaign.save();
    return { action: 'failed', reason: 'Invalid payout amount' };
  }
  
  // If wallet service is not available, just mark as completed without moving funds
  if (!ws) {
    logger.warn(`Wallet service not available - marking campaign ${campaign._id} as completed without fund transfer`);
    campaign.status = 'paid';
    campaign.autoReleaseStatus = 'completed';
    campaign.autoReleaseCompletedAt = new Date();
    campaign.completedAt = new Date();
    campaign.paidAt = new Date();
    await campaign.save();
    return {
      action: 'auto_released',
      amount: payoutAmount,
      campaignId: campaign._id,
      creatorId: campaign.assignedCreatorId._id,
      businessId: campaign.businessId._id
    };
  }
  
  try {
    const businessWallet = await ws.getOrCreateWallet(campaign.businessId._id);
    const creatorWallet = await ws.getOrCreateWallet(campaign.assignedCreatorId._id);
    
    if ((businessWallet.balances.escrow || 0) < payoutAmount) {
      logger.error(`Cannot auto-release campaign ${campaign._id}: Insufficient escrow balance`);
      campaign.autoReleaseStatus = 'failed';
      await campaign.save();
      return { action: 'failed', reason: 'Insufficient escrow balance' };
    }
    
    campaign.autoReleaseStatus = 'processing';
    await campaign.save();
    
    await ws.runInTransaction(async (session) => {
      // Move funds from business escrow to creator available balance
      await ws.debitWallet(businessWallet._id, 'escrow', payoutAmount, session);
      await ws.creditWallet(creatorWallet._id, 'available', payoutAmount, session);
      
      // Record the auto-release transaction
      const TransactionModel = loadModels().TransactionModel;
      if (TransactionModel) {
        await ws.recordTransaction(
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
      }
      
      // Update campaign status
      campaign.status = 'paid';
      campaign.businessWorkApproved = false;
      campaign.autoReleaseStatus = 'completed';
      campaign.autoReleaseCompletedAt = new Date();
      campaign.escrowHeld = roundUsd(Math.max(0, (campaign.escrowHeld || 0) - payoutAmount));
      campaign.completedAt = new Date();
      campaign.paidAt = new Date();
      await campaign.save({ session });
    });
    
    // Send notification to creator
    if (campaign.assignedCreatorId) {
      const { Notification: NotificationModel } = loadModels();
      if (NotificationModel) {
        try {
          await NotificationModel.create({
            userId: campaign.assignedCreatorId._id,
            type: 'work_approved',
            title: '💰 Payment Auto-Released!',
            message: `Payment for "${campaign.title}" has been automatically released to your wallet because the business did not respond within ${AUTO_RELEASE_DAYS} days. Amount: $${payoutAmount}`,
            priority: 'high',
            actionUrl: `/wallet.html`,
            actionType: 'transaction',
            metadata: { autoRelease: true, campaignTitle: campaign.title }
          });
        } catch (e) {
          logger.warn('Failed to create creator notification:', e.message);
        }
      }
      
      // Send real-time notification
      safeSendNotification(campaign.assignedCreatorId._id, {
        title: '💰 Payment Auto-Released!',
        message: `$${payoutAmount} released for "${campaign.title}"`,
        type: 'payment_released',
        campaignId: campaign._id
      });
    }
    
    // Send notification to business (warning)
    if (campaign.businessId) {
      const { Notification: NotificationModel } = loadModels();
      if (NotificationModel) {
        try {
          await NotificationModel.create({
            userId: campaign.businessId._id,
            type: 'work_approved',
            title: '⚠️ Funds Auto-Released Due to No Action',
            message: `Funds ($${payoutAmount}) for "${campaign.title}" have been automatically released to the creator because you did not approve the work within ${AUTO_RELEASE_DAYS} days.`,
            priority: 'high',
            actionUrl: `/campaign.html?id=${campaign._id}`,
            actionType: 'campaign',
            metadata: { autoRelease: true, amount: payoutAmount }
          });
        } catch (e) {
          logger.warn('Failed to create business notification:', e.message);
        }
      }
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
    logger.error(`Auto-release failed for campaign ${campaign._id}:`, error.message);
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
  try {
    const { Campaign: CampaignModel } = loadModels();
    if (!CampaignModel) {
      return {
        pendingAutoRelease: 0,
        autoReleasedToday: 0,
        autoReleasedTotal: 0,
        remindersSentToday: 0,
        totalAutoReleasedAmount: 0,
        totalAutoReleasedCount: 0,
        autoReleaseDays: AUTO_RELEASE_DAYS
      };
    }

    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    
    const [pendingAutoRelease, autoReleasedToday, autoReleasedTotal, remindersSentToday] = await Promise.all([
      CampaignModel.countDocuments({
        creatorWorkCompleted: true,
        businessWorkApproved: false,
        autoReleaseDeadline: { $gt: now },
        autoReleaseStatus: { $in: ['pending', 'reminding'] }
      }),
      CampaignModel.countDocuments({
        autoReleaseStatus: 'completed',
        autoReleaseCompletedAt: { $gte: todayStart }
      }),
      CampaignModel.countDocuments({ autoReleaseStatus: 'completed' }),
      CampaignModel.countDocuments({
        lastReminderSentAt: { $gte: todayStart }
      })
    ]);
    
    // Get total auto-released amount
    const { TransactionModel } = loadModels();
    let totalAmount = 0;
    let totalCount = 0;
    
    if (TransactionModel) {
      try {
        const result = await TransactionModel.aggregate([
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
        totalAmount = result[0]?.total || 0;
        totalCount = result[0]?.count || 0;
      } catch (e) {
        logger.warn('Failed to get total auto-released amount:', e.message);
      }
    }
    
    return {
      pendingAutoRelease,
      autoReleasedToday,
      autoReleasedTotal,
      remindersSentToday,
      totalAutoReleasedAmount: totalAmount,
      totalAutoReleasedCount: totalCount,
      autoReleaseDays: AUTO_RELEASE_DAYS
    };
  } catch (error) {
    logger.error('Error getting auto-release stats:', error.message);
    return {
      pendingAutoRelease: 0,
      autoReleasedToday: 0,
      autoReleasedTotal: 0,
      remindersSentToday: 0,
      totalAutoReleasedAmount: 0,
      totalAutoReleasedCount: 0,
      autoReleaseDays: AUTO_RELEASE_DAYS
    };
  }
}

/**
 * Manually trigger auto-release for a specific campaign (admin only)
 * @param {string} campaignId - Campaign ID
 * @param {string} adminId - Admin user ID
 * @returns {Promise<Object>} Result
 */
async function manualAutoRelease(campaignId, adminId) {
  try {
    const { Campaign: CampaignModel } = loadModels();
    if (!CampaignModel) {
      return { success: false, error: 'Campaign model not available' };
    }
    
    const campaign = await CampaignModel.findById(campaignId);
    if (!campaign) {
      return { success: false, error: 'Campaign not found' };
    }
    
    if (!campaign.creatorWorkCompleted) {
      return { success: false, error: 'Creator has not marked work as completed' };
    }
    
    if (campaign.businessWorkApproved) {
      return { success: false, error: 'Business has already approved this work' };
    }
    
    if (campaign.autoReleaseStatus === 'completed') {
      return { success: false, error: 'Funds have already been released' };
    }
    
    logger.info(`Manual auto-release triggered by admin ${adminId} for campaign ${campaignId}`);
    
    // Force deadline to now and process
    campaign.autoReleaseDeadline = new Date();
    await campaign.save();
    
    const result = await executeAutoRelease(campaign);
    return { success: true, result };
  } catch (error) {
    logger.error('Manual auto-release error:', error.message);
    return { success: false, error: error.message };
  }
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
