const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const audioRoutes = require('./routes/audio');
const adminRoutes = require('./routes/admin');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files
app.use('/js', express.static(path.join(__dirname, '../src')));
app.use('/styles', express.static(path.join(__dirname, '../src')));
app.use('/assets', express.static(path.join(__dirname, '../assets')));

// Routes
app.use('/api/audio', audioRoutes);
app.use('/api/admin', adminRoutes);

// Landing page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../src/index-landing.html'));
});

// Demo page
app.get('/demo', (req, res) => {
  res.sendFile(path.join(__dirname, '../src/demo.html'));
});

// Documentation page
app.get('/docs', (req, res) => {
  res.sendFile(path.join(__dirname, '../src/docs.html'));
});

// Admin page
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '../src/admin.html'));
});

// Admin user management page
app.get('/admin/users', (req, res) => {
  res.sendFile(path.join(__dirname, '../src/admin-users.html'));
});

// Player page route
app.get('/play', (req, res) => {
  res.sendFile(path.join(__dirname, '../src/index.html'));
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`🎵 SnapieAudioPlayer server running on http://localhost:${PORT}`);
  console.log(`📺 Player available at: http://localhost:${PORT}/play?a=<permlink>`);
});

module.exports = app;
