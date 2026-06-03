const { calculateTip } = require('../middleware/feeService');
const {
  getOrCreateWallet,
  getAdminProfitWallet,
  recordTransaction,
  debitWallet,
  creditWallet,
  runInTransaction,
} = require('./walletService');
const { AppError } = require('../utils/errors');

async function processTip({ fromUser, toCreatorId, grossUsd }) {
  const breakdown = calculateTip(grossUsd);
  const senderWallet = await getOrCreateWallet(fromUser._id);
  const creatorWallet = await getOrCreateWallet(toCreatorId);
  const { admin, wallet: profitWallet } = await getAdminProfitWallet();

  if (senderWallet.balances.available < breakdown.grossUsd) {
    throw new AppError('Insufficient balance to send tip', 400);
  }

  return runInTransaction(async (session) => {
    await debitWallet(senderWallet._id, 'available', breakdown.grossUsd, session);
    await creditWallet(creatorWallet._id, 'tips', breakdown.netToCreatorUsd, session);
    await creditWallet(profitWallet._id, 'available', breakdown.feeUsd, session);

    const tipTx = await recordTransaction(
      {
        type: 'tip',
        status: 'completed',
        fromUserId: fromUser._id,
        toUserId: toCreatorId,
        fromWalletId: senderWallet._id,
        toWalletId: creatorWallet._id,
        grossAmount: breakdown.grossUsd,
        feeAmount: breakdown.feeUsd,
        netAmount: breakdown.netToCreatorUsd,
        feeRate: breakdown.feeRate,
        feeSource: breakdown.feeSource,
        feeRecipient: admin._id,
      },
      session
    );

    await recordTransaction(
      {
        type: 'platform_fee',
        status: 'completed',
        fromUserId: fromUser._id,
        toUserId: admin._id,
        fromWalletId: senderWallet._id,
        toWalletId: profitWallet._id,
        grossAmount: breakdown.feeUsd,
        feeAmount: breakdown.feeUsd,
        netAmount: breakdown.feeUsd,
        feeRate: breakdown.feeRate,
        feeSource: 'tip',
        feeRecipient: admin._id,
      },
      session
    );

    return { tipTx, breakdown };
  });
}

module.exports = { processTip };
