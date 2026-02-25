/**
 * Audit IPFS Pins Script
 * One-time script to check MongoDB records against actual IPFS pins
 * Identifies records marked as "pinned_local" but missing from IPFS
 * 
 * Usage: node server/audit-pins.js
 */

require('dotenv').config();
const { MongoClient } = require('mongodb');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

// MongoDB connection
let client;

async function connectDB() {
  if (!client) {
    client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
    console.log('✓ Connected to MongoDB');
  }
  return client.db(process.env.MONGODB_DATABASE || 'threespeak');
}

/**
 * Check if CID is pinned in local IPFS
 */
async function isPinned(cid) {
  try {
    const { stdout, stderr } = await execAsync(`ipfs pin ls ${cid}`);
    return !stderr && stdout.includes(cid);
  } catch (error) {
    // Command exits with error if not pinned
    return false;
  }
}

/**
 * Main audit function
 */
async function auditPins() {
  console.log('==========================================');
  console.log('IPFS Pin Audit - Starting');
  console.log('==========================================\n');
  
  const startTime = Date.now();
  
  try {
    const database = await connectDB();
    const collection = database.collection(
      process.env.MONGODB_COLLECTION_AUDIO || 'embed-audio'
    );
    
    // Query all records marked as pinned_local
    console.log('Querying MongoDB for pinned_local records...');
    const records = await collection.find({
      ipfs_status: 'pinned_local',
      status: 'published'
    }).toArray();
    
    console.log(`Found ${records.length} records marked as pinned_local\n`);
    
    if (records.length === 0) {
      console.log('No records to audit. Exiting.');
      process.exit(0);
    }
    
    // Audit each record
    const results = {
      total: records.length,
      verified: 0,
      missing: 0,
      missingList: [],
      byCategory: {}
    };
    
    console.log('Checking IPFS pins...\n');
    
    for (let i = 0; i < records.length; i++) {
      const audio = records[i];
      const progress = `[${i + 1}/${records.length}]`;
      
      process.stdout.write(`${progress} Checking ${audio.permlink} (${audio.category})... `);
      
      const pinned = await isPinned(audio.audio_cid);
      
      if (pinned) {
        console.log('✓ OK');
        results.verified++;
      } else {
        console.log('✗ MISSING');
        results.missing++;
        
        results.missingList.push({
          permlink: audio.permlink,
          owner: audio.owner,
          category: audio.category,
          cid: audio.audio_cid,
          title: audio.title,
          createdAt: audio.createdAt,
          size: audio.size,
          duration: audio.duration
        });
        
        // Update MongoDB record
        await collection.updateOne(
          { permlink: audio.permlink },
          {
            $set: {
              ipfs_status: 'missing_pin',
              pin_lost_at: new Date(),
              migration_status: 'failed',
              migration_last_error: 'Pin missing from IPFS (audit detected)',
              updatedAt: new Date()
            }
          }
        );
        
        // Count by category
        const cat = audio.category || 'unknown';
        results.byCategory[cat] = (results.byCategory[cat] || 0) + 1;
      }
      
      // Small delay to not overwhelm IPFS
      await new Promise(r => setTimeout(r, 100));
    }
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    
    console.log('\n==========================================');
    console.log('AUDIT COMPLETE');
    console.log('==========================================');
    console.log(`Duration: ${duration}s`);
    console.log(`Total records: ${results.total}`);
    console.log(`Verified: ${results.verified}`);
    console.log(`Missing: ${results.missing}`);
    
    if (results.missing > 0) {
      console.log('\n--- Missing Pins by Category ---');
      Object.entries(results.byCategory).forEach(([cat, count]) => {
        const valuable = ['song', 'podcast', 'interview'].includes(cat);
        const marker = valuable ? '⚠️ ' : '  ';
        console.log(`${marker}${cat}: ${count}`);
      });
      
      console.log('\n--- Missing Files Report ---');
      console.log('Total missing:', results.missing);
      
      const valuableMissing = results.missingList.filter(
        a => ['song', 'podcast', 'interview'].includes(a.category)
      );
      
      if (valuableMissing.length > 0) {
        console.log(`\n⚠️  CRITICAL: ${valuableMissing.length} valuable files lost (songs/podcasts/interviews)`);
        console.log('These should be recovered from backup if available:\n');
        valuableMissing.forEach(a => {
          console.log(`  - ${a.permlink} | ${a.owner} | ${a.category} | "${a.title || 'Untitled'}"`);
          console.log(`    CID: ${a.cid}`);
          console.log(`    Created: ${a.createdAt}`);
          console.log(`    Size: ${(a.size / 1024).toFixed(1)}KB, Duration: ${a.duration}s\n`);
        });
      }
      
      const voiceMessages = results.missingList.filter(
        a => a.category === 'voice_message'
      );
      
      if (voiceMessages.length > 0) {
        console.log(`\nℹ️  ${voiceMessages.length} voice messages lost (ephemeral, low priority)`);
        console.log('Voice messages are not backed up by design.');
      }
      
      // Write full report to file
      const reportPath = `${__dirname}/audit-report-${Date.now()}.json`;
      const fs = require('fs');
      fs.writeFileSync(reportPath, JSON.stringify(results, null, 2));
      console.log(`\nFull report saved: ${reportPath}`);
    } else {
      console.log('\n✅ All pins verified - no missing files!');
    }
    
  } catch (error) {
    console.error('\n❌ Audit failed:', error);
    process.exit(1);
  } finally {
    if (client) {
      await client.close();
    }
  }
  
  process.exit(0);
}

// Run audit
auditPins();
