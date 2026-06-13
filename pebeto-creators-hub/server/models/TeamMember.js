/**
 * Team Member Model for Pebeto Creator's Hub
 * 
 * Manages team members for business accounts.
 * 
 * @module models/TeamMember
 */

const mongoose = require('mongoose');

// ============================================
// Constants
// ============================================

const TEAM_ROLES = {
  OWNER: 'owner',
  ADMIN: 'admin',
  EDITOR: 'editor',
  VIEWER: 'viewer',
};

const TEAM_PERMISSIONS = {
  // Campaign permissions
  CREATE_CAMPAIGN: 'create_campaign',
  EDIT_CAMPAIGN: 'edit_campaign',
  DELETE_CAMPAIGN: 'delete_campaign',
  VIEW_CAMPAIGNS: 'view_campaigns',
  FUND_CAMPAIGN: 'fund_campaign',
  
  // Application permissions
  VIEW_APPLICATIONS: 'view_applications',
  APPROVE_APPLICATION: 'approve_application',
  REJECT_APPLICATION: 'reject_application',
  
  // Creator management
  VIEW_CREATORS: 'view_creators',
  MESSAGE_CREATOR: 'message_creator',
  HIRE_CREATOR: 'hire_creator',
  
  // Financial permissions
  VIEW_WALLET: 'view_wallet',
  WITHDRAW_FUNDS: 'withdraw_funds',
  DEPOSIT_FUNDS: 'deposit_funds',
  VIEW_TRANSACTIONS: 'view_transactions',
  
  // Team management
  MANAGE_TEAM: 'manage_team',
  VIEW_TEAM: 'view_team',
  
  // Settings
  MANAGE_SETTINGS: 'manage_settings',
  VIEW_SETTINGS: 'view_settings',
  
  // Analytics
  VIEW_ANALYTICS: 'view_analytics',
};

const ROLE_PERMISSIONS = {
  [TEAM_ROLES.OWNER]: Object.values(TEAM_PERMISSIONS),
  [TEAM_ROLES.ADMIN]: [
    TEAM_PERMISSIONS.CREATE_CAMPAIGN,
    TEAM_PERMISSIONS.EDIT_CAMPAIGN,
    TEAM_PERMISSIONS.VIEW_CAMPAIGNS,
    TEAM_PERMISSIONS.FUND_CAMPAIGN,
    TEAM_PERMISSIONS.VIEW_APPLICATIONS,
    TEAM_PERMISSIONS.APPROVE_APPLICATION,
    TEAM_PERMISSIONS.REJECT_APPLICATION,
    TEAM_PERMISSIONS.VIEW_CREATORS,
    TEAM_PERMISSIONS.MESSAGE_CREATOR,
    TEAM_PERMISSIONS.HIRE_CREATOR,
    TEAM_PERMISSIONS.VIEW_WALLET,
    TEAM_PERMISSIONS.DEPOSIT_FUNDS,
    TEAM_PERMISSIONS.VIEW_TRANSACTIONS,
    TEAM_PERMISSIONS.VIEW_TEAM,
    TEAM_PERMISSIONS.VIEW_ANALYTICS,
  ],
  [TEAM_ROLES.EDITOR]: [
    TEAM_PERMISSIONS.CREATE_CAMPAIGN,
    TEAM_PERMISSIONS.EDIT_CAMPAIGN,
    TEAM_PERMISSIONS.VIEW_CAMPAIGNS,
    TEAM_PERMISSIONS.VIEW_APPLICATIONS,
    TEAM_PERMISSIONS.VIEW_CREATORS,
    TEAM_PERMISSIONS.MESSAGE_CREATOR,
    TEAM_PERMISSIONS.HIRE_CREATOR,
    TEAM_PERMISSIONS.VIEW_TRANSACTIONS,
    TEAM_PERMISSIONS.VIEW_ANALYTICS,
  ],
  [TEAM_ROLES.VIEWER]: [
    TEAM_PERMISSIONS.VIEW_CAMPAIGNS,
    TEAM_PERMISSIONS.VIEW_APPLICATIONS,
    TEAM_PERMISSIONS.VIEW_CREATORS,
    TEAM_PERMISSIONS.VIEW_TRANSACTIONS,
    TEAM_PERMISSIONS.VIEW_ANALYTICS,
  ],
};

const INVITE_STATUS = {
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  DECLINED: 'declined',
  EXPIRED: 'expired',
  CANCELLED: 'cancelled',
};

// ============================================
// Schema Definition
// ============================================

