const mongoose = require('mongoose');

const bidSchema = new mongoose.Schema({
  creatorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  uniqueCode: String,
  amount: { type: Number, required: true },
  proposal: String,
  status: { type: String, enum: ['pending', 'accepted', 'rejected'], default: 'pending' },
  submittedWorkUrl: String,
  submittedAt: Date,
});

const campaignSchema = new mongoose.Schema(
  {
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    title: { type: String, required: true },
    description: String,
    instructions: String,
    budget: { type: Number, required: true },
    fundedAmount: { type: Number, default: 0 },
    status: {
      type: String,
      enum: [
        'draft',
        'open',
        'in_progress',
        'submitted_for_review',
        'completed',
        'paid',
        'disputed',
        'cancelled',
      ],
      default: 'draft',
    },
    bids: [bidSchema],
    assignedCreatorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    escrowHeld: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Campaign', campaignSchema);
