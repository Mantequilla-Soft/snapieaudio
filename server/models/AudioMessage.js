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

      // Determine gateway priority based on IPFS status
      const localGateway = process.env.IPFS_LOCAL_GATEWAY;
      const publicGateway = process.env.IPFS_PRIMARY_GATEWAY;
      const fallbackGateway = process.env.IPFS_FALLBACK_GATEWAY_1;
      
      let primaryUrl, fallbackUrl;
      
      if (audio.ipfs_status === 'pinned_local' && localGateway) {
        // Try local gateway first for recently pinned files
        primaryUrl = `${localGateway}/ipfs/${audio.audio_cid}`;
        fallbackUrl = `${publicGateway}/ipfs/${audio.audio_cid}`;
      } else {
        // Use public gateways for migrated content
        primaryUrl = `${publicGateway}/ipfs/${audio.audio_cid}`;
        fallbackUrl = `${fallbackGateway}/ipfs/${audio.audio_cid}`;
      }

      // Return normalized response
      return {
        permlink: audio.permlink,
        owner: audio.owner, // Changed from 'author' to match schema
        audio_cid: audio.audio_cid,
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
        plays: audio.plays || 0,
        likes: audio.likes || 0,
        createdAt: audio.createdAt,
        context_type: audio.context_type,
        context_id: audio.context_id
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
