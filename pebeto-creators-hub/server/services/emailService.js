/**
 * Email Service for Pebeto Creator's Hub - ENABLED VERSION
 * 
 * Handles all email notifications including:
 * - Welcome emails
 * - Email verification
 * - Password reset
 * - Login alerts
 * - Tip notifications
 * - Campaign updates
 * - Work approval/rejection
 * - Auto-release reminders
 * 
 * @module services/emailService
 */

const nodemailer = require('nodemailer');
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
  WORK_REJECTED: 'work_rejected',
  WORK_REMINDER: 'work_reminder',
  AUTO_RELEASE_NOTICE: 'auto_release_notice',
  NEW_FOLLOWER: 'new_follower',
  NEW_COMMENT: 'new_comment',
  NEW_LIKE: 'new_like',
  ACCOUNT_VERIFIED: 'account_verified',
  ACCOUNT_SUSPENDED: 'account_suspended',
  LOGIN_ALERT: 'login_alert',
  ACCOUNT_DELETION_CONFIRMATION: 'account_deletion',
  DATA_EXPORT_READY: 'data_export_ready'
};

// Email configuration
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = parseInt(process.env.SMTP_PORT) || 587;
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASSWORD = process.env.SMTP_PASSWORD;
const SMTP_SECURE = process.env.SMTP_SECURE === 'true' || SMTP_PORT === 465;
const EMAIL_FROM = process.env.EMAIL_FROM || 'noreply@pebeto.com';
const EMAIL_REPLY_TO = process.env.EMAIL_REPLY_TO || 'support@pebeto.com';
const EMAIL_ENABLED = process.env.EMAIL_ENABLED !== 'false';

// Create transporter
let transporter = null;

/**
 * Initialize email transporter
 * @returns {Promise<boolean>} Success status
 */
async function initTransporter() {
  if (!EMAIL_ENABLED) {
    logger.info('Email service is disabled by configuration');
    return false;
  }
  
  if (!SMTP_USER || !SMTP_PASSWORD) {
    logger.warn('Email credentials not configured. Email service will not work.');
    return false;
  }
  
  try {
    transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      auth: {
        user: SMTP_USER,
        pass: SMTP_PASSWORD
      },
      tls: {
        rejectUnauthorized: false
      }
    });
    
    // Verify connection
    await transporter.verify();
    logger.info('Email transporter initialized successfully');
    return true;
  } catch (error) {
    logger.error('Failed to initialize email transporter:', error.message);
    transporter = null;
    return false;
  }
}

/**
 * Send an email
 * @param {Object} options - Email options
 * @param {string} options.to - Recipient email
 * @param {string} options.subject - Email subject
 * @param {string} options.html - HTML content
 * @param {string} options.text - Plain text content (optional)
 * @returns {Promise<boolean>} Success status
 */
async function sendEmail(options) {
  const { to, subject, html, text } = options;
  
  if (!EMAIL_ENABLED) {
    logger.info(`[EMAIL DISABLED] Would have sent to ${to}: ${subject}`);
    return true;
  }
  
  if (!transporter) {
    await initTransporter();
  }
  
  if (!transporter) {
    logger.error('Email transporter not available');
    return false;
  }
  
  try {
    const info = await transporter.sendMail({
      from: `"Pebeto Creator Hub" <${EMAIL_FROM}>`,
      to,
      subject,
      text: text || html?.replace(/<[^>]*>/g, ''),
      html,
      replyTo: EMAIL_REPLY_TO
    });
    
    logger.info(`Email sent to ${to}: ${subject}`, { messageId: info.messageId });
    return true;
  } catch (error) {
    logger.error(`Failed to send email to ${to}:`, error.message);
    return false;
  }
}

// ============================================
// HTML Template Helpers
// ============================================

/**
 * Get base email HTML wrapper
 * @param {string} content - Email content
 * @param {string} title - Email title
 * @returns {string} Wrapped HTML
 */
