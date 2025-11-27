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

module.exports = router;
