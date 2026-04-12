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
      reply_to,
      thumbnail_url,
      category,
      post_permlink
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
    console.log(`✓ File added to IPFS: ${audio_cid}`);

    // Verify pin succeeded (prevents database/IPFS mismatch)
    // Try up to 3 times with 1s delay (handles timing issues)
    let verified = false;
    let lastError = null;
    
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const pins = await ipfs.pin.ls({ paths: [cid] });
        for await (const pin of pins) {
          if (pin.cid.toString() === audio_cid) {
            verified = true;
            break;
          }
        }
        if (verified) {
          console.log(`✓ Pin verified: ${audio_cid} (attempt ${attempt})`);
          break;
        }
      } catch (error) {
        lastError = error;
        console.warn(`Pin verification attempt ${attempt} failed:`, error.message);
      }
      
      // Wait 1s before retrying (unless verified or last attempt)
      if (!verified && attempt < 3) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }
    
    if (!verified) {
      console.error('Pin verification failed after 3 attempts:', lastError);
      throw new Error(`Failed to verify IPFS pin: ${lastError?.message || 'CID not in pin list'}`);
    }

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
      thumbnail_url: thumbnail_url || null,
      post_permlink: post_permlink || null,
      category: category || 'voice_message',
      context_type: context_type || 'voice_message',
      context_id: context_id || null,
      reply_to: reply_to || null,
      api_key_used: req.apiKeyId || null,
      // Migration logic: only migrate valuable content (songs, podcasts, interviews)
      // Voice messages and demo uploads are never migrated
      migration_status: isDemoUpload ? 'skip' : 
        (['song', 'podcast', 'interview'].includes(category) ? 'pending' : 'skip'),
      migration_queued_at: (!isDemoUpload && ['song', 'podcast', 'interview'].includes(category)) 
        ? new Date() : null,
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
    
    // Specific error handling for IPFS issues
    if (error.code === 'ECONNREFUSED') {
      return res.status(503).json({ 
        error: 'IPFS storage unavailable',
        message: 'Storage service is temporarily offline. Please try again later.'
      });
    }
    
    if (error.message && error.message.includes('no space left')) {
      return res.status(507).json({ 
        error: 'Storage full',
        message: 'Storage capacity reached. Please contact support.'
      });
    }
    
    if (error.message && error.message.includes('Pin verification failed')) {
      return res.status(500).json({ 
        error: 'Pin verification failed',
        message: 'File uploaded but could not be verified. Please try again or contact support.'
      });
    }
    
    res.status(500).json({ 
      error: 'Failed to upload audio',
      message: error.message 
    });
  }
};

/**
 * Save waveform peaks for fast future loading (self-healing enrichment).
 * Called by the player after first decode — no auth required.
 */
exports.updateWaveform = async (req, res) => {
  try {
    const { permlink } = req.params;
    const { waveform, duration } = req.body;

    if (!permlink || !waveform || !duration) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (!Array.isArray(waveform) || !waveform.every(Array.isArray)) {
      return res.status(400).json({ error: 'Invalid waveform format' });
    }

    await AudioMessage.updateWaveform(permlink, waveform, parseFloat(duration));

    res.json({ success: true });
  } catch (error) {
    console.error('Error saving waveform:', error);
    res.status(500).json({ error: 'Failed to save waveform' });
  }
};

/**
 * Update thumbnail URL for existing audio
 */
exports.updateThumbnail = async (req, res) => {
  try {
    const { permlink } = req.params;
    const { thumbnail_url } = req.body;
    const username = req.headers['x-user'] || req.user;

    if (!permlink) {
      return res.status(400).json({ error: 'Missing permlink' });
    }

    if (!thumbnail_url) {
      return res.status(400).json({ error: 'thumbnail_url is required' });
    }

    // Validate URL format
    try {
      const url = new URL(thumbnail_url);
      if (!['http:', 'https:'].includes(url.protocol)) {
        return res.status(400).json({ error: 'URL must be http:// or https://' });
      }
    } catch (e) {
      return res.status(400).json({ error: 'Invalid URL format' });
    }

    // Check length
    if (thumbnail_url.length > 2048) {
      return res.status(400).json({ error: 'URL too long (max 2048 characters)' });
    }

    const result = await AudioMessage.updateThumbnail(permlink, username, thumbnail_url);

    if (!result) {
      return res.status(404).json({ error: 'Audio not found or not authorized' });
    }

    res.json({
      success: true,
      permlink: result.permlink,
      thumbnail_url: result.thumbnail_url
    });
  } catch (error) {
    console.error('Error updating thumbnail:', error);
    res.status(500).json({ error: 'Failed to update thumbnail' });
  }
};