function getEmailWrapper(content, title) {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${title}</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f5f5f5; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; background-color: #ffffff; border-radius: 12px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        .header { text-align: center; padding: 20px 0; border-bottom: 2px solid #ff8c42; }
        .logo { font-size: 28px; font-weight: bold; color: #ff8c42; text-decoration: none; }
        .content { padding: 30px 20px; }
        .footer { text-align: center; padding: 20px; font-size: 12px; color: #888; border-top: 1px solid #eee; }
        .button { display: inline-block; background-color: #ff8c42; color: white; padding: 12px 24px; text-decoration: none; border-radius: 40px; font-weight: 500; margin: 20px 0; }
        .button:hover { background-color: #e0662c; }
        .warning { background-color: #fff3e0; border-left: 4px solid #ff8c42; padding: 15px; margin: 20px 0; }
        .alert { background-color: #fee; border-left: 4px solid #f44336; padding: 15px; margin: 20px 0; }
        .success { background-color: #e8f5e9; border-left: 4px solid #4caf50; padding: 15px; margin: 20px 0; }
      </style>
    </head>
    <body style="margin: 0; padding: 20px; background-color: #f5f5f5;">
      <div class="container">
        <div class="header">
          <a href="${process.env.CLIENT_ORIGIN || 'https://pebeto.com'}" class="logo" style="color: #ff8c42; text-decoration: none;">Pebeto</a>
        </div>
        <div class="content">
          ${content}
        </div>
        <div class="footer">
          <p>&copy; ${new Date().getFullYear()} Pebeto Creator Hub. All rights reserved.</p>
          <p>Questions? Contact us at <a href="mailto:support@pebeto.com" style="color: #ff8c42;">support@pebeto.com</a></p>
          <p><small>This email was sent to you because you are a registered user of Pebeto Creator Hub.</small></p>
        </div>
      </div>
    </body>
    </html>
  `;
}

// ============================================
// Specific Email Functions
// ============================================

/**
 * Send welcome email
 * @param {string} to - Recipient email
 * @param {string} name - User name
 * @param {string} dashboardUrl - Dashboard URL
 * @returns {Promise<boolean>}
 */
async function sendWelcomeEmail(to, name, dashboardUrl) {
  const content = `
    <h2>Welcome to Pebeto, ${name}! 🎉</h2>
    <p>We're excited to have you join the Pebeto Creator Hub community.</p>
    <div class="success">
      <p><strong>What you can do next:</strong></p>
      <ul>
        <li>Complete your profile</li>
        <li>Connect your social media accounts</li>
        <li>Browse campaigns or showcase your work</li>
      </ul>
    </div>
    <p style="text-align: center;">
      <a href="${dashboardUrl}" class="button">Go to Dashboard</a>
    </p>
    <p>If you have any questions, feel free to reach out to our support team.</p>
  `;
  
  return sendEmail({
    to,
    subject: 'Welcome to Pebeto! 🎉',
    html: getEmailWrapper(content, 'Welcome to Pebeto')
  });
}

/**
 * Send email verification
 * @param {string} to - Recipient email
 * @param {string} verificationUrl - Verification URL
 * @returns {Promise<boolean>}
 */
async function sendVerificationEmail(to, verificationUrl) {
  const content = `
    <h2>Verify Your Email Address</h2>
    <p>Thanks for signing up! Please verify your email address to get started.</p>
    <p style="text-align: center;">
      <a href="${verificationUrl}" class="button">Verify Email</a>
    </p>
    <p>Or copy and paste this link into your browser:</p>
    <p><code style="word-break: break-all;">${verificationUrl}</code></p>
    <p>This link will expire in 24 hours.</p>
  `;
  
  return sendEmail({
    to,
    subject: 'Verify Your Email Address',
    html: getEmailWrapper(content, 'Verify Your Email')
  });
}

/**
 * Send password reset email
 * @param {string} to - Recipient email
 * @param {string} resetUrl - Password reset URL
 * @returns {Promise<boolean>}
 */
async function sendPasswordResetEmail(to, resetUrl) {
  const content = `
    <h2>Reset Your Password</h2>
    <p>We received a request to reset your password. Click the button below to create a new password.</p>
    <p style="text-align: center;">
      <a href="${resetUrl}" class="button">Reset Password</a>
    </p>
    <p>Or copy and paste this link into your browser:</p>
    <p><code style="word-break: break-all;">${resetUrl}</code></p>
    <div class="warning">
      <p><strong>⚠️ Security Notice:</strong> This link will expire in 1 hour. If you didn't request this, please ignore this email.</p>
    </div>
  `;
  
  return sendEmail({
    to,
    subject: 'Reset Your Password',
    html: getEmailWrapper(content, 'Reset Password')
  });
}

/**
 * Send login alert email
 * @param {string} to - Recipient email
 * @param {Object} data - Login data
 * @returns {Promise<boolean>}
 */
async function sendLoginAlertEmail(to, data) {
  const { time, device, location, resetUrl } = data;
  const content = `
    <h2>🔐 New Login to Your Account</h2>
    <div class="warning">
      <p><strong>Login Details:</strong></p>
      <ul>
        <li>Time: ${time || new Date().toLocaleString()}</li>
        <li>Device: ${device || 'Unknown device'}</li>
        <li>Location: ${location || 'Unknown location'}</li>
      </ul>
    </div>
    <p>If this was you, you can safely ignore this email.</p>
    <p>If this wasn't you, please reset your password immediately:</p>
    <p style="text-align: center;">
      <a href="${resetUrl}" class="button">Reset Password</a>
    </p>
  `;
  
  return sendEmail({
    to,
    subject: '🔐 New Login to Your Account',
    html: getEmailWrapper(content, 'Login Alert')
  });
}

/**
 * Send tip received notification
 * @param {string} to - Recipient email
 * @param {Object} data - Tip data
 * @returns {Promise<boolean>}
 */
async function sendTipReceivedEmail(to, data) {
  const { amount, fromUser, currency, totalTips } = data;
  const content = `
    <h2>💝 You Received a Tip!</h2>
    <div class="success">
      <p><strong>Tip Details:</strong></p>
      <ul>
        <li>Amount: ${currency || 'USD'} ${amount}</li>
        <li>From: ${fromUser || 'A fan'}</li>
        <li>Total Tips Received: ${totalTips || 0}</li>
      </ul>
    </div>
    <p>Your tip has been added to your wallet. Keep creating amazing content!</p>
    <p style="text-align: center;">
      <a href="${process.env.CLIENT_ORIGIN}/creator-dashboard.html" class="button">View Wallet</a>
    </p>
  `;
  
  return sendEmail({
    to,
    subject: `💝 You received a tip of ${amount}!`,
    html: getEmailWrapper(content, 'Tip Received')
  });
}

/**
 * Send bid accepted notification
 * @param {string} to - Recipient email
 * @param {Object} data - Bid data
 * @returns {Promise<boolean>}
 */
async function sendBidAcceptedEmail(to, data) {
  const { campaignTitle, businessName, amount, campaignUrl } = data;
  const content = `
    <h2>🎉 Your Bid Has Been Accepted!</h2>
    <div class="success">
      <p><strong>Campaign Details:</strong></p>
      <ul>
        <li>Campaign: ${campaignTitle}</li>
        <li>Business: ${businessName}</li>
        <li>Amount: $${amount}</li>
      </ul>
    </div>
    <p>Congratulations! You've been selected for this campaign.</p>
    <p style="text-align: center;">
      <a href="${campaignUrl}" class="button">View Campaign</a>
    </p>
    <p>Please review the campaign details and submit your work by the deadline.</p>
  `;
  
  return sendEmail({
    to,
    subject: `🎉 Your bid for "${campaignTitle}" has been accepted!`,
    html: getEmailWrapper(content, 'Bid Accepted')
  });
}

/**
 * Send withdrawal completed notification
 * @param {string} to - Recipient email
 * @param {Object} data - Withdrawal data
 * @returns {Promise<boolean>}
 */
async function sendWithdrawalCompletedEmail(to, data) {
  const { amount, method, reference, completedAt } = data;
  const content = `
    <h2>✅ Withdrawal Completed</h2>
    <div class="success">
      <p><strong>Withdrawal Details:</strong></p>
      <ul>
        <li>Amount: $${amount}</li>
        <li>Method: ${method}</li>
        <li>Reference: ${reference}</li>
        <li>Completed: ${new Date(completedAt).toLocaleString()}</li>
      </ul>
    </div>
    <p>Your withdrawal has been processed successfully. Funds should arrive within the estimated timeframe.</p>
  `;
  
  return sendEmail({
    to,
    subject: `✅ Withdrawal of $${amount} Completed`,
    html: getEmailWrapper(content, 'Withdrawal Completed')
  });
}

/**
 * Send work reminder email (auto-release warning)
 * @param {string} to - Recipient email
 * @param {Object} data - Reminder data
 * @returns {Promise<boolean>}
 */
async function sendWorkReminderEmail(to, data) {
  const { campaignTitle, daysRemaining, hoursRemaining, deadline, campaignUrl } = data;
  const isUrgent = daysRemaining <= 1;
  const content = `
    <h2>${isUrgent ? '⚠️ URGENT: ' : '📋 '}Work Review Reminder</h2>
    <div class="${isUrgent ? 'alert' : 'warning'}">
      <p><strong>Campaign: ${campaignTitle}</strong></p>
      <p>The creator has completed their work and it's awaiting your review.</p>
      ${daysRemaining ? `<p>Time remaining: ${Math.ceil(daysRemaining)} days</p>` : ''}
      ${hoursRemaining ? `<p>Time remaining: ${Math.ceil(hoursRemaining)} hours</p>` : ''}
      ${isUrgent ? '<p><strong style="color: #f44336;">⚠️ Funds will auto-release to the creator if not approved!</strong></p>' : ''}
    </div>
    <p style="text-align: center;">
      <a href="${campaignUrl}" class="button">Review Work Now</a>
    </p>
    <p>If you don't take action within the timeframe, funds will be automatically released to the creator.</p>
  `;
  
  const subject = isUrgent 
    ? `⚠️ URGENT: ${Math.ceil(daysRemaining || 0)} days left to review "${campaignTitle}"`
    : `📋 Reminder: Work ready for review - "${campaignTitle}"`;
  
  return sendEmail({
    to,
    subject,
    html: getEmailWrapper(content, 'Work Review Reminder')
  });
}

/**
 * Send work approved notification
 * @param {string} to - Recipient email
 * @param {Object} data - Approval data
 * @returns {Promise<boolean>}
 */
async function sendWorkApprovedEmail(to, data) {
  const { campaignTitle, amount, businessName } = data;
  const content = `
    <h2>✅ Work Approved! Payment Released</h2>
    <div class="success">
      <p><strong>Payment Details:</strong></p>
      <ul>
        <li>Campaign: ${campaignTitle}</li>
        <li>Amount: $${amount}</li>
        <li>Approved by: ${businessName}</li>
      </ul>
    </div>
    <p>Your work has been approved and the payment has been added to your wallet.</p>
    <p style="text-align: center;">
      <a href="${process.env.CLIENT_ORIGIN}/wallet.html" class="button">View Wallet</a>
    </p>
  `;
  
  return sendEmail({
    to,
    subject: `✅ Work approved - $${amount} added to your wallet`,
    html: getEmailWrapper(content, 'Work Approved')
  });
}

/**
 * Send auto-release notice to business
 * @param {string} to - Recipient email
 * @param {Object} data - Auto-release data
 * @returns {Promise<boolean>}
 */
async function sendAutoReleaseNoticeEmail(to, data) {
  const { campaignTitle, amount, releaseDate } = data;
  const content = `
    <h2>⚠️ Funds Auto-Released</h2>
    <div class="alert">
      <p><strong>Important Notice:</strong></p>
      <p>Funds for campaign "${campaignTitle}" have been automatically released to the creator because no action was taken within the review period.</p>
      <ul>
        <li>Amount Released: $${amount}</li>
        <li>Release Date: ${new Date(releaseDate).toLocaleString()}</li>
      </ul>
    </div>
    <p>If you have any questions or concerns, please contact our support team.</p>
  `;
  
  return sendEmail({
    to,
    subject: `⚠️ Funds Auto-Released for "${campaignTitle}"`,
    html: getEmailWrapper(content, 'Auto-Release Notice')
  });
}

/**
 * Send account deletion confirmation
 * @param {string} to - Recipient email
 * @param {string} deletionCode - Deletion confirmation code
 * @param {string} deletionUrl - Deletion confirmation URL
 * @returns {Promise<boolean>}
 */
async function sendAccountDeletionEmail(to, deletionCode, deletionUrl) {
  const content = `
    <h2>⚠️ Account Deletion Request</h2>
    <div class="warning">
      <p>We received a request to delete your Pebeto account.</p>
      <p><strong>Your deletion code:</strong> <code>${deletionCode}</code></p>
    </div>
    <p style="text-align: center;">
      <a href="${deletionUrl}" class="button">Confirm Deletion</a>
    </p>
    <p>If you didn't request this, please ignore this email. Your account will remain active.</p>
  `;
  
  return sendEmail({
    to,
    subject: '⚠️ Account Deletion Request - Pebeto',
    html: getEmailWrapper(content, 'Account Deletion Request')
  });
}

/**
 * Send data export ready email
 * @param {string} to - Recipient email
 * @param {string} downloadUrl - Download URL
 * @returns {Promise<boolean>}
 */
async function sendDataExportReadyEmail(to, downloadUrl) {
  const content = `
    <h2>📁 Your Data Export is Ready</h2>
    <div class="success">
      <p>Your requested data export has been prepared and is ready for download.</p>
      <p><strong>Download link expires in 30 days.</strong></p>
    </div>
    <p style="text-align: center;">
      <a href="${downloadUrl}" class="button">Download Your Data</a>
    </p>
  `;
  
  return sendEmail({
    to,
    subject: '📁 Your Pebeto Data Export is Ready',
    html: getEmailWrapper(content, 'Data Export Ready')
  });
}

/**
 * Send account suspended notification
 * @param {string} to - Recipient email
 * @param {string} reason - Suspension reason
 * @param {string} appealUrl - Appeal URL
 * @returns {Promise<boolean>}
 */
async function sendAccountSuspendedEmail(to, reason, appealUrl) {
  const content = `
    <h2>⚠️ Your Account Has Been Suspended</h2>
    <div class="alert">
      <p><strong>Reason for suspension:</strong> ${reason}</p>
      <p>If you believe this is a mistake, you can submit an appeal.</p>
    </div>
    <p style="text-align: center;">
      <a href="${appealUrl}" class="button">Submit Appeal</a>
    </p>
  `;
  
  return sendEmail({
    to,
    subject: '⚠️ Your Pebeto Account Has Been Suspended',
    html: getEmailWrapper(content, 'Account Suspended')
  });
}

// Initialize transporter on module load
initTransporter();

// ============================================
// Exports
// ============================================

module.exports = {
  // Initialization
  initTransporter,
  sendEmail,
  
  // Email functions
  sendWelcomeEmail,
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendLoginAlertEmail,
  sendTipReceivedEmail,
  sendBidAcceptedEmail,
  sendWithdrawalCompletedEmail,
  sendWorkReminderEmail,
  sendWorkApprovedEmail,
  sendAutoReleaseNoticeEmail,
  sendAccountDeletionEmail,
  sendDataExportReadyEmail,
  sendAccountSuspendedEmail,
  
  // Constants
  EMAIL_TEMPLATES
};
