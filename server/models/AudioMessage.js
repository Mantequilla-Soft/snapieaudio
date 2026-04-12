const { MongoClient } = require('mongodb');

let db = null;
let client = null;

/**
 * Connect to MongoDB
 */
async function connectDB() {
  if (db) return db;

  try {
    const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017';
    const dbName = process.env.MONGODB_DATABASE || 'snapieaudio';

    client = new MongoClient(uri);
    await client.connect();
    
    db = client.db(dbName);
    console.log(`✅ Connected to MongoDB: ${dbName}`);

    // Create indexes
    await createIndexes();

    return db;
  } catch (error) {
    console.error('❌ MongoDB connection failed:', error);
    throw error;
  }
}

/**
 * Get collection name from env or default
 */
function getCollectionName() {
  return process.env.MONGODB_COLLECTION_AUDIO || 'embed-audio';
}

/**
 * Create database indexes
 */
async function createIndexes() {
  const collection = db.collection(getCollectionName());
  
  // Unique permlink
  await collection.createIndex({ permlink: 1 }, { unique: true });
  
  // User's audio sorted by date
  await collection.createIndex({ owner: 1, createdAt: -1 });
  
  // Find by CID (for deduplication checks)
  await collection.createIndex({ audio_cid: 1 });
  
  // Recent audio feed
  await collection.createIndex({ createdAt: -1 });
  
  // Migration queue (find pending migrations)
  await collection.createIndex({ 
    migration_status: 1, 
    migration_queued_at: 1 
  });
  
  // IPFS status tracking
  await collection.createIndex({ ipfs_status: 1 });
  
  // API key usage tracking
  await collection.createIndex({ api_key_used: 1, createdAt: -1 });
  
  console.log('✅ Database indexes created for', getCollectionName());
}

/**
 * AudioMessage Model
 */
class AudioMessage {
  /**
   * Find audio by permlink
   */
  static async findByPermlink(permlink) {
    try {
      const database = await connectDB();
      const collection = database.collection(getCollectionName());
      
      const audio = await collection.findOne({ 
        permlink, 
        status: 'published' // Changed from 'active' to match video schema
      });
      
      if (!audio) return null;

      // Determine gateway priority based on IPFS status and migration
      // ipfs-audio.3speak.tv = local VPS gateway
      // ipfs.3speak.tv = supernode (backup/migration target)
      const localGateway = process.env.IPFS_PRIMARY_GATEWAY; // ipfs-audio.3speak.tv
      const supernodeGateway = process.env.IPFS_SUPERNODE_URL || 'https://ipfs.3speak.tv';
      const fallbackGateway1 = process.env.IPFS_FALLBACK_GATEWAY_1; // ipfs.io
      const fallbackGateway2 = process.env.IPFS_FALLBACK_GATEWAY_2; // dweb.link
      
      let primaryUrl, fallbackUrl;
      
      if (audio.ipfs_status === 'pinned_distributed' || audio.migration_status === 'migrated') {
        // Migrated content: prioritize supernode (most reliable, backed up)
        primaryUrl = `${supernodeGateway}/ipfs/${audio.audio_cid}`;
        fallbackUrl = `${localGateway}/ipfs/${audio.audio_cid}`;
      } else if (audio.ipfs_status === 'pinned_local') {
        // Local-only content: use local VPS gateway
        // For valuable content awaiting migration, supernode is backup in case migration completed
        // For voice messages, they're only on local node
        const isValuableContent = ['song', 'podcast', 'interview'].includes(audio.category);
        primaryUrl = `${localGateway}/ipfs/${audio.audio_cid}`;
        fallbackUrl = isValuableContent ? `${supernodeGateway}/ipfs/${audio.audio_cid}` : `${fallbackGateway1}/ipfs/${audio.audio_cid}`;
      } else {
        // Unknown status: try supernode first, then local, then public
        primaryUrl = `${supernodeGateway}/ipfs/${audio.audio_cid}`;
        fallbackUrl = `${fallbackGateway1}/ipfs/${audio.audio_cid}`;
      }

      // Return normalized response
      return {
        permlink: audio.permlink,
        owner: audio.owner, // Changed from 'author' to match schema
        audio_cid: audio.audio_cid,
        category: audio.category || 'voice_message',
        duration: audio.duration,
        format: audio.format,
        bitrate: audio.bitrate,
        sampleRate: audio.sampleRate,
        channels: audio.channels,
        waveform: audio.waveform,
        audioUrl: primaryUrl,
        audioUrlFallback: fallbackUrl,
        ipfs_status: audio.ipfs_status,
        title: audio.title,
        description: audio.description,
        tags: audio.tags || [],
        post_permlink: audio.post_permlink || null,
        plays: audio.plays || 0,
        likes: audio.likes || 0,
        createdAt: audio.createdAt,
        context_type: audio.context_type,
        context_id: audio.context_id,
        thumbnail_url: audio.thumbnail_url || null,
        ipfs_status: audio.ipfs_status
      };
    } catch (error) {
      console.error('Error finding audio:', error);
      throw error;
    }
  }

