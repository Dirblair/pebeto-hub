/**
 * Email Service for Pebeto Creator's Hub
 * 
 * Handles sending transactional emails:
 * - Welcome emails
 * - Password reset
 * - Email verification
 * - Notifications (tips, campaign updates, withdrawals)
 * 
 * @module services/emailService
 */

const nodemailer = require('nodemailer');
const env = require('../config/env');
const logger = require('../utils/logger');
const { AppError } = require('../utils/errors');

// ============================================
// Constants
// ============================================

const EMAIL_TEMPLATES = {
  // Auth emails
  WELCOME: 'welcome',
  EMAIL_VERIFICATION: 'email_verification',
  PASSWORD_RESET: 'password_reset',
  PASSWORD_CHANGED: 'password_changed',
  
  // Transaction emails
  DEPOSIT_CONFIRMED: 'deposit_confirmed',
  WITHDRAWAL_INITIATED: 'withdrawal_initiated',
  WITHDRAWAL_COMPLETED: 'withdrawal_completed',
  TIP_RECEIVED: 'tip_received',
  TIP_SENT: 'tip_sent',
  
  // Campaign emails
  CAMPAIGN_CREATED: 'campaign_created',
  CAMPAIGN_FUNDED: 'campaign_funded',
  CAMPAIGN_COMPLETED: 'campaign_completed',
  BID_RECEIVED: 'bid_received',
  BID_ACCEPTED: 'bid_accepted',
  WORK_SUBMITTED: 'work_submitted',
  WORK_APPROVED: 'work_approved',
  
  // Community emails
  NEW_FOLLOWER: 'new_follower',
  NEW_COMMENT: 'new_comment',
  NEW_LIKE: 'new_like',
  
  // Account emails
  ACCOUNT_VERIFIED: 'account_verified',
  ACCOUNT_SUSPENDED: 'account_suspended',
  LOGIN_ALERT: 'login_alert',
};

// ============================================
// Email Transporter
// ============================================

let transporter = null;

/**
 * Initialize email transporter
 * @returns {Object} Nodemailer transporter
 */
function getTransporter() {
  if (transporter) return transporter;
  
  if (!env.email.enabled) {
    logger.warn('Email service is disabled. Emails will not be sent.');
    return null;
  }
  
  try {
    transporter = nodemailer.createTransport({
      host: env.email.smtpHost,
      port: env.email.smtpPort,
      secure: env.email.smtpSecure,
      auth: {
        user: env.email.smtpUser,
        pass: env.email.smtpPassword,
      },
    });
    
    logger.info('Email transporter initialized', {
      host: env.email.smtpHost,
      port: env.email.smtpPort,
      secure: env.email.smtpSecure,
    });
    
    return transporter;
  } catch (error) {
    logger.error('Failed to initialize email transporter', { error: error.message });
    return null;
  }
}

// ============================================
// Template Rendering
// ============================================

/**
 * Render email HTML from template
 * @param {string} templateName - Template name
 * @param {Object} data - Template data
 * @returns {string} Rendered HTML
 */
