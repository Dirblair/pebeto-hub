const { processTip } = require('../services/walletService');

/**
 * Handles the secure tipping process between a fan and a creator.
 * The logic is delegated to walletService to ensure transactional integrity.
 */
const sendTip = async (req, res, next) => {
  try {
    const { recipientUsername, amount } = req.body;

    // Validate request body
    if (!recipientUsername || !amount || amount <= 0) {
      return res.status(400).json({ 
        success: false, 
        message: "Invalid recipient or amount." 
      });
    }

    // Call the service to perform the database transaction
    // We pass req.user._id (the authenticated fan) and the recipient details
    const result = await processTip(req.user._id, recipientUsername, amount);
    
    // Return the masked, safe response to the client
    res.json({ 
        success: true, 
        message: `Sent successfully to ${result.username} (ID: ${result.uniqueCode})` 
    });
  } catch (error) {
    // Passes the error to your centralized errorHandler (e.g., AppError middleware)
    next(error); 
  }
};

module.exports = { 
  sendTip 
};