  /**
   * Increment play count
   */
  static async incrementPlays(permlink) {
    try {
      const database = await connectDB();
      const collection = database.collection(getCollectionName());
      
      console.log(`[incrementPlays] Looking for permlink: ${permlink}`);
      
      const result = await collection.findOneAndUpdate(
        { permlink, status: 'published' },
        { 
          $inc: { plays: 1 },
          $set: { lastPlayed: new Date() }
        },
        { returnDocument: 'after' }
      );
      
      console.log(`[incrementPlays] Result:`, result);
      
      return result;
    } catch (error) {
      console.error('Error incrementing plays:', error);
      throw error;
    }
  }

  /**
   * Create new audio message
   */
  static async create(audioData) {
    try {
      const database = await connectDB();
      const collection = database.collection(getCollectionName());
      
      const now = new Date();
      
      const document = {
        // Identity & Ownership
        owner: audioData.owner,
        permlink: audioData.permlink || AudioMessage.generatePermlink(),
        frontend_app: audioData.frontend_app || 'snapie',
        
        // Content Classification
        category: audioData.category || 'voice_message',
        
        // IPFS Storage
        audio_cid: audioData.audio_cid,
        ipfs_status: audioData.ipfs_status || 'pinned_local',
        pinned_nodes: audioData.pinned_nodes || ['local'],
        
        // File Info (trust client initially)
        originalFilename: audioData.originalFilename,
        format: audioData.format,
        codec: audioData.codec || null,
        size: audioData.size,
        duration: audioData.duration,
        bitrate: audioData.bitrate || null,
        sampleRate: audioData.sampleRate || null,
        channels: audioData.channels || null,
        
        // Waveform
        waveform: audioData.waveform || null,
        
        // Metadata
        title: audioData.title || null,
        description: audioData.description || null,
        tags: audioData.tags || [],
        thumbnail_url: audioData.thumbnail_url || null,
        post_permlink: audioData.post_permlink || null,  // Blockchain post reference
        
        // Context
        context_type: audioData.context_type || 'voice_message',
        context_id: audioData.context_id || null,
        reply_to: audioData.reply_to || null,
        
        // Status & Visibility
        status: 'published',
        visibility: audioData.visibility || 'public',
        
        // Engagement
        plays: 0,
        likes: 0,
        
        // Timestamps
        createdAt: now,
        updatedAt: now,
        lastPlayed: null,
        
        // Migration tracking
        migration_status: 'pending',
        migration_queued_at: new Date(now.getTime() + 24 * 60 * 60 * 1000), // Queue for 24h from now
        migration_completed_at: null,
        
        // API Key tracking
        api_key_used: audioData.api_key_used || null,
        
        // Storage management
        last_gc_check: null,
        pin_until: null
      };
      
      const result = await collection.insertOne(document);
      return { ...document, _id: result.insertedId };
    } catch (error) {
      console.error('Error creating audio:', error);
      throw error;
    }
  }

  /**
   * Store waveform peaks for fast loading.
   * Only writes if waveform is not already stored (safe to call multiple times).
   */
  static async updateWaveform(permlink, waveform, duration) {
    try {
      const database = await connectDB();
      const collection = database.collection(getCollectionName());

      await collection.updateOne(
        { permlink, status: 'published', waveform: null },
        {
          $set: {
            waveform,
            duration,
            updatedAt: new Date()
          }
        }
      );
    } catch (error) {
      console.error('Error saving waveform:', error);
      throw error;
    }
  }

  /**
   * Update thumbnail URL for audio
   */
  static async updateThumbnail(permlink, username, thumbnail_url) {
    try {
      const database = await connectDB();
      const collection = database.collection(getCollectionName());

      // Only owner can update thumbnail
      const result = await collection.findOneAndUpdate(
        { permlink, owner: username, status: 'published' },
        { 
          $set: { 
            thumbnail_url,
            updatedAt: new Date()
          }
        },
        { returnDocument: 'after' }
      );

      // Return the updated document (null if not found/authorized)
      return result;
    } catch (error) {
      console.error('Error updating thumbnail:', error);
      throw error;
    }
  }

