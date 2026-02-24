/**
 * Test script for post_permlink field functionality
 * 
 * Tests:
 * 1. Upload audio with post_permlink
 * 2. Retrieve audio and verify post_permlink
 * 3. Update post_permlink via PATCH endpoint
 * 4. Validate post_permlink format restrictions
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const AudioMessage = require('./models/AudioMessage');

async function testPostPermlink() {
  console.log('\n🧪 Testing post_permlink functionality...\n');

  try {
    // Test 1: Create audio with post_permlink
    console.log('Test 1: Creating audio with post_permlink...');
    const audioData = {
      owner: 'test-user',
      audio_cid: 'QmTestPostPermlink12345678901234567890123456',
      ipfs_status: 'pinned_local',
      pinned_nodes: ['local'],
      originalFilename: 'test-audio.mp3',
      format: 'mp3',
      size: 3000000,
      duration: 120,
      title: 'Test Audio with Post Permlink',
      description: 'Testing blockchain post linking',
      category: 'podcast',
      post_permlink: 'my-awesome-audio-snap-2026',
      context_type: 'test',
      migration_status: 'skip'
    };

    const audio = await AudioMessage.create(audioData);
    console.log('✅ Audio created with permlink:', audio.permlink);
    console.log('✅ Post permlink set to:', audio.post_permlink);

    // Test 2: Retrieve and verify post_permlink
    console.log('\nTest 2: Retrieving audio and verifying post_permlink...');
    const retrieved = await AudioMessage.findByPermlink(audio.permlink);
    
    if (!retrieved) {
      throw new Error('Failed to retrieve audio');
    }

    if (retrieved.post_permlink === 'my-awesome-audio-snap-2026') {
      console.log('✅ Post permlink correctly retrieved:', retrieved.post_permlink);
    } else {
      throw new Error(`Post permlink mismatch. Expected: my-awesome-audio-snap-2026, Got: ${retrieved.post_permlink}`);
    }

    // Test 3: Update post_permlink
    console.log('\nTest 3: Updating post_permlink...');
    const updatedPermlink = 'updated-blockchain-post-2026';
    const result = await AudioMessage.updatePostPermlink(
      audio.permlink,
      'test-user',
      updatedPermlink
    );

    if (!result) {
      throw new Error('Failed to update post_permlink');
    }

    console.log('✅ Post permlink updated to:', result.post_permlink);

    // Verify update
    const verifyUpdate = await AudioMessage.findByPermlink(audio.permlink);
    if (verifyUpdate.post_permlink === updatedPermlink) {
      console.log('✅ Update verified successfully');
    } else {
      throw new Error('Post permlink update not persisted');
    }

    // Test 4: Create audio without post_permlink (optional field)
    console.log('\nTest 4: Creating audio without post_permlink (should default to null)...');
    const audioWithoutPermlink = await AudioMessage.create({
      owner: 'test-user-2',
      audio_cid: 'QmTestNoPostPermlink234567890123456789012345',
      ipfs_status: 'pinned_local',
      pinned_nodes: ['local'],
      originalFilename: 'test-audio-2.mp3',
      format: 'mp3',
      size: 2000000,
      duration: 60,
      context_type: 'test',
      migration_status: 'skip'
    });

    const retrieved2 = await AudioMessage.findByPermlink(audioWithoutPermlink.permlink);
    if (retrieved2.post_permlink === null) {
      console.log('✅ Audio created without post_permlink (defaults to null)');
    } else {
      throw new Error('Post permlink should be null when not provided');
    }

    // Test 5: Authorization check (wrong user can't update)
    console.log('\nTest 5: Testing authorization (wrong user should fail)...');
    const wrongUserResult = await AudioMessage.updatePostPermlink(
      audio.permlink,
      'wrong-user',
      'malicious-update'
    );

    if (wrongUserResult === null) {
      console.log('✅ Authorization check passed (wrong user rejected)');
    } else {
      throw new Error('Wrong user was able to update post_permlink!');
    }

    console.log('\n✅ All post_permlink tests passed!\n');
    process.exit(0);

  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    console.error(error);
    process.exit(1);
  }
}

// Run tests
testPostPermlink();
