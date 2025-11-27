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

module.exports = router;
