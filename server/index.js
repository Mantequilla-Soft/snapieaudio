const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const audioRoutes = require('./routes/audio');
const adminRoutes = require('./routes/admin');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files
app.use('/js', express.static(path.join(__dirname, '../src')));
app.use('/styles', express.static(path.join(__dirname, '../src')));
app.use('/assets', express.static(path.join(__dirname, '../assets')));

// Routes
app.use('/api/audio', audioRoutes);
app.use('/api/admin', adminRoutes);

// Landing page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../src/index-landing.html'));
});

// Demo page
app.get('/demo', (req, res) => {
  res.sendFile(path.join(__dirname, '../src/demo.html'));
});

// Documentation page
app.get('/docs', (req, res) => {
  res.sendFile(path.join(__dirname, '../src/docs.html'));
});

// Admin page
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '../src/admin.html'));
});

// Admin user management page
app.get('/admin/users', (req, res) => {
  res.sendFile(path.join(__dirname, '../src/admin-users.html'));
});

// Player page route
app.get('/play', (req, res) => {
  res.sendFile(path.join(__dirname, '../src/index.html'));
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// IPFS Health Check & Migration Worker Startup
async function startServer() {
  // Start Express server first (always available)
  app.listen(PORT, () => {
    console.log(`🎵 SnapieAudioPlayer server running on http://localhost:${PORT}`);
    console.log(`📺 Player available at: http://localhost:${PORT}/play?a=<permlink>`);
  });
  
  // Then check IPFS health (non-blocking)
  try {
    console.log('🔍 Checking IPFS daemon health...');
    
    // Check local IPFS daemon
    const { create } = await import('ipfs-http-client');
    const ipfs = create({ url: process.env.IPFS_API_URL || 'http://127.0.0.1:5001' });
    
    // Verify daemon is responsive
    const id = await ipfs.id();
    console.log(`✓ IPFS daemon connected: ${id.id}`);
    
    // Check local storage capacity
    const stats = await ipfs.repo.stat();
    const repoSizeGB = (stats.repoSize / (1024 ** 3)).toFixed(2);
    const storageMaxGB = (stats.storageMax / (1024 ** 3)).toFixed(2);
    const availableGB = ((stats.storageMax - stats.repoSize) / (1024 ** 3)).toFixed(2);
    
    console.log(`✓ IPFS repo: ${repoSizeGB}GB / ${storageMaxGB}GB (${availableGB}GB available)`);
    
    // Warn if storage low (but don't exit)
    const minHeadroomGB = 5;
    if (parseFloat(availableGB) < minHeadroomGB) {
      console.warn(`⚠️  WARNING: IPFS storage low (${availableGB}GB < ${minHeadroomGB}GB recommended)`);
      console.warn('   Uploads may fail. Consider increasing StorageMax.');
    }
    
    // Start migration worker in production (non-blocking)
    if (process.env.NODE_ENV === 'production' && process.env.ENABLE_MIGRATIONS !== 'false') {
      try {
        console.log('🔄 Starting migration worker...');
        const migrationWorker = require('./jobs/migrationWorker');
        migrationWorker.start();
      } catch (error) {
        console.error('⚠️  Migration worker failed to start:', error.message);
        console.error('   Server will continue without automatic migrations.');
      }
    } else {
      console.log('⏸️  Migration worker disabled (dev mode or ENABLE_MIGRATIONS=false)');
    }
    
  } catch (error) {
    console.error('⚠️  IPFS health check failed:', error.message);
    
    if (error.code === 'ECONNREFUSED') {
      console.error('   IPFS daemon not running at', process.env.IPFS_API_URL || 'http://127.0.0.1:5001');
      console.error('   Uploads will fail until IPFS is started: systemctl start ipfs');
    }
    
    console.error('⚠️  Server running WITHOUT IPFS - uploads will fail!');
  }
}

// Start server with health checks
startServer();

module.exports = app;
