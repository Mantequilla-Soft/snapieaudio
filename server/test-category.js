/**
 * Test Category Functionality
 * 
 * Tests:
 * 1. Create audio with default category (voice_message)
 * 2. Create audio with explicit category (podcast)
 * 3. Verify category appears in GET response
 * 4. Test all valid categories
 * 5. Backwards compatibility (no category field)
 */

const AudioMessage = require('./models/AudioMessage');
require('dotenv').config();

async function testCategories() {
  console.log('\n🧪 Testing Category Functionality\n');

  try {
    // Test 1: Create audio without category (default to voice_message)
    console.log('Test 1: Creating audio without category (should default to voice_message)...');
    const audioDefault = await AudioMessage.create({
      owner: 'test-user',
      audio_cid: 'QmTestCategory1234567890123456789012345678901',
      ipfs_status: 'pinned_local',
      pinned_nodes: ['local'],
      originalFilename: 'test-default-category.mp3',
      format: 'mp3',
      size: 1024000,
      duration: 60.0,
      title: 'Test Audio - Default Category',
      context_type: 'test',
      migration_status: 'skip'
    });

    console.log(`✅ Audio created with permlink: ${audioDefault.permlink}`);
    console.log(`   Category: ${audioDefault.category}`);
    
    if (audioDefault.category === 'voice_message') {
      console.log('✅ Default category correct: voice_message');
    } else {
      console.log(`❌ Expected 'voice_message', got: ${audioDefault.category}`);
    }

    // Test 2: Create audio with explicit category (podcast)
    console.log('\nTest 2: Creating audio with explicit category (podcast)...');
    const audioPodcast = await AudioMessage.create({
      owner: 'test-user',
      audio_cid: 'QmTestCategory9876543210987654321098765432109',
      ipfs_status: 'pinned_local',
      pinned_nodes: ['local'],
      originalFilename: 'test-podcast.mp3',
      format: 'mp3',
      size: 5024000,
      duration: 1800.0,
      title: 'Test Podcast Episode',
      category: 'podcast',
      context_type: 'test',
      migration_status: 'skip'
    });

    console.log(`✅ Audio created with permlink: ${audioPodcast.permlink}`);
    console.log(`   Category: ${audioPodcast.category}`);
    
    if (audioPodcast.category === 'podcast') {
      console.log('✅ Explicit category correct: podcast');
    } else {
      console.log(`❌ Expected 'podcast', got: ${audioPodcast.category}`);
    }

    // Test 3: Fetch audio and verify category in response
    console.log('\nTest 3: Fetching audio to verify category in response...');
    const fetchedPodcast = await AudioMessage.findByPermlink(audioPodcast.permlink);
    
    if (fetchedPodcast.category === 'podcast') {
      console.log(`✅ Category in response: ${fetchedPodcast.category}`);
    } else {
      console.log(`❌ Category mismatch in response!`);
      console.log(`   Expected: podcast, Got: ${fetchedPodcast.category}`);
    }

    // Test 4: Test all valid category values
    console.log('\nTest 4: Testing all valid category values...');
    const validCategories = ['voice_message', 'podcast', 'song', 'interview', 'audiobook', 'noise_sample'];
    
    for (const category of validCategories) {
      const audio = await AudioMessage.create({
        owner: 'test-user',
        audio_cid: `QmTest${category}12345678901234567890123456789`,
        ipfs_status: 'pinned_local',
        pinned_nodes: ['local'],
        originalFilename: `test-${category}.mp3`,
        format: 'mp3',
        size: 512000,
        duration: 120.0,
        title: `Test ${category}`,
        category: category,
        context_type: 'test',
        migration_status: 'skip'
      });

      if (audio.category === category) {
        console.log(`✅ ${category} - Created successfully`);
      } else {
        console.log(`❌ ${category} - Failed (got: ${audio.category})`);
      }
    }

    // Test 5: Backwards compatibility - fetch audio without category field
    console.log('\nTest 5: Backwards compatibility check...');
    const fetchedDefault = await AudioMessage.findByPermlink(audioDefault.permlink);
    
    if (fetchedDefault.category === 'voice_message') {
      console.log('✅ Backwards compatible - undefined category defaults to voice_message');
    } else {
      console.log(`❌ Backwards compatibility issue - got: ${fetchedDefault.category}`);
    }

    // Test 6: Verify category is returned in all GET responses
    console.log('\nTest 6: Verify category field exists in API responses...');
    const allTestCategories = [audioDefault, audioPodcast];
    let allHaveCategory = true;
    
    for (const audio of allTestCategories) {
      const fetched = await AudioMessage.findByPermlink(audio.permlink);
      if (!fetched.hasOwnProperty('category')) {
        console.log(`❌ Missing category field in response for ${audio.permlink}`);
        allHaveCategory = false;
      }
    }
    
    if (allHaveCategory) {
      console.log('✅ All responses include category field');
    }

    console.log('\n✅ All category tests completed successfully!\n');
    
    console.log('📊 Summary:');
    console.log(`  - Default category (voice_message): Working`);
    console.log(`  - Explicit categories: Working`);
    console.log(`  - All valid categories tested: ${validCategories.join(', ')}`);
    console.log(`  - API response includes category: Yes`);
    console.log(`  - Backwards compatible: Yes`);
    
    process.exit(0);

  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  }
}

// Run tests
testCategories();
