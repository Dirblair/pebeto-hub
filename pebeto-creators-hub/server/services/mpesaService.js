const axios = require('axios');
const env = require('../config/env');

async function sendMpesaB2C(phoneNumber, amount) {
  // 1. Get Access Token (simplified logic)
  const token = await getMpesaAccessToken();

  // 2. Prepare Payload for B2C (Business to Customer)
  const payload = {
    InitiatorName: env.mpesaInitiatorName,
    SecurityCredential: env.mpesaPassword,
    CommandID: 'SalaryPayment', // Common for B2C
    Amount: amount,
    PartyA: env.mpesaShortCode,
    PartyB: phoneNumber,
    Remarks: 'Withdrawal',
    QueueTimeOutURL: env.mpesaQueueTimeoutUrl,
    ResultURL: env.mpesaResultUrl,
  };

  // 3. Post to Daraja API
  const response = await axios.post(`${env.mpesaApiUrl}/mpesa/b2c/v1/paymentrequest`, payload, {
    headers: { Authorization: `Bearer ${token}` }
  });

  return { success: true, reference: response.data.ConversationID };
}

module.exports = { sendMpesaB2C };
