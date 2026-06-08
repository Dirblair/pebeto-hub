const path = require('path');
const http = require('http');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const { Server } = require('socket.io');

const env = require('./config/env');
const { connectDB } = require('./config/db');
const { errorHandler } = require('./middleware/errorHandler');
const { attachFeeService } = require('./middleware/feeService');
const { initSockets } = require('./sockets');

const authRoutes = require('./routes/auth.routes');
const walletRoutes = require('./routes/wallet.routes');
const adminRoutes = require('./routes/admin.routes');
const campaignRoutes = require('./routes/campaign.routes');

async function bootstrap() {
  console.log("DEBUG: Starting minimal bootstrap...");

  const app = express();
  const server = http.createServer(app);

  app.get('/api/health', (req, res) => {
    res.json({ status: "alive" });
  });

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Minimal server running on port ${PORT}`);
  });
}
  initSockets(io);
  app.set('io', io);

  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
    })
  );
  app.use(
    cors({
      origin: env.clientOrigin === '*' ? true : env.clientOrigin,
      credentials: true,
    })
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.use(attachFeeService);

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'pebeto-creators-hub' });
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/wallet', walletRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/campaigns', campaignRoutes);

  app.use(express.static(path.join(__dirname, '..', 'client')));

  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    const file = path.join(__dirname, '..', 'client', 'index.html');
    res.sendFile(file, (err) => {
      if (err) res.status(404).json({ message: 'Not found' });
    });
  });

  app.use((req, res) => {
    res.status(404).json({ success: false, message: 'Route not found' });
  });

  app.use(errorHandler);

  // --- REPLACE THE SECTION BELOW ---
  const rawPort = process.env.PORT;
  const PORT = (rawPort && Number(rawPort) > 1024) ? Number(rawPort) : 10000;

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Pebeto Creator's Hub running on port ${PORT}`);
  });
  // --- END OF REPLACEMENT ---
}

// This call is now correctly outside the function
bootstrap().catch((err) => {
  console.error('--- CRITICAL STARTUP ERROR ---');
  console.error(err.message);
  console.error(err.stack); // This will tell us the exact line number that crashed
  process.exit(1);
});
