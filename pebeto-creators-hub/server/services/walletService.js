const { v4: uuidv4 } = require('uuid');
const mongoose = require('mongoose');
const Wallet = require('../models/Wallet');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const { AppError } = require('../utils/errors');
const { roundUsd } = require('../middleware/feeService');

async function getOrCreateWallet(userId, walletType = 'standard') {
  try {
    // Try to find it first
    let wallet = await Wallet.findOne({ userId, walletType });
    
    if (!wallet) {
      // Use create with a try/catch to handle concurrent race conditions
      wallet = await Wallet.create({ 
        userId, 
        walletType, 
        currency: 'USD',
        balances: { available: 0, escrow: 0, tips: 0 } 
      });
    }
    return wallet;
  } catch (err) {
    if (err.code === 11000) {
      // If a duplicate key error happens, someone else just created it.
      // Just find it now.
      return await Wallet.findOne({ userId, walletType });
    }
    throw err;
  }
}

async function getAdminProfitWallet() {
  const admin = await User.findOne({ role: 'admin' });
  if (!admin) throw new AppError('Admin account not configured', 500);

  const wallet = await Wallet.findOneAndUpdate(
    { userId: admin._id, walletType: 'profit' },
    { 
      $setOnInsert: { 
        userId: admin._id, 
        walletType: 'profit', 
        currency: 'USD',
        balances: { available: 0, escrow: 0, tips: 0 }
      } 
    },
    { new: true, upsert: true }
  );
  return { admin, wallet };
}

async function recordTransaction(entry, session = null) {
  const opts = session ? { session } : {};
  return Transaction.create(
    [
      {
        transactionId: uuidv4(),
        ...entry,
      },
    ],
    opts
  ).then((docs) => docs[0]);
}

async function creditWallet(walletId, field, amount, session) {
  const update = { $inc: { [`balances.${field}`]: roundUsd(amount) } };
  return Wallet.findByIdAndUpdate(walletId, update, { new: true, session });
}

async function debitWallet(walletId, field, amount, session) {
  const wallet = await Wallet.findById(walletId).session(session);
  if (!wallet || wallet.balances[field] < amount) {
    throw new AppError('Insufficient balance', 400);
  }
  wallet.balances[field] = roundUsd(wallet.balances[field] - amount);
  await wallet.save({ session });
  return wallet;
}

/** Debit from available first, then tips (USD). */
async function debitWithdrawable(walletId, amount, session) {
  const wallet = await Wallet.findById(walletId).session(session);
  if (!wallet) throw new AppError('Wallet not found', 404);
  const total = wallet.balances.available + wallet.balances.tips;
  if (total < amount) throw new AppError('Insufficient balance', 400);
  let remaining = roundUsd(amount);
  const fromAvailable = Math.min(wallet.balances.available, remaining);
  if (fromAvailable > 0) {
    wallet.balances.available = roundUsd(wallet.balances.available - fromAvailable);
    remaining = roundUsd(remaining - fromAvailable);
  }
  if (remaining > 0) {
    wallet.balances.tips = roundUsd(wallet.balances.tips - remaining);
  }
  await wallet.save({ session });
  return wallet;
}

async function runInTransaction(fn) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const result = await fn(session);
    await session.commitTransaction();
    return result;
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
}
// ... existing code ...

async function processTip(senderId, recipientUsername, amount) {
  return await runInTransaction(async (session) => {
    // 1. Find sender and recipient
    const senderWallet = await getOrCreateWallet(senderId);
    const recipient = await User.findOne({ username: recipientUsername }).session(session);
    
    if (!recipient) throw new AppError('Creator not found', 404);
    if (recipient._id.toString() === senderId.toString()) {
      throw new AppError('You cannot tip yourself', 400);
    }

    const recipientWallet = await getOrCreateWallet(recipient._id);

    // 2. Debit sender using your existing logic
    await debitWithdrawable(senderWallet._id, amount, session);

    // 3. Credit recipient's tips balance
    await creditWallet(recipientWallet._id, 'tips', amount, session);

    // 4. Record transaction history
    await recordTransaction({
      from: senderId,
      to: recipient._id,
      amount,
      type: 'tip',
      status: 'completed'
    }, session);

    // Return only masked info for the receipt
    return {
      username: recipient.username,
      uniqueCode: recipient.uniqueCode 
    };
  });
}

module.exports = {
  getOrCreateWallet,
  getAdminProfitWallet,
  recordTransaction,
  creditWallet,
  debitWallet,
  debitWithdrawable,
  runInTransaction,
  processTip // <--- ADD THIS HERE
};
