const express = require('express');
const rateLimit = require('express-rate-limit');
const audioController = require('../controllers/audioController');
const { validateApiKey } = require('../middleware/auth');
const upload = require('../middleware/upload');

const router = express.Router();

// Rate limiter for play tracking
const playLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000,
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  message: { error: 'Too many requests, please try again later' }
});

// Rate limiter for uploads (stricter)
const uploadLimiter = rateLimit({
  windowMs: 60000, // 1 minute
  max: 10, // 10 uploads per minute
  message: { error: 'Too many upload requests, please try again later' }
});

/**
 * GET /api/audio/feed - Get audio feed with filters
 * Query params:
 *   - limit: Items per page (default 20, max 100)
 *   - offset: Pagination offset (default 0)
 *   - sort: newest|oldest|plays|trending (default newest)
 *   - tag: Filter by tag
 *   - category: Filter by category
 *   - owner: Filter by username
 */
router.get('/feed', audioController.getFeed);

/**
 * GET /api/audio?a=<permlink> - Get audio metadata by permlink
 * GET /api/audio?cid=<cid> - Get audio metadata by CID
 */
router.get('/', audioController.getAudioMetadata);

/**
 * POST /api/audio/play - Increment play count
 * Body: { permlink: "dkojohs" }
 */
router.post('/play', playLimiter, audioController.incrementPlayCount);

/**
 * POST /api/audio/upload - Upload new audio
 * Requires: API key, multipart/form-data with 'audio' file
 */
router.post('/upload', 
  uploadLimiter,
  validateApiKey,
  upload.single('audio'),
  audioController.uploadAudio
);

/**
 * PATCH /api/audio/:permlink/thumbnail - Update thumbnail URL
 * Requires: API key, X-User header
 * Body: { thumbnail_url: "https://..." }
 */
router.patch('/:permlink/thumbnail',
  validateApiKey,
  audioController.updateThumbnail
);

/**
 * PATCH /api/audio/:permlink/post-permlink - Update blockchain post permlink
 * Requires: API key, X-User header
 * Body: { post_permlink: "my-audio-snap-2026" }
 */
router.patch('/:permlink/post-permlink',
  validateApiKey,
  audioController.updatePostPermlink
);

/**
 * GET /api/health/ipfs - IPFS daemon health and storage status
 * Public endpoint for monitoring
 */
router.get('/health/ipfs', async (req, res) => {
  try {
    const { create } = await import('ipfs-http-client');
    const ipfs = create({ url: process.env.IPFS_API_URL || 'http://127.0.0.1:5001' });
    
    // Get daemon info
    const [id, stats, version] = await Promise.all([
      ipfs.id(),
      ipfs.repo.stat(),
      ipfs.version()
    ]);
    
    // Get migration queue size
    const AudioMessage = require('../models/AudioMessage');
    const pending = await AudioMessage.findPendingMigrations(1000);
    
    // Get next migration time
    let nextMigration = null;
    let migrationEnabled = false;
    try {
      const migrationWorker = require('../jobs/migrationWorker');
      nextMigration = migrationWorker.getNextRun();
      migrationEnabled = process.env.ENABLE_MIGRATIONS !== 'false';
    } catch (e) {
      // Migration worker not started
    }
    
    // Calculate storage
    const repoSizeGB = parseFloat((stats.repoSize / (1024 ** 3)).toFixed(2));
    const storageMaxGB = parseFloat((stats.storageMax / (1024 ** 3)).toFixed(2));
    const availableGB = parseFloat(((stats.storageMax - stats.repoSize) / (1024 ** 3)).toFixed(2));
    const usagePercent = parseFloat(((stats.repoSize / stats.storageMax) * 100).toFixed(1));
    
    res.json({
      status: 'healthy',
      ipfs: {
        version: version.version,
        peerId: id.id,
        addresses: id.addresses
      },
      storage: {
        repoSizeGB,
        storageMaxGB,
        availableGB,
        usagePercent,
        numObjects: stats.numObjects
      },
      migration: {
        enabled: migrationEnabled,
        queueSize: pending.length,
        nextRun: nextMigration ? nextMigration.toISOString() : null
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('IPFS health check failed:', error);
    res.status(503).json({ 
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

module.exports = router;
