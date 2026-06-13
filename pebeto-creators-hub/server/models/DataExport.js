/**
 * Data Export Model for GDPR compliance
 * Stores exported user data before account deletion
 * 
 * @module models/DataExport
 */

const mongoose = require('mongoose');

// ============================================
// Constants
// ============================================

const EXPORT_STATUS = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
  EXPIRED: 'expired'
};

const EXPORT_FORMATS = {
  JSON: 'json',
  CSV: 'csv'
};

// ============================================
// Schema Definition
// ============================================

const dataExportSchema = new mongoose.Schema(
  {
    // User who requested the export
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    
    // User email for reference (even after deletion)
    email: {
      type: String,
      required: true,
      index: true
    },
    
    // Export status
    status: {
      type: String,
      enum: Object.values(EXPORT_STATUS),
      default: EXPORT_STATUS.PENDING,
      index: true
    },
    
    // Export format
    format: {
      type: String,
      enum: Object.values(EXPORT_FORMATS),
      default: EXPORT_FORMATS.JSON
    },
    
    // The exported data (stored as JSON)
    data: {
      type: mongoose.Schema.Types.Mixed,
      default: null
    },
    
    // File URL if stored externally (e.g., Cloudinary, S3)
    fileUrl: {
      type: String,
      trim: true
    },
    
    // File size in bytes
    fileSize: {
      type: Number,
      default: 0
    },
    
    // Download token for secure access
    downloadToken: {
      type: String,
      unique: true,
      sparse: true
    },
    
    // Download count tracking
    downloadCount: {
      type: Number,
      default: 0
    },
    
    // Last download timestamp
    lastDownloadedAt: {
      type: Date
    },
    
    // Error message if failed
    errorMessage: {
      type: String,
      trim: true
    },
    
    // Processing timestamps
    processingStartedAt: {
      type: Date
    },
    processingCompletedAt: {
      type: Date
    },
    
    // Expiration timestamp (auto-delete after TTL)
    expiresAt: {
      type: Date,
      required: true,
      index: { expiresAfterSeconds: 0 }, // Auto-delete when expired
      default: function() {
        return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days
      }
    },
    
    // Metadata about what data was included
    metadata: {
      includedData: {
        profile: { type: Boolean, default: true },
        transactions: { type: Boolean, default: true },
        campaigns: { type: Boolean, default: true },
        posts: { type: Boolean, default: true },
        comments: { type: Boolean, default: true },
        socialLinks: { type: Boolean, default: true },
        payoutProfiles: { type: Boolean, default: true }
      },
      recordCount: {
        transactions: { type: Number, default: 0 },
        campaigns: { type: Number, default: 0 },
        posts: { type: Number, default: 0 },
        comments: { type: Number, default: 0 }
      },
      requestIp: { type: String },
      requestUserAgent: { type: String }
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

// User lookup
dataExportSchema.index({ userId: 1, createdAt: -1 });

// Status for processing queue
dataExportSchema.index({ status: 1, createdAt: 1 });

// Download token lookup
dataExportSchema.index({ downloadToken: 1 });

// Email lookup for GDPR requests
dataExportSchema.index({ email: 1 });

// ============================================
// Virtual Fields
// ============================================

/**
 * Check if export is ready for download
 */
dataExportSchema.virtual('isReady').get(function() {
  return this.status === EXPORT_STATUS.COMPLETED && this.expiresAt > new Date();
});

/**
 * Check if export has expired
 */
dataExportSchema.virtual('isExpired').get(function() {
  return this.expiresAt <= new Date() || this.status === EXPORT_STATUS.EXPIRED;
});

/**
 * Get human-readable file size
 */
dataExportSchema.virtual('fileSizeHuman').get(function() {
  if (this.fileSize === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(this.fileSize) / Math.log(1024));
  return `${(this.fileSize / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
});

/**
 * Get time remaining until expiration
 */
dataExportSchema.virtual('timeRemaining').get(function() {
  const remaining = this.expiresAt - new Date();
  if (remaining <= 0) return 'Expired';
  const days = Math.floor(remaining / (1000 * 60 * 60 * 24));
  if (days > 0) return `${days} day${days !== 1 ? 's' : ''}`;
  const hours = Math.floor(remaining / (1000 * 60 * 60));
  return `${hours} hour${hours !== 1 ? 's' : ''}`;
});

// ============================================
// Instance Methods
// ============================================

/**
 * Generate a secure download token
 * @returns {string} Download token
 */
dataExportSchema.methods.generateDownloadToken = function() {
  const crypto = require('crypto');
  this.downloadToken = crypto.randomBytes(32).toString('hex');
  return this.downloadToken;
};

/**
 * Mark export as processing
 * @returns {Promise<DataExport>}
 */
dataExportSchema.methods.markProcessing = async function() {
  this.status = EXPORT_STATUS.PROCESSING;
  this.processingStartedAt = new Date();
  await this.save();
  return this;
};

/**
 * Mark export as completed with data
 * @param {Object} exportData - The exported data
 * @param {string} fileUrl - Optional external file URL
 * @returns {Promise<DataExport>}
 */
dataExportSchema.methods.markCompleted = async function(exportData, fileUrl = null) {
  this.status = EXPORT_STATUS.COMPLETED;
  this.data = exportData;
  if (fileUrl) this.fileUrl = fileUrl;
  this.processingCompletedAt = new Date();
  await this.generateDownloadToken();
  await this.save();
  return this;
};

/**
 * Mark export as failed
 * @param {string} errorMessage - Error description
 * @returns {Promise<DataExport>}
 */
dataExportSchema.methods.markFailed = async function(errorMessage) {
  this.status = EXPORT_STATUS.FAILED;
  this.errorMessage = errorMessage;
  await this.save();
  return this;
};

/**
 * Record a download
 * @returns {Promise<DataExport>}
 */
dataExportSchema.methods.recordDownload = async function() {
  this.downloadCount += 1;
  this.lastDownloadedAt = new Date();
  await this.save();
  return this;
};

/**
 * Invalidate download token (after download or expiration)
 * @returns {Promise<DataExport>}
 */
dataExportSchema.methods.invalidateToken = async function() {
  this.downloadToken = null;
  await this.save();
  return this;
};

// ============================================
// Static Methods
// ============================================

/**
 * Create a new data export request
 * @param {Object} params - Export parameters
 * @returns {Promise<DataExport>}
 */
dataExportSchema.statics.createExportRequest = async function({ userId, email, format = 'json', metadata = {} }) {
  const exportRequest = new this({
    userId,
    email,
    format,
    status: EXPORT_STATUS.PENDING,
    metadata: {
      ...metadata,
      requestIp: metadata.requestIp,
      requestUserAgent: metadata.requestUserAgent
    }
  });
  await exportRequest.save();
  return exportRequest;
};

/**
 * Find active export for user
 * @param {string} userId - User ID
 * @returns {Promise<DataExport|null>}
 */
dataExportSchema.statics.findActiveExport = async function(userId) {
  return this.findOne({
    userId,
    status: EXPORT_STATUS.COMPLETED,
    expiresAt: { $gt: new Date() }
  }).sort({ createdAt: -1 });
};

/**
 * Find by download token (for secure download)
 * @param {string} token - Download token
 * @returns {Promise<DataExport|null>}
 */
dataExportSchema.statics.findByDownloadToken = async function(token) {
  return this.findOne({
    downloadToken: token,
    status: EXPORT_STATUS.COMPLETED,
    expiresAt: { $gt: new Date() }
  });
};

/**
 * Get pending exports for processing queue
 * @param {number} limit - Max number to fetch
 * @returns {Promise<Array>}
 */
dataExportSchema.statics.getPendingExports = async function(limit = 10) {
  return this.find({
    status: EXPORT_STATUS.PENDING,
    expiresAt: { $gt: new Date() }
  })
    .sort({ createdAt: 1 })
    .limit(limit);
};

/**
 * Clean up expired exports (mark as expired)
 * @returns {Promise<number>} Number of exports marked as expired
 */
dataExportSchema.statics.cleanupExpired = async function() {
  const result = await this.updateMany(
    {
      expiresAt: { $lt: new Date() },
      status: { $ne: EXPORT_STATUS.EXPIRED }
    },
    { status: EXPORT_STATUS.EXPIRED }
  );
  return result.modifiedCount;
};

/**
 * Delete old completed exports (older than days)
 * @param {number} days - Days to keep
 * @returns {Promise<number>} Number of exports deleted
 */
dataExportSchema.statics.deleteOldExports = async function(days = 90) {
  const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const result = await this.deleteMany({
    status: EXPORT_STATUS.COMPLETED,
    createdAt: { $lt: cutoffDate }
  });
  return result.deletedCount;
};

// ============================================
// Pre-save Hooks
// ============================================

/**
 * Auto-generate download token if not present and status is completed
 */
dataExportSchema.pre('save', async function(next) {
  if (this.status === EXPORT_STATUS.COMPLETED && !this.downloadToken) {
    await this.generateDownloadToken();
  }
  next();
});

// ============================================
// Exports
// ============================================

module.exports = mongoose.model('DataExport', dataExportSchema);
module.exports.EXPORT_STATUS = EXPORT_STATUS;
module.exports.EXPORT_FORMATS = EXPORT_FORMATS;
