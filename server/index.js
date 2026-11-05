const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const audioRoutes = require('./routes/audio');
const adminRoutes = require('./routes/admin');
const { MAX_UPLOAD_BYTES } = require('./utils/uploadLimits');

const app = express();
const PORT = process.env.PORT || 3000;

// Behind nginx: trust the first proxy hop so req.ip / express-rate-limit key on
// the real client IP (X-Forwarded-For) instead of bucketing every user under
// the proxy's address. Override with TRUST_PROXY if there are more hops.
app.set('trust proxy', process.env.TRUST_PROXY || 1);

// Middleware
app.use(cors());
app.use(express.json({ limit: MAX_UPLOAD_BYTES }));
app.use(express.urlencoded({ extended: true, limit: MAX_UPLOAD_BYTES }));

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

// Player page route.
// The player's scripts and stylesheet are asked for as `?v=<hash of their
// contents>`. Cloudflare tells browsers to keep /js and /styles for hours, so
// without it a deploy meets a new page with the old script (and an embed half
// on each version). The hash changes only when a file does; computed at start,
// which every deploy goes through.
const PLAYER_ASSETS = ['audio-styles.css', 'listen-time.js', 'audio-ad.js', 'audio-player.js'];
function playerPage() {
  const crypto = require('crypto');
  const fs = require('fs');
  const src = path.join(__dirname, '../src');
  const hash = crypto.createHash('sha1');
  for (const f of PLAYER_ASSETS) hash.update(fs.readFileSync(path.join(src, f)));
  const v = hash.digest('hex').slice(0, 10);
  return fs.readFileSync(path.join(src, 'index.html'), 'utf8')
    .replace(/(["'])\/(js|styles)\/([\w.-]+\.(?:js|css))\1/g, `$1/$2/$3?v=${v}$1`);
}
let playerHtml = null;
app.get('/play', (req, res) => {
  try {
    if (!playerHtml) playerHtml = playerPage();
    res.set('Cache-Control', 'no-cache');
    res.type('html').send(playerHtml);
  } catch (error) {
    console.error('Could not version the player page:', error.message);
    res.sendFile(path.join(__dirname, '../src/index.html'));
  }
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
    const repoSizeGB = (Number(stats.repoSize) / (1024 ** 3)).toFixed(2);
    const storageMaxGB = (Number(stats.storageMax) / (1024 ** 3)).toFixed(2);
    const availableGB = ((Number(stats.storageMax) - Number(stats.repoSize)) / (1024 ** 3)).toFixed(2);
    
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

    // MP3 companions for podcast apps: checks every unchecked upload on each
    // start, then again after every upload (see jobs/mp3Worker.js)
    if (process.env.ENABLE_MP3_TRANSCODE !== 'false') {
      try {
        require('./jobs/mp3Worker').start();
      } catch (error) {
        console.error('⚠️  MP3 worker failed to start:', error.message);
      }
    } else {
      console.log('⏸️  MP3 worker disabled (ENABLE_MP3_TRANSCODE=false)');
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
