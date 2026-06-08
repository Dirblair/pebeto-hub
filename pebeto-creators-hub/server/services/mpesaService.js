const axios = require('axios');
const env = require('../config/env');

async function getMpesaAccessToken() {
  const auth = Buffer.from(`${env.mpesaConsumerKey}:${env.mpesaConsumerSecret}`).toString('base64');
  const response = await axios.get(`${env.mpesaApiUrl}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` }
  });
  return response.data.access_token;
}

async function sendMpesaB2C(phoneNumber, amount) {
  const token = await getMpesaAccessToken();

  const payload = {
    InitiatorName: env.mpesaInitiatorName,
    SecurityCredential: env.mpesaPassword,
    CommandID: 'SalaryPayment',
    Amount: amount,
    PartyA: env.mpesaShortCode,
    PartyB: phoneNumber,
    Remarks: 'Withdrawal',
    QueueTimeOutURL: env.mpesaQueueTimeoutUrl,
    ResultURL: env.mpesaResultUrl,
  };

  const response = await axios.post(`${env.mpesaApiUrl}/mpesa/b2c/v1/paymentrequest`, payload, {
    headers: { Authorization: `Bearer ${token}` }
  });

  return { success: true, reference: response.data.ConversationID };
}

module.exports = { sendMpesaB2C };
