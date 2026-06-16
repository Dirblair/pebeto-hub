/**
 * Wallet Controller for Pebeto Creator's Hub
 * 
 * Handles wallet operations including tips
 * 
 * @module controllers/walletController
 */

const { processTip } = require('../services/tipService');
const { AppError } = require('../utils/errors');
const User = require('../models/User');

/**
 * Send a tip from a fan to a creator
 */
const sendTip = async (req, res, next) => {
  try {
    const { recipientUsername, recipientUniqueCode, creatorId, amount, idempotencyKey } = req.body;

    let recipient = null;

    // Find recipient by ID, unique code, or username
    if (creatorId) {
      recipient = await User.findById(creatorId);
    } else if (recipientUniqueCode) {
      recipient = await User.findOne({ uniqueCode: recipientUniqueCode });
    } else if (recipientUsername) {
      recipient = await User.findOne({ 
        $or: [
          { 'profile.stageName': recipientUsername },
          { 'profile.companyName': recipientUsername }
        ]
      });
    }

    if (!recipient) {
      throw new AppError('Recipient not found', 404);
    }

    if (recipient.role !== 'creator') {
      throw new AppError('Recipient must be a creator', 400);
    }

    // Prevent self-tipping
    if (req.user._id.toString() === recipient._id.toString()) {
      throw new AppError('You cannot tip yourself', 400);
    }

    const result = await processTip({
      fromUser: req.user,
      toCreatorId: recipient._id,
      grossUsd: amount,
      idempotencyKey
    });
    
    res.json({
      success: true,
      message: `Successfully tipped ${recipient.uniqueCode || recipient.profile?.stageName || recipient.email}`,
      data: {
        amount: result.breakdown.netToCreatorUsd,
        fee: result.breakdown.feeUsd,
        transactionId: result.tipTx._id
      }
    });
  } catch (error) {
    next(error);
  }
};

module.exports = { 
  sendTip
};
