/**
 * Test Thumbnail Functionality
 * 
 * Tests:
 * 1. Create audio with thumbnail URL
 * 2. Update thumbnail for existing audio
 * 3. Verify thumbnail appears in GET response
 */

const AudioMessage = require('./models/AudioMessage');
require('dotenv').config();

async function testThumbnails() {
  console.log('\n🧪 Testing Thumbnail Functionality\n');

  try {
    // Test 1: Create audio with thumbnail
    console.log('Test 1: Creating audio with thumbnail URL...');
    const audioData = {
      owner: 'test-user',
      audio_cid: 'QmTestCID123456789012345678901234567890123456',
      ipfs_status: 'pinned_local',
      pinned_nodes: ['local'],
      originalFilename: 'test-audio.mp3',
      format: 'mp3',
      codec: 'mp3',
      size: 1024000,
      duration: 120.5,
      bitrate: 128000,
      sampleRate: 44100,
      channels: 2,
      title: 'Test Audio with Thumbnail',
      description: 'Testing thumbnail functionality',
      thumbnail_url: 'https://files.hive.blog/file/hiveimages/test-thumbnail.jpg',
      context_type: 'test',
      migration_status: 'skip'
    };

    const audio = await AudioMessage.create(audioData);
    console.log(`✅ Audio created with permlink: ${audio.permlink}`);
    console.log(`   Thumbnail URL: ${audio.thumbnail_url}`);

    // Test 2: Fetch audio and verify thumbnail
    console.log('\nTest 2: Fetching audio to verify thumbnail...');
    const fetchedAudio = await AudioMessage.findByPermlink(audio.permlink);
    
    if (fetchedAudio.thumbnail_url === audioData.thumbnail_url) {
      console.log(`✅ Thumbnail URL verified: ${fetchedAudio.thumbnail_url}`);
    } else {
      console.log(`❌ Thumbnail URL mismatch!`);
      console.log(`   Expected: ${audioData.thumbnail_url}`);
      console.log(`   Got: ${fetchedAudio.thumbnail_url}`);
    }

    // Test 3: Update thumbnail
    console.log('\nTest 3: Updating thumbnail URL...');
    const newThumbnailUrl = 'https://files.hive.blog/file/hiveimages/updated-thumbnail.jpg';
    const updated = await AudioMessage.updateThumbnail(
      audio.permlink,
      'test-user',
      newThumbnailUrl
    );

    if (updated && updated.thumbnail_url === newThumbnailUrl) {
      console.log(`✅ Thumbnail updated successfully: ${updated.thumbnail_url}`);
    } else {
      console.log(`❌ Failed to update thumbnail`);
    }

    // Test 4: Verify updated thumbnail in GET
    console.log('\nTest 4: Fetching updated audio...');
    const updatedAudio = await AudioMessage.findByPermlink(audio.permlink);
    
    if (updatedAudio.thumbnail_url === newThumbnailUrl) {
      console.log(`✅ Updated thumbnail verified: ${updatedAudio.thumbnail_url}`);
    } else {
      console.log(`❌ Updated thumbnail not found`);
    }

    // Test 5: Create audio without thumbnail (backwards compatibility)
    console.log('\nTest 5: Creating audio without thumbnail...');
    const audioNoThumb = await AudioMessage.create({
      owner: 'test-user',
      audio_cid: 'QmTestCID987654321098765432109876543210987654',
      ipfs_status: 'pinned_local',
      pinned_nodes: ['local'],
      originalFilename: 'test-audio-no-thumb.mp3',
      format: 'mp3',
      size: 512000,
      duration: 60.0,
      title: 'Test Audio without Thumbnail',
      context_type: 'test',
      migration_status: 'skip'
    });

    const fetchedNoThumb = await AudioMessage.findByPermlink(audioNoThumb.permlink);
    if (fetchedNoThumb.thumbnail_url === null) {
      console.log(`✅ Audio without thumbnail created successfully (thumbnail_url: null)`);
    } else {
      console.log(`❌ Expected null thumbnail, got: ${fetchedNoThumb.thumbnail_url}`);
    }

    // Test 6: Test authorization (wrong user can't update)
    console.log('\nTest 6: Testing authorization (wrong user)...');
    const unauthorizedUpdate = await AudioMessage.updateThumbnail(
      audio.permlink,
      'wrong-user',
      'https://malicious.com/image.jpg'
    );

    if (!unauthorizedUpdate) {
      console.log(`✅ Authorization check passed (wrong user rejected)`);
    } else {
      console.log(`❌ Authorization failed! Wrong user was able to update thumbnail`);
    }

    console.log('\n✅ All thumbnail tests completed!\n');
    process.exit(0);

  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  }
}

// Run tests
testThumbnails();
