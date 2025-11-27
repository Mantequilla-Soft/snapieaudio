const AudioMessage = require('../models/AudioMessage');
const ContentCreator = require('../models/ContentCreator');

/**
 * Get audio metadata by permlink or CID
 */
exports.getAudioMetadata = async (req, res) => {
  try {
    const { a: permlink, cid } = req.query;

    if (!permlink && !cid) {
      return res.status(400).json({ error: 'Missing permlink or CID parameter' });
    }

    // Direct CID mode (no database lookup)
    if (cid) {
      if (!isValidCID(cid)) {
        return res.status(400).json({ error: 'Invalid CID format' });
      }

      return res.json({
        cid,
        audioUrl: `${process.env.IPFS_PRIMARY_GATEWAY}/ipfs/${cid}`,
        audioUrlFallback: `${process.env.IPFS_FALLBACK_GATEWAY_1}/ipfs/${cid}`,
        format: 'unknown',
        mode: 'direct'
      });
    }

    // Permlink mode (database lookup)
    const audio = await AudioMessage.findByPermlink(permlink);
    
    if (!audio) {
      return res.status(404).json({ error: 'Audio not found' });
    }

    res.json(audio);
  } catch (error) {
    console.error('Error fetching audio metadata:', error);
    res.status(500).json({ error: 'Failed to fetch audio metadata' });
  }
};

/**
 * Increment play count for audio
 */
exports.incrementPlayCount = async (req, res) => {
  try {
    const { permlink } = req.body;

    if (!permlink) {
      return res.status(400).json({ error: 'Missing permlink' });
    }

    const result = await AudioMessage.incrementPlays(permlink);
    
    if (!result) {
      return res.status(404).json({ error: 'Audio not found' });
    }

    res.json({ success: true, plays: result.plays });
  } catch (error) {
    console.error('Error incrementing play count:', error);
    res.status(500).json({ error: 'Failed to increment play count' });
  }
};

/**
 * Upload new audio file
 */
exports.uploadAudio = async (req, res) => {
  try {
    // File should be attached by multer middleware
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file provided' });
    }

    // Require username (no more anonymous uploads)
    const username = req.headers['x-user'] || req.user;
    if (!username || username === 'anonymous') {
      return res.status(400).json({ 
        error: 'Username required',
        message: 'X-User header must be provided for uploads'
      });
    }

    // Check if user exists and has upload permissions
    const uploadCheck = await ContentCreator.canUserUpload(username);
    
    if (!uploadCheck.allowed) {
      return res.status(403).json({ 
        error: 'Upload not allowed',
        message: uploadCheck.reason
      });
    }

    // Create user if doesn't exist
    if (uploadCheck.reason === 'new_user') {
      await ContentCreator.create(username);
      console.log(`✓ Created new user account: ${username}`);
    }

    // Get metadata from request body (trust client initially)
    const {
      duration,
      format,
      codec,
      bitrate,
      sampleRate,
      channels,
      waveform,
      title,
      description,
      tags,
      context_type,
      context_id,
      reply_to
    } = req.body;

    // Validate required fields
    if (!duration || !format) {
      return res.status(400).json({ 
        error: 'Missing required metadata',
        required: ['duration', 'format']
      });
    }

    // Pin to IPFS
    const { create } = await import('ipfs-http-client');
    const ipfs = create({ url: process.env.IPFS_API_URL });
    
    const { cid } = await ipfs.add(req.file.buffer, {
      pin: true,
      progress: (bytes) => console.log(`Upload progress: ${bytes} bytes`)
    });

    const audio_cid = cid.toString();
    console.log(`✓ File pinned to IPFS: ${audio_cid}`);

    // Parse waveform if provided as JSON string
    let waveformData = null;
    if (waveform) {
      try {
        waveformData = typeof waveform === 'string' ? JSON.parse(waveform) : waveform;
      } catch (e) {
        console.warn('Failed to parse waveform data:', e);
      }
    }

    // Parse tags if provided as JSON string
    let tagsArray = [];
    if (tags) {
      try {
        tagsArray = typeof tags === 'string' ? JSON.parse(tags) : tags;
      } catch (e) {
        console.warn('Failed to parse tags:', e);
      }
    }

    // Check if this is a demo upload (never migrate, auto-expire)
    const isDemoUpload = req.headers['x-api-key'] === process.env.DEMO_API_KEY;
    
    // Create audio record in MongoDB
    const audioData = {
      owner: username, // Validated username
      audio_cid,
      ipfs_status: 'pinned_local',
      pinned_nodes: ['local'],
      originalFilename: req.file.originalname,
      format,
      codec: codec || null,
      size: req.file.size,
      duration: parseFloat(duration),
      bitrate: bitrate ? parseInt(bitrate) : null,
      sampleRate: sampleRate ? parseInt(sampleRate) : null,
      channels: channels ? parseInt(channels) : null,
      waveform: waveformData,
      title: title || null,
      description: description || null,
      tags: tagsArray,
      context_type: context_type || 'voice_message',
      context_id: context_id || null,
      reply_to: reply_to || null,
      api_key_used: req.apiKeyId || null,
      // Demo uploads: never migrate, expire after 24 hours
      migration_status: isDemoUpload ? 'skip' : 'pending',
      pin_until: isDemoUpload ? new Date(Date.now() + 24 * 60 * 60 * 1000) : null
    };

    const audio = await AudioMessage.create(audioData);

    console.log(`✓ Audio created: ${audio.permlink}`);

    // Determine protocol - use X-Forwarded-Proto if behind proxy, otherwise force https in production
    const proto = req.get('X-Forwarded-Proto') || (process.env.NODE_ENV === 'production' ? 'https' : req.protocol);
    const host = req.get('host');

    // Return success response
    res.status(201).json({
      success: true,
      permlink: audio.permlink,
      cid: audio_cid,
      playUrl: `${proto}://${host}/play?a=${audio.permlink}`,
      apiUrl: `${proto}://${host}/api/audio?a=${audio.permlink}`
    });
  } catch (error) {
    console.error('Error uploading audio:', error);
    res.status(500).json({ 
      error: 'Failed to upload audio',
      message: error.message 
    });
  }
};

/**
 * Validate IPFS CID format (supports both CIDv0 and CIDv1)
 */
function isValidCID(cid) {
  // CIDv0: Qm + 44 base58 characters
  const isCIDv0 = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(cid);
  // CIDv1: bafy + base32 characters
  const isCIDv1 = /^bafy[a-z0-9]{54,}$/.test(cid);
  return isCIDv0 || isCIDv1;
}
