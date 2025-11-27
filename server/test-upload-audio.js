/**
 * Test script for audio upload endpoint
 * Usage: node server/test-upload-audio.js <audio-file-path>
 */

const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

require('dotenv').config();

// Dynamic import for node-fetch
let fetch;
(async () => {
  const nodeFetch = await import('node-fetch');
  fetch = nodeFetch.default;
})();

const API_URL = 'http://localhost:3001/api/audio/upload';
const API_KEY = process.env.API_KEYS.split(',')[0];

async function testUpload(audioFilePath) {
  try {
    // Wait for fetch to be loaded
    const nodeFetch = await import('node-fetch');
    fetch = nodeFetch.default;
    
    console.log('🎵 Testing audio upload...\n');

    if (!audioFilePath) {
      console.error('❌ Please provide an audio file path');
      console.log('Usage: node server/test-upload-audio.js <audio-file-path>');
      process.exit(1);
    }

    if (!fs.existsSync(audioFilePath)) {
      console.error(`❌ File not found: ${audioFilePath}`);
      process.exit(1);
    }

    const fileBuffer = fs.readFileSync(audioFilePath);
    const fileName = path.basename(audioFilePath);
    
    console.log(`📁 File: ${fileName}`);
    console.log(`📊 Size: ${(fileBuffer.length / 1024).toFixed(2)} KB`);
    console.log(`🔑 API Key: ${API_KEY.substring(0, 20)}...`);
    console.log('');

    // Create form data
    const form = new FormData();
    form.append('audio', fileBuffer, fileName);
    
    // Add metadata (trust client initially)
    form.append('duration', '45');
    form.append('format', path.extname(fileName).substring(1));
    form.append('codec', 'aac');
    form.append('bitrate', '128');
    form.append('sampleRate', '44100');
    form.append('channels', '1');
    form.append('title', 'Test Upload from Script');
    form.append('context_type', 'voice_message');
    form.append('waveform', JSON.stringify({
      peaks: Array(100).fill(0).map(() => Math.random()),
      samples: 100
    }));

    console.log('⏳ Uploading to server...');

    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'X-API-Key': API_KEY,
        'X-User': 'test-user',
        ...form.getHeaders()
      },
      body: form
    });

    const data = await response.json();

    if (response.ok) {
      console.log('\n✅ Upload successful!\n');
      console.log(`Permlink: ${data.permlink}`);
      console.log(`CID: ${data.cid}`);
      console.log(`Play URL: ${data.playUrl}`);
      console.log(`API URL: ${data.apiUrl}`);
      console.log('\nTest playback:');
      console.log(`curl "${data.apiUrl}"`);
    } else {
      console.error('\n❌ Upload failed:');
      console.error(data);
    }

  } catch (error) {
    console.error('\n❌ Error:', error.message);
    process.exit(1);
  }
}

// Get file path from command line
const audioFile = process.argv[2];
testUpload(audioFile);
