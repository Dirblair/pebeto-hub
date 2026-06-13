/**
 * User Model for Pebeto Creator's Hub
 * 
 * Manages user accounts including creators, businesses, and admins.
 * Handles authentication, profiles, payout methods, and user settings.
 * 
 * @module models/User
 */

const mongoose = require('mongoose');
const crypto = require('crypto');

// ============================================
// Constants
// ============================================

const USER_ROLES = {
  ADMIN: 'admin',
  BUSINESS: 'business',
  CREATOR: 'creator'
};

const USER_STATUS = {
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  PENDING: 'pending',
  BANNED: 'banned',
  DEACTIVATED: 'deactivated'
};

const PAYOUT_METHODS = {
  MPESA: 'mpesa',
  PAYPAL: 'paypal',
  SWIFT: 'swift',
  BANK_TRANSFER: 'bank_transfer'
};

// ============================================
// Sub-Schemas
// ============================================

const payoutDetailsSchema = new mongoose.Schema(
  {
    // M-Pesa
    phoneNumber: {
      type: String,
      trim: true,
      validate: {
        validator: function(v) {
          if (!v) return true;
          return /^(254|\+254|0)[7-9][0-9]{8}$/.test(v);
        },
        message: 'Invalid phone number format'
      }
    },
    
    // Generic
    accountName: { type: String, trim: true, maxlength: 100 },
    
    // PayPal
    paypalEmail: {
      type: String,
      trim: true,
      lowercase: true,
      validate: {
        validator: function(v) {
          if (!v) return true;
          return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
        },
        message: 'Invalid email format'
      }
    },
    
    // Bank Transfer / SWIFT
    bankName: { type: String, trim: true, maxlength: 100 },
    accountNumber: { type: String, trim: true, maxlength: 50 },
    swiftCode: { type: String, trim: true, uppercase: true, maxlength: 11 },
    accountHolderName: { type: String, trim: true, maxlength: 100 },
    iban: { type: String, trim: true, uppercase: true, maxlength: 34 },
    country: { type: String, trim: true, uppercase: true, maxlength: 2 },
    
    // Additional fields
    routingNumber: { type: String, trim: true, maxlength: 20 },
    branchCode: { type: String, trim: true, maxlength: 20 }
  },
  { _id: false }
);

const payoutProfileSchema = new mongoose.Schema({
  method: { 
    type: String, 
    enum: Object.values(PAYOUT_METHODS), 
    required: true 
  },
  label: {
    type: String,
    trim: true,
    maxlength: 50,
    default: function() {
      return this.method.toUpperCase();
    }
  },
  isDefault: { 
    type: Boolean, 
    default: false 
  },
  details: {
    type: payoutDetailsSchema,
    required: true,
    validate: {
      validator: function(details) {
        // Validate required fields based on method
        const parent = this.parent();
        if (!parent) return true;
        
        switch (parent.method) {
          case PAYOUT_METHODS.MPESA:
            return !!details.phoneNumber;
          case PAYOUT_METHODS.PAYPAL:
            return !!details.paypalEmail;
          case PAYOUT_METHODS.SWIFT:
            return !!(details.bankName && details.accountNumber && details.swiftCode && details.accountHolderName);
          case PAYOUT_METHODS.BANK_TRANSFER:
            return !!(details.bankName && details.accountNumber && details.accountHolderName);
          default:
            return true;
        }
      },
      message: 'Incomplete payout details for selected method'
    }
  },
  createdAt: { 
    type: Date, 
    default: Date.now 
  },
  updatedAt: { 
    type: Date, 
    default: Date.now 
  }
});

const loginAttemptSchema = new mongoose.Schema({
  timestamp: { type: Date, default: Date.now },
  success: { type: Boolean, required: true },
  ipAddress: { type: String },
  userAgent: { type: String }
}, { _id: false });

// ============================================
// NEW: API Key Sub-Schema
// ============================================