  /**
   * Update blockchain post permlink for audio
   */
  static async updatePostPermlink(permlink, username, post_permlink) {
    try {
      const database = await connectDB();
      const collection = database.collection(getCollectionName());

      // Only owner can update post_permlink
      const result = await collection.findOneAndUpdate(
        { permlink, owner: username, status: 'published' },
        { 
          $set: { 
            post_permlink,
            updatedAt: new Date()
          }
        },
        { returnDocument: 'after' }
      );

      // Return the updated document (null if not found/authorized)
      return result;
    } catch (error) {
      console.error('Error updating post_permlink:', error);
      throw error;
    }
  }

  /**
   * Find files pending migration (only valuable content: songs, podcasts, interviews)
   */
  static async findPendingMigrations(limit = 50) {
    try {
      const database = await connectDB();
      const collection = database.collection(getCollectionName());

      const now = new Date();

      return await collection.find({
        migration_status: 'pending',
        migration_queued_at: { $lte: now },
        status: 'published',
        category: { $in: ['song', 'podcast', 'interview'] }
      })
        .sort({ migration_queued_at: 1 })
        .limit(limit)
        .toArray();
    } catch (error) {
      console.error('Error finding pending migrations:', error);
      throw error;
    }
  }

  /**
   * Mark file as successfully migrated to supernode
   */
  static async markMigrated(permlink, nodes) {
    try {
      const database = await connectDB();
      const collection = database.collection(getCollectionName());

      await collection.updateOne(
        { permlink },
        {
          $set: {
            migration_status: 'migrated',
            migration_completed_at: new Date(),
            ipfs_status: 'pinned_distributed',
            pinned_nodes: nodes,
            migration_retries: 0,
            migration_last_error: null,
            updatedAt: new Date()
          }
        }
      );
    } catch (error) {
      console.error('Error marking migrated:', error);
      throw error;
    }
  }

  /**
   * Mark file as failed to migrate (with retry logic)
   */
  static async markMigrationFailed(permlink, errorMessage, permanent = false) {
    try {
      const database = await connectDB();
      const collection = database.collection(getCollectionName());

      const update = {
        $set: {
          migration_status: permanent ? 'failed' : 'pending',
          migration_last_error: errorMessage,
          migration_queued_at: new Date(
            Date.now() + (24 * 60 * 60 * 1000) // Retry in 24 hours
          ),
          updatedAt: new Date()
        },
        $inc: { migration_retries: 1 }
      };

      await collection.updateOne({ permlink }, update);
    } catch (error) {
      console.error('Error marking migration failed:', error);
      throw error;
    }
  }

  /**
   * Get migration statistics for admin dashboard
   */
  static async getMigrationStats() {
    try {
      const database = await connectDB();
      const collection = database.collection(getCollectionName());

      const stats = await collection.aggregate([
        {
          $group: {
            _id: {
              status: '$migration_status',
              category: '$category'
            },
            count: { $sum: 1 }
          }
        }
      ]).toArray();

      // Format results
      const result = {
        total: 0,
        pending: 0,
        migrated: 0,
        failed: 0,
        skipped: 0,
        byCategory: {}
      };

      stats.forEach(stat => {
        const status = stat._id.status || 'unknown';
        const category = stat._id.category || 'unknown';
        const count = stat.count;

        result.total += count;
        result[status] = (result[status] || 0) + count;

        if (!result.byCategory[category]) {
          result.byCategory[category] = {};
        }
        result.byCategory[category][status] = count;
      });

      return result;
    } catch (error) {
      console.error('Error getting migration stats:', error);
      throw error;
    }
  }

  /**
   * Get single audio by permlink (for manual migration)
   */
  static async getByPermlink(permlink) {
    try {
      const database = await connectDB();
      const collection = database.collection(getCollectionName());

      return await collection.findOne({ 
        permlink,
        status: 'published'
      });
    } catch (error) {
      console.error('Error getting audio by permlink:', error);
      throw error;
    }
  }

  /**
   * Retry a failed migration (resets retries and queues immediately)
   */
  static async retryMigration(permlink) {
    try {
      const database = await connectDB();
      const collection = database.collection(getCollectionName());

      await collection.updateOne(
        { permlink },
        {
          $set: {
            migration_status: 'pending',
            migration_queued_at: new Date(), // Queue immediately
            migration_retries: 0,
            migration_last_error: null,
            updatedAt: new Date()
          }
        }
      );
    } catch (error) {
      console.error('Error retrying migration:', error);
      throw error;
    }
  }

  /**
   * Generate unique permlink
   */
  static generatePermlink() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let permlink = '';
    
    for (let i = 0; i < 8; i++) {
      permlink += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    
    return permlink;
  }
}

module.exports = AudioMessage;
