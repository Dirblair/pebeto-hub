const { AppError } = require('../utils/errors');

function errorHandler(err, _req, res, _next) {
  const statusCode = err.statusCode || 500;
  const message = err.isOperational ? err.message : 'Internal server error';

  // ALWAYS log the error so you can see it in Render logs
  console.error("--- ERROR LOG START ---");
  console.error(err); 
  console.error("--- ERROR LOG END ---");

  res.status(statusCode).json({ success: false, message });
}

module.exports = { errorHandler };