const apiKeySchema = new mongoose.Schema({
  id: { 
    type: String, 
    required: true 
  },
  name: { 
    type: String, 
    default: 'Default API Key',
    trim: true,
    maxlength: 50
  },
  key: { 
    type: String, 
    required: true 
  },
  createdAt: { 
    type: Date, 
    default: Date.now 
  },
  lastUsedAt: { 
    type: Date 
  },
  regeneratedAt: { 
    type: Date 
  },
  isActive: { 
    type: Boolean, 
    default: true 
  }
}, { _id: false });

// ============================================
// Main User Schema
// ============================================

const userSchema = new mongoose.Schema(
  {
    // ========== Authentication ==========
    email: { 
      type: String, 
      required: true, 
      unique: true, 
      lowercase: true, 
      trim: true,
      index: true,
      validate: {
        validator: function(v) {
          return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
        },
        message: 'Invalid email format'
      }
    },
    passwordHash: { 
      type: String, 
      required: true,
      select: false // Don't return by default
    },
    
    // Password reset
    resetPasswordToken: { type: String, select: false },
    resetPasswordExpires: { type: Date, select: false },
    
    // Email verification
    emailVerified: { 
      type: Boolean, 
      default: false,
      index: true
    },
    emailVerificationToken: { type: String, select: false },
    emailVerificationExpires: { type: Date, select: false },
    
    // Session management
    // ============================================
    // NEW: tokenVersion for session invalidation
    // ============================================
    tokenVersion: { 
      type: Number, 
      default: 0,
      description: 'Increment to invalidate all existing sessions'
    },
    
    // Login tracking
    lastLoginAt: { type: Date },
    lastLoginIp: { type: String },
    loginAttempts: [loginAttemptSchema],
    failedLoginCount: { type: Number, default: 0 },
    lockedUntil: { type: Date },
    
    // ========== User Information ==========
    role: { 
      type: String, 
      enum: Object.values(USER_ROLES), 
      required: true,
      index: true
    },
    uniqueCode: { 
      type: String, 
      unique: true, 
      sparse: true,
      index: true,
      uppercase: true,
      trim: true,
      minlength: 6,
      maxlength: 12,
      validate: {
        validator: function(v) {
          if (!v) return true;
          return /^[A-Z0-9]{6,12}$/.test(v);
        },
        message: 'Unique code must be 6-12 alphanumeric characters'
      }
    },
    
    // Preferences
    preferredLanguage: { 
      type: String, 
      default: 'en',
      maxlength: 5
    },
    preferredCurrency: { 
      type: String, 
      default: 'USD',
      uppercase: true,
      maxlength: 3,
      validate: {
        validator: function(v) {
          return ['USD', 'KES', 'EUR', 'GBP', 'NGN', 'ZAR', 'GHS'].includes(v);
        },
        message: 'Unsupported currency'
      }
    },
    
    // Account status
    status: { 
      type: String, 
      enum: Object.values(USER_STATUS), 
      default: USER_STATUS.PENDING,
      index: true
    },
    statusReason: {
      type: String,
      trim: true,
      maxlength: 500
    },
    deactivatedAt: { type: Date },
    reactivatedAt: { type: Date },
    
    // ========== Profile Information ==========
    profile: {
      // Common
      displayName: { 
        type: String, 
        trim: true,
        maxlength: 100
      },
      bio: { 
        type: String, 
        trim: true,
        maxlength: 500
      },
      avatarUrl: { 
        type: String, 
        trim: true,
        validate: {
          validator: function(v) {
            if (!v) return true;
            return /^https?:\/\//.test(v);
          },
          message: 'Avatar URL must be a valid HTTP/HTTPS URL'
        }
      },
      
      // Creator specific
      stageName: { 
        type: String, 
        trim: true,
        maxlength: 50
      },
      niche: { 
        type: String, 
        trim: true,
        maxlength: 50,
        index: true
      },
      tags: [{
        type: String,
        trim: true,
        lowercase: true,
        maxlength: 30
      }],
      
      // Business specific
      companyName: { 
        type: String, 
        trim: true,
        maxlength: 100,
        index: true
      },
      website: { 
        type: String, 
        trim: true,
        validate: {
          validator: function(v) {
            if (!v) return true;
            return /^https?:\/\//.test(v);
          },
          message: 'Website must be a valid HTTP/HTTPS URL'
        }
      },
      
      // Common additional fields
      refereeName: { type: String, trim: true, maxlength: 100 },
      location: { type: String, trim: true, maxlength: 100 },
      phoneNumber: { type: String, trim: true }
    },
    
    // ============================================
    // SOCIAL MEDIA LINKS FOR CREATORS
    // ============================================
    socialLinks: {
      tiktok: { type: String, default: '' },
      youtube: { type: String, default: '' },
      instagram: { type: String, default: '' },
      twitter: { type: String, default: '' }
    },
    
    // ========== Payout Settings ==========
    payoutProfiles: [payoutProfileSchema],
    defaultPayoutProfileId: { 
      type: mongoose.Schema.Types.ObjectId 
    },
    
    // ========== Social Metrics ==========
    social: {
      followerCount: { type: Number, default: 0, min: 0 },
      followingCount: { type: Number, default: 0, min: 0 },
      engagementRate: { type: Number, default: 0, min: 0, max: 100 },
      totalTipsReceived: { type: Number, default: 0, min: 0 },
      totalTipsSent: { type: Number, default: 0, min: 0 },
      totalWithdrawn: { type: Number, default: 0, min: 0 },
      campaignsCompleted: { type: Number, default: 0, min: 0 }
    },
    
    // ============================================
    // Creator Likes Tracking (for community engagement)
    // ============================================
    likedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    likeCount: { type: Number, default: 0 },
    
    // ========== Security ==========
    publicKey: { type: String, trim: true },
    twoFactorEnabled: { type: Boolean, default: false },
    
    // ============================================
    // NEW: twoFactorSecret for 2FA
    // ============================================
    twoFactorSecret: { 
      type: String, 
      select: false  // Don't return by default
    },
    
    // ============================================
    // NEW: API Keys array
    // ============================================
    apiKeys: [apiKeySchema],
    
    // ============================================
    // NEW: Notification Preferences
    // ============================================
    notificationPreferences: {
      emailOnLogin: { type: Boolean, default: true },
      emailOnTip: { type: Boolean, default: true },
      emailOnBidAccepted: { type: Boolean, default: true },
      emailOnCampaignUpdate: { type: Boolean, default: true },
      emailOnWithdrawal: { type: Boolean, default: true },
      pushOnTip: { type: Boolean, default: true },
      pushOnMessage: { type: Boolean, default: true }
    },
    
    // ========== Metadata ==========
    metadata: {
      registrationIp: { type: String },
      lastSeenIp: { type: String },
      lastSeenAt: { type: Date },
      deviceInfo: { type: String },
      referrerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      referralCode: { type: String, index: true, sparse: true }
    }
  },
  { 
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
);

// ============================================
// Indexes
// ============================================

// Authentication indexes
userSchema.index({ email: 1 });
userSchema.index({ uniqueCode: 1 });
userSchema.index({ 'metadata.referralCode': 1 });

// Status and role queries
userSchema.index({ status: 1, role: 1 });
userSchema.index({ role: 1, createdAt: -1 });
userSchema.index({ status: 1, createdAt: -1 });

// Profile search indexes
userSchema.index({ 'profile.stageName': 'text', 'profile.displayName': 'text', 'profile.companyName': 'text' });
userSchema.index({ 'profile.niche': 1, role: 1 });
userSchema.index({ 'profile.companyName': 1 });
userSchema.index({ 'profile.tags': 1 });

// Social metrics
userSchema.index({ 'social.followerCount': -1 });
userSchema.index({ 'social.totalTipsReceived': -1 });

// Creator likes indexes (NEW)
userSchema.index({ likeCount: -1 });
userSchema.index({ likedBy: 1 });

// Lockout and cleanup
userSchema.index({ lockedUntil: 1 }, { expireAfterSeconds: 0, partialFilterExpression: { lockedUntil: { $exists: true } } });
userSchema.index({ status: 1, deactivatedAt: 1 });

// ============================================
// Virtual Fields
// ============================================

/**
 * Check if user is a creator
 */
userSchema.virtual('isCreator').get(function() {
  return this.role === USER_ROLES.CREATOR;
});

/**
 * Check if user is a business
 */
userSchema.virtual('isBusiness').get(function() {
  return this.role === USER_ROLES.BUSINESS;
});

/**
 * Check if user is an admin
 */
userSchema.virtual('isAdmin').get(function() {
  return this.role === USER_ROLES.ADMIN;
});

/**
 * Check if user account is active
 */
userSchema.virtual('isActive').get(function() {
  return this.status === USER_STATUS.ACTIVE && this.emailVerified === true;
});

/**
 * Check if user account is locked
 */
userSchema.virtual('isLocked').get(function() {
  return this.lockedUntil && this.lockedUntil > new Date();
});

/**
 * Get user's primary display name
 */
userSchema.virtual('displayName').get(function() {
  if (this.role === USER_ROLES.CREATOR && this.profile?.stageName) {
    return this.profile.stageName;
  }
  if (this.role === USER_ROLES.BUSINESS && this.profile?.companyName) {
    return this.profile.companyName;
  }
  return this.profile?.displayName || this.email.split('@')[0];
});

/**
 * Get user's avatar URL or default
 */
userSchema.virtual('avatar').get(function() {
  return this.profile?.avatarUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(this.displayName)}&background=ff8c42&color=fff`;
});

/**
 * Get default payout profile
 */
userSchema.virtual('defaultPayoutProfile').get(function() {
  if (this.defaultPayoutProfileId) {
    return this.payoutProfiles.find(p => p._id.equals(this.defaultPayoutProfileId));
  }
  return this.payoutProfiles.find(p => p.isDefault) || this.payoutProfiles[0];
});

/**
 * Get user's unique identifier for display
 */
userSchema.virtual('publicIdentifier').get(function() {
  return this.uniqueCode || this.displayName || this.email;
});

// ============================================
// Instance Methods
// ============================================

/**
 * Check if user has a specific role
 * @param {string|Array} roles - Role or array of roles to check
 * @returns {boolean}
 */
userSchema.methods.hasRole = function(roles) {
  if (Array.isArray(roles)) {
    return roles.includes(this.role);
  }
  return this.role === roles;
};

/**
 * Increment failed login attempts and possibly lock account
 * @param {Object} options - Login attempt details
 * @returns {Promise<boolean>} True if account is now locked
 */
userSchema.methods.recordFailedLogin = async function(options = {}) {
  this.failedLoginCount += 1;
  this.loginAttempts.push({
    timestamp: new Date(),
    success: false,
    ipAddress: options.ipAddress,
    userAgent: options.userAgent
  });
  
  // Lock after 10 failed attempts
  const MAX_FAILED_ATTEMPTS = 10;
  const LOCKOUT_MINUTES = 30;
  
  if (this.failedLoginCount >= MAX_FAILED_ATTEMPTS) {
    this.lockedUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000);
    await this.save();
    return true;
  }
  
  await this.save();
  return false;
};

/**
 * Reset failed login attempts
 * @returns {Promise<void>}
 */
userSchema.methods.resetFailedLogins = async function() {
  this.failedLoginCount = 0;
  this.lockedUntil = null;
  await this.save();
};

/**
 * Record successful login
 * @param {Object} options - Login details
 * @returns {Promise<void>}
 */
userSchema.methods.recordSuccessfulLogin = async function(options = {}) {
  this.lastLoginAt = new Date();
  this.lastLoginIp = options.ipAddress;
  this.failedLoginCount = 0;
  this.lockedUntil = null;
  this.loginAttempts.push({
    timestamp: new Date(),
    success: true,
    ipAddress: options.ipAddress,
    userAgent: options.userAgent
  });
  
  // Keep only last 50 login attempts
  if (this.loginAttempts.length > 50) {
    this.loginAttempts = this.loginAttempts.slice(-50);
  }
  
  await this.save();
};

/**
 * Increment token version to invalidate all existing sessions
 * @returns {Promise<void>}
 */
userSchema.methods.invalidateSessions = async function() {
  this.tokenVersion += 1;
  await this.save();
};

/**
 * Generate email verification token
 * @returns {string} Verification token
 */
userSchema.methods.generateEmailVerificationToken = function() {
  const token = crypto.randomBytes(32).toString('hex');
  this.emailVerificationToken = token;
  this.emailVerificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
  return token;
};

/**
 * Generate password reset token
 * @returns {string} Reset token
 */
userSchema.methods.generatePasswordResetToken = function() {
  const token = crypto.randomBytes(32).toString('hex');
  this.resetPasswordToken = token;
  this.resetPasswordExpires = new Date(Date.now() + 1 * 60 * 60 * 1000); // 1 hour
  return token;
};

/**
 * Verify email
 * @param {string} token - Verification token
 * @returns {Promise<boolean>} True if verified
 */
userSchema.methods.verifyEmail = async function(token) {
  if (this.emailVerificationToken !== token) return false;
  if (this.emailVerificationExpires < new Date()) return false;
  
  this.emailVerified = true;
  this.emailVerificationToken = null;
  this.emailVerificationExpires = null;
  
  if (this.status === USER_STATUS.PENDING) {
    this.status = USER_STATUS.ACTIVE;
  }
  
  await this.save();
  return true;
};

/**
 * Deactivate user account
 * @param {string} reason - Reason for deactivation
 * @returns {Promise<void>}
 */
userSchema.methods.deactivate = async function(reason) {
  this.status = USER_STATUS.DEACTIVATED;
  this.statusReason = reason;
  this.deactivatedAt = new Date();
  await this.save();
};

/**
 * Reactivate user account
 * @returns {Promise<void>}
 */
userSchema.methods.reactivate = async function() {
  this.status = USER_STATUS.ACTIVE;
  this.statusReason = null;
  this.reactivatedAt = new Date();
  await this.save();
};

/**
 * Add payout profile
 * @param {Object} profileData - Payout profile data
 * @returns {Promise<Object>} Created profile
 */
userSchema.methods.addPayoutProfile = async function(profileData) {
  // If this is the first profile, make it default
  const isFirst = this.payoutProfiles.length === 0;
  
  const profile = {
    method: profileData.method,
    label: profileData.label,
    isDefault: isFirst || profileData.isDefault || false,
    details: profileData.details
  };
  
  // If setting as default, unset other defaults
  if (profile.isDefault) {
    this.payoutProfiles.forEach(p => p.isDefault = false);
  }
  
  this.payoutProfiles.push(profile);
  
  if (isFirst) {
    this.defaultPayoutProfileId = this.payoutProfiles[0]._id;
  }
  
  await this.save();
  return profile;
};

/**
 * Set default payout profile
 * @param {string} profileId - Profile ID
 * @returns {Promise<boolean>} True if successful
 */
userSchema.methods.setDefaultPayoutProfile = async function(profileId) {
  const profile = this.payoutProfiles.id(profileId);
  if (!profile) return false;
  
  this.payoutProfiles.forEach(p => p.isDefault = false);
  profile.isDefault = true;
  this.defaultPayoutProfileId = profileId;
  
  await this.save();
  return true;
};

/**
 * Remove payout profile
 * @param {string} profileId - Profile ID
 * @returns {Promise<boolean>} True if removed
 */
userSchema.methods.removePayoutProfile = async function(profileId) {
  const profile = this.payoutProfiles.id(profileId);
  if (!profile) return false;
  
  // Cannot remove default profile if it's the only one
  if (profile.isDefault && this.payoutProfiles.length === 1) {
    throw new Error('Cannot remove the only payout profile');
  }
  
  profile.remove();
  
  // If removed profile was default, set another as default
  if (profile.isDefault && this.payoutProfiles.length > 0) {
    this.payoutProfiles[0].isDefault = true;
    this.defaultPayoutProfileId = this.payoutProfiles[0]._id;
  }
  
  await this.save();
  return true;
};

/**
 * Update last seen timestamp
 * @param {string} ipAddress - User's IP address
 * @returns {Promise<void>}
 */
userSchema.methods.updateLastSeen = async function(ipAddress) {
  this.metadata.lastSeenAt = new Date();
  if (ipAddress) this.metadata.lastSeenIp = ipAddress;
  await this.save();
};

// ============================================
// Static Methods
// ============================================

/**
 * Find user by email with password hash (for login)
 * @param {string} email - User email
 * @returns {Query} Mongoose query
 */
userSchema.statics.findByEmailForAuth = function(email) {
  return this.findOne({ email: email.toLowerCase() }).select('+passwordHash');
};

/**
 * Find user by unique code
 * @param {string} uniqueCode - User's unique code
 * @returns {Query} Mongoose query
 */
userSchema.statics.findByUniqueCode = function(uniqueCode) {
  return this.findOne({ uniqueCode: uniqueCode.toUpperCase() });
};

/**
 * Generate a unique unique code for creator
 * @returns {Promise<string>} Unique code
 */
userSchema.statics.generateUniqueCode = async function() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let isUnique = false;
  let code = '';
  
  while (!isUnique) {
    code = '';
    for (let i = 0; i < 8; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    const existing = await this.findOne({ uniqueCode: code });
    if (!existing) isUnique = true;
  }
  
  return code;
};

/**
 * Get user statistics by role
 * @returns {Promise<Object>} Statistics
 */
userSchema.statics.getStatsByRole = async function() {
  const stats = await this.aggregate([
    { $group: {
      _id: '$role',
      count: { $sum: 1 },
      active: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } },
      pending: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] } },
      suspended: { $sum: { $cond: [{ $eq: ['$status', 'suspended'] }, 1, 0] } }
    }}
  ]);
  
  const result = {};
  stats.forEach(s => { result[s._id] = s; });
  return result;
};

/**
 * Find active users by role
 * @param {string} role - User role
 * @param {number} limit - Max results
 * @returns {Query} Mongoose query
 */
userSchema.statics.findActiveByRole = function(role, limit = 100) {
  return this.find({ role, status: USER_STATUS.ACTIVE, emailVerified: true })
    .sort({ createdAt: -1 })
    .limit(limit);
};

// ============================================
// Pre-Save Hooks
// ============================================

/**
 * Ensure unique code for creators
 */
userSchema.pre('save', async function(next) {
  if (this.isCreator && !this.uniqueCode) {
    this.uniqueCode = await this.constructor.generateUniqueCode();
  }
  next();
});

/**
 * Update payout profile timestamps
 */
userSchema.pre('save', function(next) {
  if (this.isModified('payoutProfiles')) {
    this.payoutProfiles.forEach(profile => {
      if (profile.isModified()) {
        profile.updatedAt = new Date();
      }
    });
  }
  next();
});

/**
 * Validate default payout profile exists
 */
userSchema.pre('save', function(next) {
  if (this.defaultPayoutProfileId && this.payoutProfiles.length > 0) {
    const exists = this.payoutProfiles.some(p => p._id.equals(this.defaultPayoutProfileId));
    if (!exists) {
      this.defaultPayoutProfileId = null;
    }
  }
  next();
});

// ============================================
// Create and Export Model
// ============================================

const UserModel = mongoose.model('User', userSchema);

// Export as both direct and named for compatibility
module.exports = UserModel;
module.exports.User = UserModel;
module.exports.USER_ROLES = USER_ROLES;
module.exports.USER_STATUS = USER_STATUS;
module.exports.PAYOUT_METHODS = PAYOUT_METHODS;
