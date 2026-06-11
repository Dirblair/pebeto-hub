const mongoose = require('mongoose');

const communityPostSchema = new mongoose.Schema({
  authorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  mediaUrl: { type: String, required: true },
  mediaType: { type: String, enum: ['image', 'video'], default: 'video' },
  thumbnailUrl: { type: String },
  caption: { type: String, maxlength: 500 },
  sound: { type: String, default: 'Original Sound' },
  likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  likeCount: { type: Number, default: 0 },
  commentCount: { type: Number, default: 0 },
  isLive: { type: Boolean, default: false },
  isTrending: { type: Boolean, default: false },
  views: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

communityPostSchema.index({ createdAt: -1 });
communityPostSchema.index({ authorId: 1, createdAt: -1 });
communityPostSchema.index({ isTrending: 1, likeCount: -1 });

module.exports = mongoose.model('CommunityPost', communityPostSchema);
