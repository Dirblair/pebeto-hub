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
  await connectDB(); // Ensure DB is connected before starting server
  
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server);

  // Initialize Sockets
  initSockets(io);
  app.set('io', io);

  // Middleware
  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
  app.use(cors({ origin: env.clientOrigin === '*' ? true : env.clientOrigin, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(attachFeeService);

  // Routes
  app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'pebeto-creators-hub' }));
  app.use('/api/auth', authRoutes);
  app.use('/api/wallet', walletRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/campaigns', campaignRoutes);

  // Static files and Catch-all
  app.use(express.static(path.join(__dirname, '..', 'client')));
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'client', 'index.html'));
  });

  app.use(errorHandler);

  const PORT = process.env.PORT || 10000;
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Pebeto Creator's Hub running on port ${PORT}`);
  });
}

bootstrap().catch((err) => {
  console.error('--- CRITICAL STARTUP ERROR ---');
  console.error(err);
  process.exit(1);
});
