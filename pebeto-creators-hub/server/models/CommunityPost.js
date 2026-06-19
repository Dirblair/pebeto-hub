const mongoose = require('mongoose');

const communityCommentSchema = new mongoose.Schema({
  // For comments on posts (optional - either postId OR creatorId)
  postId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'CommunityPost', 
    index: true 
  },
  
  // For comments directly on creators (NEW)
  creatorId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    index: true 
  },
  
  authorId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: true 
  },
  
  text: { 
    type: String, 
    required: true, 
    maxlength: 500 
  },
  
  likes: [{ 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User' 
  }],
  
  likeCount: { 
    type: Number, 
    default: 0 
  },
  
  createdAt: { 
    type: Date, 
    default: Date.now 
  }
});

// Indexes for faster queries
communityCommentSchema.index({ postId: 1, createdAt: -1 });
communityCommentSchema.index({ creatorId: 1, createdAt: -1 });

const CommunityComment = mongoose.model('CommunityComment', communityCommentSchema);

module.exports = CommunityComment;