function renderTemplate(templateName, data) {
  const baseStyles = `
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; }
      .header { text-align: center; padding: 20px 0; border-bottom: 1px solid #eee; }
      .logo { font-size: 28px; font-weight: 800; color: #ff8c42; }
      .content { padding: 30px 0; }
      .button { display: inline-block; background: #ff8c42; color: white; padding: 12px 24px; text-decoration: none; border-radius: 40px; margin: 20px 0; }
      .footer { text-align: center; padding: 20px 0; font-size: 12px; color: #999; border-top: 1px solid #eee; }
      .amount { font-size: 32px; font-weight: bold; color: #ff8c42; }
      .details { background: #f5f5f5; padding: 15px; border-radius: 12px; margin: 20px 0; }
    </style>
  `;
  
  const templates = {
    [EMAIL_TEMPLATES.WELCOME]: `
      <h1>Welcome to Pebeto, ${data.name || 'Creator'}! 🎉</h1>
      <p>We're thrilled to have you join the Pebeto Creator's Hub community.</p>
      <p>Here's what you can do:</p>
      <ul>
        <li>🎨 Showcase your creative work</li>
        <li>💰 Earn tips from fans</li>
        <li>🤝 Connect with brands for campaigns</li>
      </ul>
      <a href="${data.dashboardUrl || 'https://pebeto.com/dashboard'}" class="button">Go to Dashboard</a>
    `,
    
    [EMAIL_TEMPLATES.EMAIL_VERIFICATION]: `
      <h1>Verify Your Email Address</h1>
      <p>Thanks for signing up! Please verify your email address to get started with Pebeto.</p>
      <a href="${data.verificationUrl}" class="button">Verify Email</a>
      <p>This link will expire in 24 hours.</p>
    `,
    
    [EMAIL_TEMPLATES.PASSWORD_RESET]: `
      <h1>Reset Your Password</h1>
      <p>We received a request to reset your password. Click the button below to create a new password.</p>
      <a href="${data.resetUrl}" class="button">Reset Password</a>
      <p>If you didn't request this, please ignore this email.</p>
    `,
    
    [EMAIL_TEMPLATES.TIP_RECEIVED]: `
      <h1>💝 You Received a Tip!</h1>
      <p><strong>${data.fromName || 'Someone'}</strong> sent you a tip of <span class="amount">${data.amount}</span>!</p>
      <div class="details">
        <p><strong>Amount:</strong> ${data.amount}</p>
        <p><strong>From:</strong> ${data.fromName || 'Anonymous'}</p>
        <p><strong>Date:</strong> ${data.date}</p>
      </div>
      <a href="${data.walletUrl}" class="button">View Wallet</a>
    `,
    
    [EMAIL_TEMPLATES.WITHDRAWAL_COMPLETED]: `
      <h1>✅ Withdrawal Completed</h1>
      <p>Your withdrawal has been processed successfully!</p>
      <div class="details">
        <p><strong>Amount:</strong> ${data.amount}</p>
        <p><strong>Method:</strong> ${data.method}</p>
        <p><strong>Transaction ID:</strong> ${data.transactionId}</p>
      </div>
      <a href="${data.transactionsUrl}" class="button">View Transactions</a>
    `,
    
    [EMAIL_TEMPLATES.BID_ACCEPTED]: `
      <h1>🎉 Your Bid Has Been Accepted!</h1>
      <p>Congratulations! Your bid for campaign <strong>${data.campaignTitle}</strong> has been accepted.</p>
      <div class="details">
        <p><strong>Campaign:</strong> ${data.campaignTitle}</p>
        <p><strong>Budget:</strong> ${data.budget}</p>
      </div>
      <a href="${data.campaignUrl}" class="button">View Campaign</a>
    `,
    
    [EMAIL_TEMPLATES.LOGIN_ALERT]: `
      <h1>🔐 New Login to Your Account</h1>
      <p>We detected a new login to your Pebeto account.</p>
      <div class="details">
        <p><strong>Time:</strong> ${data.time}</p>
        <p><strong>Device:</strong> ${data.device}</p>
        <p><strong>Location:</strong> ${data.location || 'Unknown'}</p>
      </div>
      <p>If this wasn't you, please reset your password immediately.</p>
      <a href="${data.resetUrl}" class="button">Secure Account</a>
    `,
  };
  
  const template = templates[templateName] || `<h1>${data.subject || 'Notification'}</h1><p>${data.message || ''}</p>`;
  
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">${baseStyles}</head><body><div class="header"><div class="logo">Pebeto</div></div><div class="content">${template}</div><div class="footer"><p>&copy; ${new Date().getFullYear()} Pebeto Creator's Hub. All rights reserved.</p><p><a href="${data.unsubscribeUrl || '#'}">Unsubscribe</a> | <a href="https://pebeto.com/privacy">Privacy Policy</a></p></div></body></html>`;
}

// ============================================
// Main Email Sending Functions
// ============================================

