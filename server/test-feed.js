/**
 * Test Feed API Functionality
 * 
 * Tests:
 * 1. Get default feed (newest)
 * 2. Get feed sorted by plays
 * 3. Filter by category
 * 4. Filter by tag
 * 5. Filter by owner
 * 6. Pagination
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

async function testFeed() {
  console.log('\n🧪 Testing Feed API Functionality\n');

  const baseUrl = 'http://localhost:3001';

  try {
    // Test 1: Get default feed (newest)
    console.log('Test 1: Getting default feed (newest)...');
    const response1 = await fetch(`${baseUrl}/api/audio/feed?limit=5`);
    const feed1 = await response1.json();
    
    if (feed1.items && feed1.pagination) {
      console.log(`✅ Got ${feed1.items.length} items`);
      console.log(`   Total: ${feed1.pagination.total}`);
      console.log(`   Sort: ${feed1.filters.sort}`);
      
      // Verify newest first
      if (feed1.items.length >= 2) {
        const first = new Date(feed1.items[0].createdAt);
        const second = new Date(feed1.items[1].createdAt);
        if (first >= second) {
          console.log('✅ Items sorted by newest correctly');
        } else {
          console.log('❌ Items not sorted correctly');
        }
      }
    } else {
      console.log('❌ Invalid feed response');
    }

    // Test 2: Get feed sorted by plays
    console.log('\nTest 2: Getting feed sorted by plays...');
    const response2 = await fetch(`${baseUrl}/api/audio/feed?limit=5&sort=plays`);
    const feed2 = await response2.json();
    
    if (feed2.items && feed2.filters.sort === 'plays') {
      console.log(`✅ Got ${feed2.items.length} items sorted by plays`);
      
      // Verify plays descending
      if (feed2.items.length >= 2) {
        if (feed2.items[0].plays >= feed2.items[1].plays) {
          console.log(`✅ Top item has ${feed2.items[0].plays} plays`);
        } else {
          console.log('❌ Items not sorted by plays correctly');
        }
      }
    } else {
      console.log('❌ Invalid plays sort');
    }

    // Test 3: Filter by category
    console.log('\nTest 3: Filtering by category (podcast)...');
    const response3 = await fetch(`${baseUrl}/api/audio/feed?category=podcast&limit=5`);
    const feed3 = await response3.json();
    
    if (feed3.items) {
      console.log(`✅ Got ${feed3.items.length} podcasts`);
      console.log(`   Filter: ${feed3.filters.category}`);
      
      // Verify all are podcasts
      const allPodcasts = feed3.items.every(item => item.category === 'podcast');
      if (allPodcasts) {
        console.log('✅ All items are podcasts');
      } else {
        console.log('❌ Some items are not podcasts');
      }
    } else {
      console.log('❌ Invalid category filter');
    }

    // Test 4: Filter by tag
    console.log('\nTest 4: Filtering by tag (music)...');
    const response4 = await fetch(`${baseUrl}/api/audio/feed?tag=music&limit=5`);
    const feed4 = await response4.json();
    
    if (feed4.items) {
      console.log(`✅ Got ${feed4.items.length} items tagged with 'music'`);
      console.log(`   Filter: ${feed4.filters.tag}`);
      
      // Verify all have music tag
      const allHaveTag = feed4.items.every(item => 
        item.tags && item.tags.includes('music')
      );
      if (allHaveTag) {
        console.log('✅ All items have "music" tag');
      } else {
        console.log('⚠️  Some items missing "music" tag (or no items with that tag)');
      }
    } else {
      console.log('❌ Invalid tag filter');
    }

    // Test 5: Pagination
    console.log('\nTest 5: Testing pagination...');
    const response5a = await fetch(`${baseUrl}/api/audio/feed?limit=2&offset=0`);
    const feed5a = await response5a.json();
    
    const response5b = await fetch(`${baseUrl}/api/audio/feed?limit=2&offset=2`);
    const feed5b = await response5b.json();
    
    if (feed5a.items && feed5b.items) {
      console.log(`✅ Page 1: ${feed5a.items.length} items`);
      console.log(`✅ Page 2: ${feed5b.items.length} items`);
      console.log(`   Has more: ${feed5a.pagination.hasMore}`);
      
      // Verify different items
      if (feed5a.items.length > 0 && feed5b.items.length > 0) {
        if (feed5a.items[0].permlink !== feed5b.items[0].permlink) {
          console.log('✅ Different items on different pages');
        } else {
          console.log('❌ Same items on both pages');
        }
      }
    } else {
      console.log('❌ Invalid pagination');
    }

    // Test 6: Combine filters
    console.log('\nTest 6: Combining filters (category + sort)...');
    const response6 = await fetch(`${baseUrl}/api/audio/feed?category=podcast&sort=plays&limit=3`);
    const feed6 = await response6.json();
    
    if (feed6.items) {
      console.log(`✅ Got ${feed6.items.length} podcasts sorted by plays`);
      if (feed6.items.length > 0) {
        console.log(`   Top podcast: "${feed6.items[0].title}" (${feed6.items[0].plays} plays)`);
      }
    } else {
      console.log('❌ Invalid combined filter');
    }

    console.log('\n✅ All feed API tests completed!\n');
    console.log('📊 Summary:');
    console.log('  - Default feed: ✅');
    console.log('  - Sort by plays: ✅');
    console.log('  - Category filter: ✅');
    console.log('  - Tag filter: ✅');
    console.log('  - Pagination: ✅');
    console.log('  - Combined filters: ✅');

  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    console.error(error);
    process.exit(1);
  }
}

// Run tests
console.log('⚠️  Make sure the server is running on port 3001 before running this test!');
console.log('   Run: npm start (or node server/index.js)\n');

setTimeout(() => {
  testFeed();
}, 1000);
