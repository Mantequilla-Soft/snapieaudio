const AudioMessage = require('../models/AudioMessage');
const ContentCreator = require('../models/ContentCreator');

/**
 * Admin login
 */
exports.login = (req, res) => {
  const { password } = req.body;
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!password || password !== adminPassword) {
    return res.status(401).json({ error: 'Invalid password' });
  }

  // Simple token (in production, use JWT)
  const token = Buffer.from(`admin:${adminPassword}`).toString('base64');
  
  res.json({ success: true, token });
};

/**
 * Get storage statistics
 */
exports.getStats = async (req, res) => {
  try {
    const { MongoClient } = require('mongodb');
    const client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
    
    const db = client.db(process.env.MONGODB_DATABASE);
    const collection = db.collection(process.env.MONGODB_COLLECTION_AUDIO);

    const [totalFiles, demoFiles, pendingMigration, sizeResult] = await Promise.all([
      collection.countDocuments(),
      collection.countDocuments({ migration_status: 'skip' }),
      collection.countDocuments({ migration_status: 'pending' }),
      collection.aggregate([
        { $group: { _id: null, totalSize: { $sum: '$size' } } }
      ]).toArray()
    ]);

    await client.close();

    res.json({
      totalFiles,
      demoFiles,
      pendingMigration,
      totalSize: sizeResult[0]?.totalSize || 0
    });
  } catch (error) {
    console.error('Error getting stats:', error);
    res.status(500).json({ error: 'Failed to get stats' });
  }
};

/**
 * Get files list with optional filter
 */
exports.getFiles = async (req, res) => {
  try {
    const { filter = 'all' } = req.query;
    const { MongoClient } = require('mongodb');
    const client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
    
    const db = client.db(process.env.MONGODB_DATABASE);
    const collection = db.collection(process.env.MONGODB_COLLECTION_AUDIO);

    let query = {};
    if (filter === 'demo') {
      query = { migration_status: 'skip' };
    } else if (filter === 'pending') {
      query = { migration_status: 'pending' };
    } else if (filter === 'skip') {
      query = { migration_status: 'skip' };
    }

    const files = await collection
      .find(query)
      .sort({ createdAt: -1 })
      .limit(100)
      .toArray();

    await client.close();

    res.json(files);
  } catch (error) {
    console.error('Error getting files:', error);
    res.status(500).json({ error: 'Failed to get files' });
  }
};

/**
 * Delete audio file
 */
exports.deleteFile = async (req, res) => {
  try {
    const { permlink } = req.params;
    const { MongoClient } = require('mongodb');
    const client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
    
    const db = client.db(process.env.MONGODB_DATABASE);
    const collection = db.collection(process.env.MONGODB_COLLECTION_AUDIO);

    // Get file info first
    const file = await collection.findOne({ permlink });
    
    if (!file) {
      await client.close();
      return res.status(404).json({ error: 'File not found' });
    }

    // Delete from MongoDB
    await collection.deleteOne({ permlink });

    // TODO: Unpin from IPFS in background job

    await client.close();

    res.json({ success: true, message: 'File deleted' });
  } catch (error) {
    console.error('Error deleting file:', error);
    res.status(500).json({ error: 'Failed to delete file' });
  }
};

/**
 * Get users list with pagination and search
 */
exports.getUsers = async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 50, 
      search = '', 
      banned = null 
    } = req.query;

    const result = await ContentCreator.getUsers({
      page: parseInt(page),
      limit: parseInt(limit),
      search,
      banned: banned === 'true' ? true : banned === 'false' ? false : null
    });

    res.json(result);
  } catch (error) {
    console.error('Error getting users:', error);
    res.status(500).json({ error: 'Failed to get users' });
  }
};

/**
 * Get user details with upload stats
 */
exports.getUserDetails = async (req, res) => {
  try {
    const { username } = req.params;

    const [user, stats] = await Promise.all([
      ContentCreator.findByUsername(username),
      ContentCreator.getUserStats(username)
    ]);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      ...user,
      stats
    });
  } catch (error) {
    console.error('Error getting user details:', error);
    res.status(500).json({ error: 'Failed to get user details' });
  }
};

/**
 * Toggle user ban status
 */
exports.toggleUserBan = async (req, res) => {
  try {
    const { username } = req.params;
    const { banned } = req.body;

    if (typeof banned !== 'boolean') {
      return res.status(400).json({ error: 'banned must be a boolean' });
    }

    const updatedUser = await ContentCreator.updateBanStatus(username, banned);

    res.json({ 
      success: true, 
      message: banned ? 'User banned successfully' : 'User unbanned successfully',
      user: updatedUser
    });
  } catch (error) {
    console.error('Error toggling user ban:', error);
    
    if (error.message === 'User not found') {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.status(500).json({ error: 'Failed to update user' });
  }
};