/**
 * Send an email
 * @param {Object} options - Email options
 * @returns {Promise<boolean>} Success status
 */
async function sendEmail(options) {
  const { to, subject, template, data, html, text } = options;
  
  if (!env.email.enabled) {
    logger.debug('Email disabled - would have sent', { to, subject });
    return true;
  }
  
  const transporter = getTransporter();
  if (!transporter) {
    logger.warn('No email transporter available', { to, subject });
    return false;
  }
  
  try {
    const emailHtml = html || renderTemplate(template, data);
    const emailText = text || `Pebeto Notification: ${subject}`;
    
    const mailOptions = {
      from: env.email.from,
      to,
      subject,
      html: emailHtml,
      text: emailText,
      replyTo: env.email.replyTo,
    };
    
    await transporter.sendMail(mailOptions);
    logger.info('Email sent', { to, subject });
    return true;
  } catch (error) {
    logger.error('Failed to send email', { to, subject, error: error.message });
    return false;
  }
}

/**
 * Send welcome email
 * @param {string} to - Recipient email
 * @param {string} name - User name
 * @returns {Promise<boolean>}
 */
async function sendWelcomeEmail(to, name, dashboardUrl = 'https://pebeto.com/dashboard') {
  return sendEmail({
    to,
    subject: 'Welcome to Pebeto! 🎉',
    template: EMAIL_TEMPLATES.WELCOME,
    data: { name, dashboardUrl },
  });
}

/**
 * Send email verification
 * @param {string} to - Recipient email
 * @param {string} verificationUrl - Verification link
 * @returns {Promise<boolean>}
 */
async function sendVerificationEmail(to, verificationUrl) {
  return sendEmail({
    to,
    subject: 'Verify Your Email Address',
    template: EMAIL_TEMPLATES.EMAIL_VERIFICATION,
    data: { verificationUrl },
  });
}

/**
 * Send password reset email
 * @param {string} to - Recipient email
 * @param {string} resetUrl - Password reset link
 * @returns {Promise<boolean>}
 */
async function sendPasswordResetEmail(to, resetUrl) {
  return sendEmail({
    to,
    subject: 'Reset Your Password',
    template: EMAIL_TEMPLATES.PASSWORD_RESET,
    data: { resetUrl },
  });
}

/**
 * Send tip received notification
 * @param {string} to - Recipient email
 * @param {Object} data - Tip data
 * @returns {Promise<boolean>}
 */
async function sendTipReceivedEmail(to, data) {
  return sendEmail({
    to,
    subject: `💝 You received a tip of ${data.amount}!`,
    template: EMAIL_TEMPLATES.TIP_RECEIVED,
    data: { ...data, date: new Date().toLocaleString() },
  });
}

/**
 * Send withdrawal completed notification
 * @param {string} to - Recipient email
 * @param {Object} data - Withdrawal data
 * @returns {Promise<boolean>}
 */
async function sendWithdrawalCompletedEmail(to, data) {
  return sendEmail({
    to,
    subject: `✅ Withdrawal of ${data.amount} Completed`,
    template: EMAIL_TEMPLATES.WITHDRAWAL_COMPLETED,
    data,
  });
}

/**
 * Send bid accepted notification
 * @param {string} to - Recipient email
 * @param {Object} data - Bid data
 * @returns {Promise<boolean>}
 */
async function sendBidAcceptedEmail(to, data) {
  return sendEmail({
    to,
    subject: `🎉 Your bid for "${data.campaignTitle}" has been accepted!`,
    template: EMAIL_TEMPLATES.BID_ACCEPTED,
    data,
  });
}

/**
 * Send login alert email
 * @param {string} to - Recipient email
 * @param {Object} data - Login data
 * @returns {Promise<boolean>}
 */
async function sendLoginAlertEmail(to, data) {
  return sendEmail({
    to,
    subject: '🔐 New Login to Your Account',
    template: EMAIL_TEMPLATES.LOGIN_ALERT,
    data,
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
  EMAIL_TEMPLATES,
};
