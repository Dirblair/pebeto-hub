const path = require('path');
const http = require('http');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const { Server } = require('socket.io');

// Config and Middleware imports
const env = require('./config/env');
const { connectDB } = require('./config/db');
const { errorHandler } = require('./middleware/errorHandler');
const { attachFeeService } = require('./middleware/feeService');
const { initSockets } = require('./sockets');

// Route imports
const authRoutes = require('./routes/auth.routes');
const walletRoutes = require('./routes/wallet.routes');
const adminRoutes = require('./routes/admin.routes');
const campaignRoutes = require('./routes/campaign.routes');

async function bootstrap() {
    // 1. Database Connection (Critical first step)
    await connectDB();
    console.log("Database connection established.");
    
    const app = express();
    const server = http.createServer(app);
    const io = new Server(server, {
        cors: { origin: env.clientOrigin, credentials: true }
    });

    // 2. Initialize Sockets
    initSockets(io);
    app.set('io', io);

    // 3. Security and Standard Middleware
    app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
    app.use(cors({ origin: env.clientOrigin === '*' ? true : env.clientOrigin, credentials: true }));
    app.use(express.json({ limit: '1mb' }));
    app.use(express.urlencoded({ extended: true }));
    app.use(attachFeeService);

    // 4. Routes
   app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'pebeto-creators-hub' }));
app.use('/api/auth', authRoutes);
    app.use('/api/wallet', walletRoutes.publicRouter); // Public callback
app.use('/api/wallet', walletRoutes);              // Your existing protected routes
    app.use('/api/admin', adminRoutes);
app.use('/api/campaigns', campaignRoutes);

    // 5. Static Files (Client UI)
    app.use(express.static(path.join(__dirname, '..', 'client')));
    app.get('*', (req, res) => {
        res.sendFile(path.join(__dirname, '..', 'client', 'index.html'));
    });

    // 6. Error Handling
    app.use(errorHandler);

    // 7. Start Server
    const PORT = process.env.PORT || 10000;
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`Pebeto Creator's Hub running on port ${PORT}`);
    });
}

// Start the application
bootstrap().catch((err) => {
    console.error('--- CRITICAL STARTUP ERROR ---');
    console.error(err);
    process.exit(1);
});
