const mongoose = require('mongoose');

const communityCommentSchema = new mongoose.Schema({
  postId: { type: mongoose.Schema.Types.ObjectId, ref: 'CommunityPost', required: true },
  authorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  text: { type: String, required: true, maxlength: 500 },
  likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  likeCount: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

communityCommentSchema.index({ postId: 1, createdAt: -1 });

module.exports = mongoose.model('CommunityComment', communityCommentSchema);
