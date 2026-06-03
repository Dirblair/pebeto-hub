const mongoose = require('mongoose');

const payoutDetailsSchema = new mongoose.Schema(
  {
    phoneNumber: String,
    accountName: String,
    paypalEmail: String,
    bankName: String,
    accountNumber: String,
    swiftCode: String,
    accountHolderName: String,
    iban: String,
    country: String,
  },
  { _id: false }
);

const payoutProfileSchema = new mongoose.Schema({
  method: { type: String, enum: ['mpesa', 'paypal', 'swift'], required: true },
  label: String,
  isDefault: { type: Boolean, default: false },
  details: payoutDetailsSchema,
  createdAt: { type: Date, default: Date.now },
});

const userSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ['admin', 'business', 'creator'], required: true },
    preferredLanguage: { type: String, default: 'en' },
    preferredCurrency: { type: String, default: 'USD' },
    uniqueCode: { type: String, unique: true, sparse: true },
    status: { type: String, enum: ['active', 'suspended', 'pending'], default: 'active' },
    profile: {
      refereeName: { type: String, trim: true },
      displayName: String,
      stageName: String,
      bio: String,
      avatarUrl: String,
      niche: String,
      tags: [String],
      companyName: String,
      website: String,
    },
    payoutProfiles: [payoutProfileSchema],
    social: {
      followerCount: { type: Number, default: 0 },
      followingCount: { type: Number, default: 0 },
      engagementRate: { type: Number, default: 0 },
    },
    publicKey: String,
  },
  { timestamps: true }
);

userSchema.index({ 'profile.niche': 1 });
userSchema.index({ 'profile.companyName': 1 });

module.exports = mongoose.model('User', userSchema);
