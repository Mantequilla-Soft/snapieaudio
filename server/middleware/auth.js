/**
 * API Key Authentication Middleware
 */

/**
 * Validate API key from request headers
 */
exports.validateApiKey = (req, res, next) => {
  const apiKey = req.headers['x-api-key'] || req.query.api_key;

  if (!apiKey) {
    return res.status(401).json({ 
      error: 'API key required',
      message: 'Please provide an API key in X-API-Key header or api_key query parameter'
    });
  }

  // Get valid API keys from environment
  const validKeys = (process.env.API_KEYS || '').split(',').map(k => k.trim());

  if (!validKeys.includes(apiKey)) {
    return res.status(403).json({ 
      error: 'Invalid API key',
      message: 'The provided API key is not valid'
    });
  }

  // Attach API key identifier to request (for tracking)
  req.apiKeyId = apiKey.substring(0, 8);
  req.user = req.headers['x-user'] || 'api-user'; // Allow user override via header

  next();
};
