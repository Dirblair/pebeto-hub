const mongoose = require('mongoose');

// ============================================
// Constants
// ============================================

const MEDIA_TYPES = {
  IMAGE: 'image',
  VIDEO: 'video',
  AUDIO: 'audio'
};

const POST_CATEGORIES = [
  'Music', 'Art', 'Fitness', 'Gaming', 'Tech', 
  'Comedy', 'Education', 'Lifestyle', 'Dance', 
  'Sports', 'Food', 'Fashion', 'Travel', 'Other'
];

// ============================================
// Schema Definition
// ============================================

const communityPostSchema = new mongoose.Schema({
  // ===== Author =====
  authorId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: true,
    index: true
  },

  // ===== Media =====
  mediaUrl: { 
    type: String, 
    required: true,
    trim: true,
    validate: {
      validator: function(v) {
        return /^https?:\/\//.test(v);
      },
      message: 'Media URL must be a valid HTTP/HTTPS URL'
    }
  },
  mediaType: { 
    type: String, 
    enum: Object.values(MEDIA_TYPES), 
    default: MEDIA_TYPES.VIDEO 
  },
  thumbnailUrl: { 
    type: String,
    trim: true,
    validate: {
      validator: function(v) {
        if (!v) return true;
        return /^https?:\/\//.test(v);
      },
      message: 'Thumbnail URL must be a valid HTTP/HTTPS URL'
    }
  },
  
  // ===== Audio/Sound =====
  sound: { 
    type: String, 
    default: 'Original Sound',
    trim: true,
    maxlength: 100
  },
  audioUrl: { 
    type: String,
    trim: true,
    validate: {
      validator: function(v) {
        if (!v) return true;
        return /^https?:\/\//.test(v);
      },
      message: 'Audio URL must be a valid HTTP/HTTPS URL'
    }
  },
  
  // ===== Content =====
  caption: { 
    type: String, 
    maxlength: 500,
    trim: true
  },
  tags: [{ 
    type: String, 
    trim: true, 
    lowercase: true,
    maxlength: 30,
    index: true
  }],
  category: { 
    type: String, 
    enum: POST_CATEGORIES,
    default: 'Other',
    index: true
  },
  
  // ===== Video Metadata =====
  duration: { 
    type: Number, 
    default: 0,
    min: 0,
    description: 'Video duration in seconds'
  },
  
  // ===== Engagement =====
  likes: [{ 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User' 
  }],
  likeCount: { 
    type: Number, 
    default: 0,
    min: 0
  },
  commentCount: { 
    type: Number, 
    default: 0,
    min: 0
  },
  views: { 
    type: Number, 
    default: 0,
    min: 0
  },
  shares: { 
    type: Number, 
    default: 0,
    min: 0
  },
  
  // ===== Status Flags =====
  isLive: { 
    type: Boolean, 
    default: false 
  },
  isTrending: { 
    type: Boolean, 
    default: false,
    index: true
  },
  isFeatured: { 
    type: Boolean, 
    default: false 
  },
  isDeleted: { 
    type: Boolean, 
    default: false,
    index: true
  },
  
  // ===== Privacy =====
  visibility: { 
    type: String, 
    enum: ['public', 'followers', 'private'], 
    default: 'public' 
  },
  
  // ===== Geotagging (Optional) =====
  location: {
    type: String,
    trim: true,
    maxlength: 100
  },
  
  // ===== Timestamps =====
  createdAt: { 
    type: Date, 
    default: Date.now,
    index: true
  },
  updatedAt: { 
    type: Date, 
    default: Date.now,
    index: true
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// ============================================
// Indexes
// ============================================

// Feed queries
communityPostSchema.index({ createdAt: -1 });
communityPostSchema.index({ authorId: 1, createdAt: -1 });
communityPostSchema.index({ isTrending: 1, likeCount: -1 });
communityPostSchema.index({ category: 1, createdAt: -1 });

// Engagement sorting
communityPostSchema.index({ likeCount: -1 });
communityPostSchema.index({ views: -1 });

// Privacy filtering
communityPostSchema.index({ visibility: 1, createdAt: -1 });

// Search
communityPostSchema.index({ 
  caption: 'text', 
  tags: 'text',
  sound: 'text'
}, {
  weights: {
    tags: 10,
    caption: 5,
    sound: 2
  }
});

// ============================================
// Virtual Fields
// ============================================

/**
 * Check if post has media
 */
communityPostSchema.virtual('hasMedia').get(function() {
  return !!this.mediaUrl;
});

/**
 * Check if post has audio
 */
communityPostSchema.virtual('hasAudio').get(function() {
  return !!this.audioUrl;
});

/**
 * Get formatted duration
 */
communityPostSchema.virtual('durationFormatted').get(function() {
  if (!this.duration) return '0:00';
  const mins = Math.floor(this.duration / 60);
  const secs = Math.floor(this.duration % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
});

/**
 * Check if post is trending
 */
communityPostSchema.virtual('isTrendingPost').get(function() {
  // Consider trending if more than 1000 views and 100 likes in the last 7 days
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  return this.views > 1000 && this.likeCount > 100 && this.createdAt > weekAgo;
});

// ============================================
// Instance Methods
// ============================================

/**
 * Toggle like on post
 * @param {string} userId - User ID
 * @returns {Promise<Object>} { liked, likeCount }
 */
communityPostSchema.methods.toggleLike = async function(userId) {
  const userIdStr = userId.toString();
  const hasLiked = this.likes.some(id => id.toString() === userIdStr);
  
  if (hasLiked) {
    this.likes = this.likes.filter(id => id.toString() !== userIdStr);
    this.likeCount = Math.max(0, this.likeCount - 1);
  } else {
    this.likes.push(userId);
    this.likeCount += 1;
  }
  
  await this.save();
  return { liked: !hasLiked, likeCount: this.likeCount };
};

/**
 * Increment view count
 * @returns {Promise<number>} New view count
 */
communityPostSchema.methods.incrementViews = async function() {
  this.views += 1;
  await this.save();
  return this.views;
};

/**
 * Increment share count
 * @returns {Promise<number>} New share count
 */
communityPostSchema.methods.incrementShares = async function() {
  this.shares += 1;
  await this.save();
  return this.shares;
};

/**
 * Soft delete post
 * @returns {Promise<Post>}
 */
communityPostSchema.methods.softDelete = async function() {
  this.isDeleted = true;
  await this.save();
  return this;
};

// ============================================
// Static Methods
// ============================================

/**
 * Get feed posts with filters
 * @param {Object} options - Filter options
 * @returns {Promise<Array>} Posts
 */
communityPostSchema.statics.getFeed = async function(options = {}) {
  const { 
    userId, 
    tab = 'foryou', 
    limit = 20, 
    skip = 0,
    following = [],
    mutualFollows = []
  } = options;
  
  let query = { isDeleted: false };
  
  // Apply visibility
  if (userId) {
    query.$or = [
      { visibility: 'public' },
      { 
        $and: [
          { visibility: 'followers' },
          { authorId: { $in: following } }
        ]
      },
      { authorId: userId } // User's own posts
    ];
  } else {
    query.visibility = 'public';
  }
  
  // Apply tab filters
  if (tab === 'following' && following.length > 0) {
    query.authorId = { $in: following };
    query.visibility = { $in: ['public', 'followers'] };
  } else if (tab === 'friends' && mutualFollows.length > 0) {
    query.authorId = { $in: mutualFollows };
    query.visibility = { $in: ['public', 'followers'] };
  } else if (tab === 'whatsnew') {
    // What's New: newest first, include campaigns later
    return this.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('authorId', 'email uniqueCode role profile socialLinks');
  }
  // For You: default - mix of popular and recent
  
  // For You: random + popular
  if (tab === 'foryou') {
    // Mix of recent and popular
    const recent = await this.find(query)
      .sort({ createdAt: -1 })
      .limit(Math.floor(limit / 2))
      .populate('authorId', 'email uniqueCode role profile socialLinks');
      
    const popular = await this.find(query)
      .sort({ likeCount: -1, views: -1 })
      .limit(Math.ceil(limit / 2))
      .populate('authorId', 'email uniqueCode role profile socialLinks');
    
    // Combine and remove duplicates
    const combined = [...recent, ...popular];
    const seen = new Set();
    const unique = combined.filter(item => {
      const key = item._id.toString();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    
    // Shuffle
    for (let i = unique.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [unique[i], unique[j]] = [unique[j], unique[i]];
    }
    
    return unique.slice(0, limit);
  }
  
  return this.find(query)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .populate('authorId', 'email uniqueCode role profile socialLinks');
};

/**
 * Get trending posts
 * @param {number} limit - Max posts
 * @returns {Promise<Array>} Trending posts
 */
communityPostSchema.statics.getTrending = async function(limit = 20) {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  
  return this.find({
    isDeleted: false,
    visibility: 'public',
    createdAt: { $gte: weekAgo },
    $or: [
      { likeCount: { $gt: 50 } },
      { views: { $gt: 500 } }
    ]
  })
    .sort({ likeCount: -1, views: -1 })
    .limit(limit)
    .populate('authorId', 'email uniqueCode role profile socialLinks');
};

/**
 * Get posts by author
 * @param {string} authorId - Author ID
 * @param {Object} options - Pagination
 * @returns {Promise<Array>} Posts
 */
communityPostSchema.statics.getByAuthor = async function(authorId, options = {}) {
  const { limit = 20, skip = 0 } = options;
  
  return this.find({
    authorId,
    isDeleted: false
  })
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .populate('authorId', 'email uniqueCode role profile socialLinks');
};

/**
 * Get posts by category
 * @param {string} category - Category
 * @param {Object} options - Pagination
 * @returns {Promise<Array>} Posts
 */
communityPostSchema.statics.getByCategory = async function(category, options = {}) {
  const { limit = 20, skip = 0 } = options;
  
  return this.find({
    category,
    isDeleted: false,
    visibility: 'public'
  })
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .populate('authorId', 'email uniqueCode role profile socialLinks');
};

/**
 * Search posts
 * @param {string} query - Search query
 * @param {Object} options - Pagination
 * @returns {Promise<Array>} Posts
 */
communityPostSchema.statics.searchPosts = async function(query, options = {}) {
  const { limit = 20, skip = 0 } = options;
  
  return this.find(
    { 
      $text: { $search: query },
      isDeleted: false,
      visibility: 'public'
    },
    { score: { $meta: 'textScore' } }
  )
    .sort({ score: { $meta: 'textScore' } })
    .skip(skip)
    .limit(limit)
    .populate('authorId', 'email uniqueCode role profile socialLinks');
};

// ============================================
// Pre-Save Hooks
// ============================================

/**
 * Auto-update updatedAt on save
 */
communityPostSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

/**
 * Ensure likes array has unique values
 */
communityPostSchema.pre('save', function(next) {
  if (this.likes && this.likes.length > 0) {
    const uniqueLikes = [...new Set(this.likes.map(id => id.toString()))];
    this.likes = uniqueLikes.map(id => new mongoose.Types.ObjectId(id));
  }
  this.likeCount = this.likes ? this.likes.length : 0;
  next();
});

// ============================================
// Exports
// ============================================

module.exports = {
  CommunityPost: mongoose.model('CommunityPost', communityPostSchema),
  MEDIA_TYPES,
  POST_CATEGORIES
};