const teamMemberSchema = new mongoose.Schema(
  {
    // Business account
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    
    // Team member user
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    
    // Role
    role: {
      type: String,
      enum: Object.values(TEAM_ROLES),
      default: TEAM_ROLES.VIEWER,
    },
    
    // Custom permissions (overrides role permissions)
    customPermissions: [{
      type: String,
      enum: Object.values(TEAM_PERMISSIONS),
    }],
    
    // Invitation details
    invitedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    inviteToken: {
      type: String,
      unique: true,
      sparse: true,
    },
    inviteStatus: {
      type: String,
      enum: Object.values(INVITE_STATUS),
      default: INVITE_STATUS.PENDING,
    },
    inviteExpiresAt: {
      type: Date,
      default: () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
    },
    invitedAt: {
      type: Date,
      default: Date.now,
    },
    acceptedAt: {
      type: Date,
    },
    
    // Status
    isActive: {
      type: Boolean,
      default: true,
    },
    
    // Notes
    notes: {
      type: String,
      trim: true,
      maxlength: 500,
    },
    
    // Last activity
    lastActiveAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
  }
);

// ============================================
// Indexes
// ============================================

teamMemberSchema.index({ businessId: 1, userId: 1 }, { unique: true });
teamMemberSchema.index({ businessId: 1, role: 1 });
teamMemberSchema.index({ userId: 1 });
teamMemberSchema.index({ inviteToken: 1 });
teamMemberSchema.index({ inviteStatus: 1, inviteExpiresAt: 1 });

// ============================================
// Virtual Fields
// ============================================

teamMemberSchema.virtual('permissions').get(function() {
  if (this.customPermissions && this.customPermissions.length > 0) {
    return this.customPermissions;
  }
  return ROLE_PERMISSIONS[this.role] || [];
});

teamMemberSchema.virtual('isInviteExpired').get(function() {
  return this.inviteStatus === INVITE_STATUS.PENDING && this.inviteExpiresAt < new Date();
});

// ============================================
// Instance Methods
// ============================================

teamMemberSchema.methods.hasPermission = function(permission) {
  return this.permissions.includes(permission);
};

teamMemberSchema.methods.hasAnyPermission = function(permissions) {
  return permissions.some(p => this.permissions.includes(p));
};

teamMemberSchema.methods.hasAllPermissions = function(permissions) {
  return permissions.every(p => this.permissions.includes(p));
};

teamMemberSchema.methods.acceptInvite = async function() {
  if (this.isInviteExpired) {
    throw new Error('Invite has expired');
  }
  this.inviteStatus = INVITE_STATUS.ACCEPTED;
  this.acceptedAt = new Date();
  await this.save();
  return this;
};

teamMemberSchema.methods.declineInvite = async function() {
  this.inviteStatus = INVITE_STATUS.DECLINED;
  await this.save();
  return this;
};

teamMemberSchema.methods.updateLastActive = async function() {
  this.lastActiveAt = new Date();
  await this.save();
  return this;
};

// ============================================
// Static Methods
// ============================================

/**
 * Get team members for a business
 * @param {string} businessId - Business ID
 * @returns {Promise<Array>} Team members
 */
teamMemberSchema.statics.getTeamMembers = async function(businessId) {
  return this.find({ businessId, isActive: true })
    .populate('userId', 'email uniqueCode profile.displayName profile.avatarUrl')
    .populate('invitedBy', 'email uniqueCode')
    .sort({ role: 1, createdAt: 1 });
};

/**
 * Get team member by user and business
 * @param {string} userId - User ID
 * @param {string} businessId - Business ID
 * @returns {Promise<Object|null>} Team member
 */
teamMemberSchema.statics.getTeamMember = async function(userId, businessId) {
  return this.findOne({ userId, businessId, isActive: true });
};

/**
 * Check if user has permission for a business
 * @param {string} userId - User ID
 * @param {string} businessId - Business ID
 * @param {string} permission - Permission to check
 * @returns {Promise<boolean>} Has permission
 */
teamMemberSchema.statics.hasPermission = async function(userId, businessId, permission) {
  const member = await this.findOne({ userId, businessId, isActive: true });
  if (!member) return false;
  return member.hasPermission(permission);
};

/**
 * Generate invite token
 * @returns {string} Invite token
 */
teamMemberSchema.statics.generateInviteToken = function() {
  const crypto = require('crypto');
  return crypto.randomBytes(32).toString('hex');
};

/**
 * Get pending invites for a business
 * @param {string} businessId - Business ID
 * @returns {Promise<Array>} Pending invites
 */
teamMemberSchema.statics.getPendingInvites = async function(businessId) {
  return this.find({
    businessId,
    inviteStatus: INVITE_STATUS.PENDING,
    inviteExpiresAt: { $gt: new Date() },
  }).populate('invitedBy', 'email');
};

/**
 * Clean up expired invites
 * @returns {Promise<number>} Number of expired invites
 */
teamMemberSchema.statics.cleanupExpiredInvites = async function() {
  const result = await this.updateMany(
    {
      inviteStatus: INVITE_STATUS.PENDING,
      inviteExpiresAt: { $lt: new Date() },
    },
    { inviteStatus: INVITE_STATUS.EXPIRED }
  );
  return result.modifiedCount;
};

// ============================================
// Exports
// ============================================

module.exports = {
  TeamMember: mongoose.model('TeamMember', teamMemberSchema),
  TEAM_ROLES,
  TEAM_PERMISSIONS,
  ROLE_PERMISSIONS,
  INVITE_STATUS,
};
