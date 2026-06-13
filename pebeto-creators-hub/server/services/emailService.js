/**
 * Email Service for Pebeto Creator's Hub - DISABLED VERSION
 * Email features are temporarily disabled. Enable by installing nodemailer.
 */

const logger = require('../utils/logger');

// ============================================
// Constants
// ============================================

const EMAIL_TEMPLATES = {
  WELCOME: 'welcome',
  EMAIL_VERIFICATION: 'email_verification',
  PASSWORD_RESET: 'password_reset',
  PASSWORD_CHANGED: 'password_changed',
  DEPOSIT_CONFIRMED: 'deposit_confirmed',
  WITHDRAWAL_INITIATED: 'withdrawal_initiated',
  WITHDRAWAL_COMPLETED: 'withdrawal_completed',
  TIP_RECEIVED: 'tip_received',
  TIP_SENT: 'tip_sent',
  CAMPAIGN_CREATED: 'campaign_created',
  CAMPAIGN_FUNDED: 'campaign_funded',
  CAMPAIGN_COMPLETED: 'campaign_completed',
  BID_RECEIVED: 'bid_received',
  BID_ACCEPTED: 'bid_accepted',
  WORK_SUBMITTED: 'work_submitted',
  WORK_APPROVED: 'work_approved',
  NEW_FOLLOWER: 'new_follower',
  NEW_COMMENT: 'new_comment',
  NEW_LIKE: 'new_like',
  ACCOUNT_VERIFIED: 'account_verified',
  ACCOUNT_SUSPENDED: 'account_suspended',
  LOGIN_ALERT: 'login_alert',
  ACCOUNT_DELETION_CONFIRMATION: 'account_deletion',
  DATA_EXPORT_READY: 'data_export_ready'
};

/**
 * Send an email (DISABLED - logs instead)
 */
async function sendEmail(options) {
  const { to, subject, template, data } = options;
  
  logger.info(`[EMAIL DISABLED] Would have sent email to ${to}`, {
    subject,
    template,
    dataPreview: data ? Object.keys(data) : null
  });
  
  // For development, still return success
  return true;
}

/**
 * Send welcome email (DISABLED)
 */
async function sendWelcomeEmail(to, name, dashboardUrl) {
  return sendEmail({
    to,
    subject: 'Welcome to Pebeto! 🎉',
    template: EMAIL_TEMPLATES.WELCOME,
    data: { name, dashboardUrl }
  });
}

/**
 * Send email verification (DISABLED)
 */
async function sendVerificationEmail(to, verificationUrl) {
  return sendEmail({
    to,
    subject: 'Verify Your Email Address',
    template: EMAIL_TEMPLATES.EMAIL_VERIFICATION,
    data: { verificationUrl }
  });
}

/**
 * Send password reset email (DISABLED)
 */
async function sendPasswordResetEmail(to, resetUrl) {
  return sendEmail({
    to,
    subject: 'Reset Your Password',
    template: EMAIL_TEMPLATES.PASSWORD_RESET,
    data: { resetUrl }
  });
}

/**
 * Send tip received notification (DISABLED)
 */
async function sendTipReceivedEmail(to, data) {
  return sendEmail({
    to,
    subject: `💝 You received a tip of ${data.amount}!`,
    template: EMAIL_TEMPLATES.TIP_RECEIVED,
    data: { ...data, date: new Date().toLocaleString() }
  });
}

/**
 * Send withdrawal completed notification (DISABLED)
 */
async function sendWithdrawalCompletedEmail(to, data) {
  return sendEmail({
    to,
    subject: `✅ Withdrawal of ${data.amount} Completed`,
    template: EMAIL_TEMPLATES.WITHDRAWAL_COMPLETED,
    data
  });
}

/**
 * Send bid accepted notification (DISABLED)
 */
async function sendBidAcceptedEmail(to, data) {
  return sendEmail({
    to,
    subject: `🎉 Your bid for "${data.campaignTitle}" has been accepted!`,
    template: EMAIL_TEMPLATES.BID_ACCEPTED,
    data
  });
}

/**
 * Send login alert email (DISABLED)
 */
async function sendLoginAlertEmail(to, data) {
  return sendEmail({
    to,
    subject: '🔐 New Login to Your Account',
    template: EMAIL_TEMPLATES.LOGIN_ALERT,
    data
  });
}

/**
 * Send account deletion confirmation email (DISABLED)
 */
async function sendAccountDeletionEmail(to, deletionCode, deletionUrl) {
  return sendEmail({
    to,
    subject: '⚠️ Account Deletion Request - Pebeto',
    template: EMAIL_TEMPLATES.ACCOUNT_DELETION_CONFIRMATION,
    data: { deletionCode, deletionUrl }
  });
}

/**
 * Send data export ready email (DISABLED)
 */
async function sendDataExportReadyEmail(to, downloadUrl) {
  return sendEmail({
    to,
    subject: '📁 Your Pebeto Data Export is Ready',
    template: EMAIL_TEMPLATES.DATA_EXPORT_READY,
    data: { downloadUrl, exportDate: new Date().toLocaleDateString() }
  });
}

/**
 * Send account suspended notification (DISABLED)
 */
async function sendAccountSuspendedEmail(to, reason, appealUrl) {
  return sendEmail({
    to,
    subject: '⚠️ Your Pebeto Account Has Been Suspended',
    template: EMAIL_TEMPLATES.ACCOUNT_SUSPENDED,
    data: { reason, appealUrl }
  });
}

// ============================================
// Exports
// ============================================

module.exports = {
  sendEmail,
  sendWelcomeEmail,
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendTipReceivedEmail,
  sendWithdrawalCompletedEmail,
  sendBidAcceptedEmail,
  sendLoginAlertEmail,
  sendAccountDeletionEmail,
  sendDataExportReadyEmail,
  sendAccountSuspendedEmail,
  EMAIL_TEMPLATES
};
