const multer = require('multer');

// Store files in memory for direct IPFS upload
const storage = multer.memoryStorage();

// File filter - only allow audio files
const fileFilter = (req, file, cb) => {
  const allowedFormats = (process.env.UPLOAD_ALLOWED_FORMATS || 'mp3,m4a,ogg,webm,wav')
    .split(',')
    .map(f => f.trim());

  const ext = file.originalname.split('.').pop().toLowerCase();
  
  if (allowedFormats.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error(`Invalid file format. Allowed: ${allowedFormats.join(', ')}`), false);
  }
};

// Configure multer
const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: parseInt(process.env.UPLOAD_MAX_FILE_SIZE) || 52428800 // 50MB default
  }
});

module.exports = upload;
