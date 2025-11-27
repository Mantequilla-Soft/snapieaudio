/**
 * Test script to create a sample audio entry in MongoDB
 * Run with: node server/test-create-audio.js
 */

require('dotenv').config();
const AudioMessage = require('./models/AudioMessage');

async function createTestAudio() {
  try {
    console.log('Creating test audio entry...');
    
    const testAudio = await AudioMessage.create({
      owner: 'meno',
      permlink: 'testaud1',
      frontend_app: 'snapie-test',
      audio_cid: 'QmdMsEXyDe5Z4S3n8THfYgFP1iH3ngCeCytdHnndzqdZAK',
      ipfs_status: 'pinned_local',
      pinned_nodes: ['local'],
      originalFilename: 'testaudio.mp4',
      format: 'm4a',
      codec: 'aac',
      size: 244714,
      duration: 45,
      bitrate: 128,
      sampleRate: 44100,
      channels: 1,
      waveform: {
        peaks: Array(100).fill(0).map(() => Math.random()),
        samples: 100
      },
      title: 'Test Audio Message',
      context_type: 'voice_message',
      visibility: 'public'
    });
    
    console.log('✅ Test audio created successfully!');
    console.log('Permlink:', testAudio.permlink);
    console.log('CID:', testAudio.audio_cid);
    console.log('\nTest URL:');
    console.log(`http://localhost:3000/play?a=${testAudio.permlink}`);
    console.log(`http://localhost:3000/play?a=${testAudio.permlink}&mode=minimal`);
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Error creating test audio:', error);
    process.exit(1);
  }
}

createTestAudio();
