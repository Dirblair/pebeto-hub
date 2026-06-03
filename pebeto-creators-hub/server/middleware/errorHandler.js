const { AppError } = require('../utils/errors');

function errorHandler(err, _req, res, _next) {
  const statusCode = err.statusCode || 500;
  const message = err.isOperational ? err.message : 'Internal server error';
  if (process.env.NODE_ENV !== 'production') {
    console.error(err);
  }
  res.status(statusCode).json({ success: false, message });
}

module.exports = { errorHandler };
