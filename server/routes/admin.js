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

module.exports = router;
