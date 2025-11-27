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
    const dbName = process.env.MONGODB_DATABASE || 'threespeak';

    client = new MongoClient(uri);
    await client.connect();
    
    db = client.db(dbName);
    return db;
  } catch (error) {
    console.error('❌ MongoDB connection failed:', error);
    throw error;
  }
}

/**
 * ContentCreator Model
 * Manages user accounts and permissions for audio uploads
 */
class ContentCreator {
  /**
   * Find content creator by username
   */
  static async findByUsername(username) {
    try {
      const database = await connectDB();
      const collection = database.collection('contentcreators');
      
      const user = await collection.findOne({ username });
      return user;
    } catch (error) {
      console.error('Error finding content creator:', error);
      throw error;
    }
  }

  /**
   * Create new content creator with default permissions
   */
  static async create(username) {
    try {
      const database = await connectDB();
      const collection = database.collection('contentcreators');
      
      const now = new Date();
      
      const newUser = {
        username,
        banned: false,
        canUpload: true,
        verified: false,
        livestreamEnabled: false,
        canProxyUpvote: false,
        isCitizenJournalist: false,
        limit: 0,
        hidden: false,
        joined: now,
        score: 0,
        postWarning: false,
        askWitnessVote: true,
        badges: [],
        lastPayment: null,
        warningPending: false,
        upvoteEligible: true,
        awaitingVerification: false,
        verificationEvidence: null,
        verificationRequired: false,
        autoFillTitle: false,
        reducedUpvote: false,
        ipfsBeta: true,
        __v: 0
      };
      
      const result = await collection.insertOne(newUser);
      console.log(`✓ Created new content creator: ${username}`);
      
      return { ...newUser, _id: result.insertedId };
    } catch (error) {
      console.error('Error creating content creator:', error);
      throw error;
    }
  }

  /**
   * Check if user can upload (not banned and canUpload is true)
   */
  static async canUserUpload(username) {
    try {
      const user = await this.findByUsername(username);
      
      if (!user) {
        // User doesn't exist, will be created with default permissions
        return { allowed: true, user: null, reason: 'new_user' };
      }
      
      if (user.banned) {
        return { allowed: false, user, reason: 'User is banned from uploading' };
      }
      
      if (user.canUpload === false) {
        return { allowed: false, user, reason: 'User does not have upload permissions' };
      }
      
      return { allowed: true, user, reason: null };
    } catch (error) {
      console.error('Error checking upload permissions:', error);
      throw error;
    }
  }

  /**
   * Update ban status
   */
  static async updateBanStatus(username, banned) {
    try {
      const database = await connectDB();
      const collection = database.collection('contentcreators');
      
      const result = await collection.findOneAndUpdate(
        { username },
        { 
          $set: { 
            banned,
            canUpload: !banned // When banned, disable uploads
          }
        },
        { returnDocument: 'after' }
      );
      
      if (!result) {
        throw new Error('User not found');
      }
      
      console.log(`✓ Updated ban status for ${username}: banned=${banned}`);
      return result;
    } catch (error) {
      console.error('Error updating ban status:', error);
      throw error;
    }
  }

  /**
   * Get all users with pagination and search
   */
  static async getUsers(options = {}) {
    try {
      const database = await connectDB();
      const collection = database.collection('contentcreators');
      
      const {
        page = 1,
        limit = 50,
        search = '',
        banned = null
      } = options;
      
      const query = {};
      
      // Search by username
      if (search) {
        query.username = { $regex: search, $options: 'i' };
      }
      
      // Filter by banned status
      if (banned !== null) {
        query.banned = banned;
      }
      
      const skip = (page - 1) * limit;
      
      const [users, total] = await Promise.all([
        collection
          .find(query)
          .sort({ joined: -1 })
          .skip(skip)
          .limit(limit)
          .toArray(),
        collection.countDocuments(query)
      ]);
      
      return {
        users,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit)
        }
      };
    } catch (error) {
      console.error('Error getting users:', error);
      throw error;
    }
  }

  /**
   * Get user stats (upload count, last upload, etc)
   */
  static async getUserStats(username) {
    try {
      const database = await connectDB();
      const audioCollection = database.collection('embed-audio');
      
      const stats = await audioCollection.aggregate([
        { $match: { owner: username } },
        {
          $group: {
            _id: null,
            totalUploads: { $sum: 1 },
            totalPlays: { $sum: '$plays' },
            lastUpload: { $max: '$createdAt' }
          }
        }
      ]).toArray();
      
      if (stats.length === 0) {
        return {
          totalUploads: 0,
          totalPlays: 0,
          lastUpload: null
        };
      }
      
      return stats[0];
    } catch (error) {
      console.error('Error getting user stats:', error);
      throw error;
    }
  }
}

module.exports = ContentCreator;