/**
 * Update blockchain post permlink for existing audio
 */
exports.updatePostPermlink = async (req, res) => {
  try {
    const { permlink } = req.params;
    const { post_permlink } = req.body;
    const username = req.headers['x-user'] || req.user;

    if (!permlink) {
      return res.status(400).json({ error: 'Missing permlink' });
    }

    if (!post_permlink) {
      return res.status(400).json({ error: 'post_permlink is required' });
    }

    // Validate format (basic permlink validation - alphanumeric, hyphens, underscores)
    if (!/^[a-z0-9-_]+$/i.test(post_permlink)) {
      return res.status(400).json({ error: 'Invalid post_permlink format' });
    }

    // Check length
    if (post_permlink.length > 256) {
      return res.status(400).json({ error: 'post_permlink too long (max 256 characters)' });
    }

    const result = await AudioMessage.updatePostPermlink(permlink, username, post_permlink);

    if (!result) {
      return res.status(404).json({ error: 'Audio not found or not authorized' });
    }

    res.json({
      success: true,
      permlink: result.permlink,
      post_permlink: result.post_permlink
    });
  } catch (error) {
    console.error('Error updating post_permlink:', error);
    res.status(500).json({ error: 'Failed to update post_permlink' });
  }
};

/**
 * Get audio feed with filters, sorting, and pagination
 */
exports.getFeed = async (req, res) => {
  try {
    const {
      limit = '20',
      offset = '0',
      sort = 'newest',
      tag,
      category,
      owner
    } = req.query;

    // Parse and validate pagination
    const limitNum = Math.min(parseInt(limit) || 20, 100); // Max 100 items
    const offsetNum = parseInt(offset) || 0;

    // Validate sort option
    const validSorts = ['newest', 'oldest', 'plays', 'trending'];
    const sortOption = validSorts.includes(sort) ? sort : 'newest';

    // Build query
    const query = { status: 'published' };

    if (category) {
      query.category = category;
    }

    if (owner) {
      query.owner = owner;
    }

    if (tag) {
      query.tags = tag; // MongoDB will match if tag exists in array
    }

    // Build sort criteria
    let sortCriteria = {};
    switch (sortOption) {
      case 'oldest':
        sortCriteria = { createdAt: 1 };
        break;
      case 'plays':
        sortCriteria = { plays: -1, createdAt: -1 };
        break;
      case 'trending':
        // Trending: combination of recent plays and total plays
        // For now, sort by plays descending with recent content boosted
        sortCriteria = { plays: -1, lastPlayed: -1, createdAt: -1 };
        break;
      case 'newest':
      default:
        sortCriteria = { createdAt: -1 };
        break;
    }

    const { MongoClient } = require('mongodb');
    const client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
    
    const db = client.db(process.env.MONGODB_DATABASE);
    const collectionName = process.env.MONGODB_COLLECTION_AUDIO || 'embed-audio';
    const collection = db.collection(collectionName);

    // Get total count for pagination metadata
    const total = await collection.countDocuments(query);

    // Get paginated results
    const results = await collection
      .find(query)
      .sort(sortCriteria)
      .skip(offsetNum)
      .limit(limitNum)
      .toArray();

    await client.close();

    // Transform results to match API response format
    const primaryGateway = process.env.IPFS_PRIMARY_GATEWAY;
    const fallbackGateway = process.env.IPFS_FALLBACK_GATEWAY_1;

    const items = results.map(audio => ({
      permlink: audio.permlink,
      owner: audio.owner,
      audio_cid: audio.audio_cid,
      category: audio.category || 'voice_message',
      duration: audio.duration,
      format: audio.format,
      title: audio.title,
      description: audio.description,
      tags: audio.tags || [],
      thumbnail_url: audio.thumbnail_url || null,
      post_permlink: audio.post_permlink || null,
      plays: audio.plays || 0,
      likes: audio.likes || 0,
      createdAt: audio.createdAt,
      audioUrl: `${primaryGateway}/ipfs/${audio.audio_cid}`,
      audioUrlFallback: `${fallbackGateway}/ipfs/${audio.audio_cid}`
    }));

    // Return paginated response
    res.json({
      items,
      pagination: {
        limit: limitNum,
        offset: offsetNum,
        total,
        hasMore: offsetNum + limitNum < total
      },
      filters: {
        sort: sortOption,
        category: category || null,
        tag: tag || null,
        owner: owner || null
      }
    });

  } catch (error) {
    console.error('Error getting feed:', error);
    res.status(500).json({ error: 'Failed to get feed' });
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
