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
function getStkPassword() {
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const password = Buffer.from(`${env.mpesaShortCode}${env.mpesaPasskey}${timestamp}`).toString('base64');
  return { timestamp, password };
}

async function initiateSTKPush(amount, phone, orderId) {
  const token = await getMpesaAccessToken();
  const { timestamp, password } = getStkPassword();

  const payload = {
    BusinessShortCode: env.mpesaShortCode,
    Password: password,
    Timestamp: timestamp,
    TransactionType: 'CustomerPayBillOnline',
    Amount: amount,
    PartyA: phone, // The user's phone number
    PartyB: env.mpesaShortCode,
    PhoneNumber: phone,
    CallBackURL: env.mpesaCallbackUrl, // MUST be a publicly accessible URL
    AccountReference: orderId,
    TransactionDesc: 'Pebeto Payment'
  };

  const response = await axios.post(
    `${env.mpesaApiUrl}/mpesa/stkpush/v1/processrequest`,
    payload,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  return response.data;
}

module.exports = { sendMpesaB2C, initiateSTKPush };
