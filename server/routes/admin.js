const express = require('express');
const adminController = require('../controllers/adminController');

const router = express.Router();

/**
 * Admin authentication middleware
 */
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = authHeader.substring(7);
  const adminPassword = process.env.ADMIN_PASSWORD;
  const expectedToken = Buffer.from(`admin:${adminPassword}`).toString('base64');

  if (token !== expectedToken) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  next();
}

/**
 * POST /api/admin/login - Admin login
 */
router.post('/login', adminController.login);

/**
 * GET /api/admin/stats - Get storage statistics
 */
router.get('/stats', requireAuth, adminController.getStats);

/**
 * GET /api/admin/files - Get files list
 */
router.get('/files', requireAuth, adminController.getFiles);

/**
 * GET /api/admin/category-stats - Get breakdown by category
 */
router.get('/category-stats', requireAuth, adminController.getCategoryStats);

/**
 * DELETE /api/admin/files/:permlink - Delete audio file
 */
router.delete('/files/:permlink', requireAuth, adminController.deleteFile);

/**
 * GET /api/admin/users - Get users list with pagination and search
 */
router.get('/users', requireAuth, adminController.getUsers);

/**
 * GET /api/admin/users/:username - Get user details with stats
 */
router.get('/users/:username', requireAuth, adminController.getUserDetails);

/**
 * PUT /api/admin/users/:username/ban - Toggle user ban status
 */
router.put('/users/:username/ban', requireAuth, adminController.toggleUserBan);

/**
 * Migration Management Endpoints
 */

/**
 * GET /api/admin/migrations/stats - Get migration statistics
 */
router.get('/migrations/stats', requireAuth, async (req, res) => {
  try {
    const AudioMessage = require('../models/AudioMessage');
    const stats = await AudioMessage.getMigrationStats();
    res.json(stats);
  } catch (error) {
    console.error('Error getting migration stats:', error);
    res.status(500).json({ error: 'Failed to get migration stats' });
  }
});

/**
 * GET /api/admin/migrations/pending - List pending migrations
 */
router.get('/migrations/pending', requireAuth, async (req, res) => {
  try {
    const AudioMessage = require('../models/AudioMessage');
    const limit = parseInt(req.query.limit) || 100;
    const pending = await AudioMessage.findPendingMigrations(limit);
    res.json(pending);
  } catch (error) {
    console.error('Error getting pending migrations:', error);
    res.status(500).json({ error: 'Failed to get pending migrations' });
  }
});

/**
 * GET /api/admin/migrations/schedule - Get next scheduled run time
 */
router.get('/migrations/schedule', requireAuth, async (req, res) => {
  try {
    const migrationWorker = require('../jobs/migrationWorker');
    const nextRun = migrationWorker.getNextRun();
    const isRunning = migrationWorker.isJobRunning();
    
    if (!nextRun) {
      return res.json({ 
        enabled: false,
        message: 'Migration worker not started'
      });
    }
    
    const now = new Date();
    const msUntilRun = nextRun.getTime() - now.getTime();
    
    res.json({
      enabled: true,
      nextRun: nextRun.toISOString(),
      msUntilRun,
      isRunning,
      scheduledHour: migrationWorker.scheduleHour || 2
    });
  } catch (error) {
    console.error('Error getting migration schedule:', error);
    res.status(500).json({ error: 'Failed to get schedule' });
  }
});

/**
 * POST /api/admin/migrations/trigger - Manually trigger migration job
 */
router.post('/migrations/trigger', requireAuth, async (req, res) => {
  try {
    const migrationWorker = require('../jobs/migrationWorker');
    
    // Run migration job immediately (doesn't wait for 2am)
    console.log('[Admin] Manual migration trigger requested');
    const result = await migrationWorker.processQueue();
    
    res.json({ 
      success: true, 
      message: 'Migration job completed',
      stats: result
    });
  } catch (error) {
    console.error('Error triggering migration:', error);
    res.status(500).json({ 
      error: 'Failed to trigger migration',
      message: error.message
    });
  }
});

/**
 * POST /api/admin/migrations/:permlink - Manually migrate specific file
 */
router.post('/migrations/:permlink', requireAuth, async (req, res) => {
  try {
    const { permlink } = req.params;
    const migrationWorker = require('../jobs/migrationWorker');
    
    console.log(`[Admin] Manual migration requested for: ${permlink}`);
    const result = await migrationWorker.migrateSingleFile(permlink);
    
    res.json({ 
      success: true,
      message: result.message,
      permlink
    });
  } catch (error) {
    console.error(`Error migrating ${req.params.permlink}:`, error);
    res.status(500).json({ 
      error: 'Migration failed',
      message: error.message
    });
  }
});

/**
 * POST /api/admin/migrations/retry/:permlink - Retry failed migration
 */
router.post('/migrations/retry/:permlink', requireAuth, async (req, res) => {
  try {
    const { permlink } = req.params;
    const AudioMessage = require('../models/AudioMessage');
    
    await AudioMessage.retryMigration(permlink);
    
    res.json({ 
      success: true,
      message: 'Migration queued for retry',
      permlink
    });
  } catch (error) {
    console.error(`Error retrying migration for ${req.params.permlink}:`, error);
    res.status(500).json({ 
      error: 'Failed to retry migration',
      message: error.message
    });
  }
});

module.exports = router;
