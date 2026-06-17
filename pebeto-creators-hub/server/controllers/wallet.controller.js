/**
 * Wallet Controller for Pebeto Creator's Hub
 * 
 * Handles wallet operations including tips
 * 
 * @module controllers/walletController
 */

const { processTip } = require('../services/tipService');
const { AppError } = require('../utils/errors');

/**
 * Send a tip from a fan to a creator
 */
const sendTip = async (req, res, next) => {
  try {
    const { recipientUsername, recipientUniqueCode, amount, idempotencyKey } = req.body;

    if ((!recipientUsername && !recipientUniqueCode) || !amount || amount <= 0) {
      throw new AppError('Invalid recipient or amount.', 400);
    }

    // Find recipient by unique code or username
    const recipient = await User.findOne({
      $or: [
        { uniqueCode: recipientUniqueCode },
        { username: recipientUsername }
      ]
    });

    if (!recipient) {
      throw new AppError('Recipient not found', 404);
    }

    const result = await processTip({
      fromUser: req.user,
      toCreatorId: recipient._id,
      grossUsd: amount,
      idempotencyKey
    });
    
    res.json({
      success: true,
      message: `Successfully tipped ${recipient.uniqueCode || recipient.username}`,
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
