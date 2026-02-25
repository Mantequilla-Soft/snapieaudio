/**
 * Migration Worker
 * Backs up valuable audio content (songs, podcasts, interviews) to 3speak supernode
 * Runs daily at 2am to avoid peak traffic
 * Voice messages are NOT migrated (ephemeral content)
 */

const AudioMessage = require('../models/AudioMessage');
const https = require('https');
const http = require('http');
const { URL } = require('url');

/**
 * Simple POST request helper using Node's built-in http/https
 * Replacement for axios to avoid dependency
 */
function httpPost(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const protocol = urlObj.protocol === 'https:' ? https : http;
    const timeout = options.timeout || 10000;
    
    const req = protocol.request({
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: options.headers || { 'Content-Length': '0' },
      timeout
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const jsonData = data ? JSON.parse(data) : {};
          resolve({ status: res.statusCode, data: jsonData });
        } catch (e) {
          resolve({ status: res.statusCode, data });
        }
      });
    });
    
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      const err = new Error('Request timeout');
      err.code = 'ECONNABORTED';
      reject(err);
    });
    req.end();
  });
}

class MigrationWorker {
  constructor() {
    this.supernodeUrl = process.env.IPFS_SUPERNODE_URL || 'https://ipfs.3speak.tv';
    this.maxRetries = 3;
    this.batchSize = 50; // Larger batch since running once daily
    this.scheduleHour = parseInt(process.env.MIGRATION_SCHEDULE_HOUR || '2');
    this.isRunning = false;
    this.nextRunTime = null;
    this.timer = null;
  }

  /**
   * Start the migration worker with 2am daily scheduling
   */
  start() {
    console.log('🚀 Migration Worker started');
    console.log(`   Supernode: ${this.supernodeUrl}`);
    console.log(`   Schedule: Daily at ${this.scheduleHour}:00`);
    console.log(`   Categories: song, podcast, interview`);
    console.log(`   Batch size: ${this.batchSize}`);
    
    this.scheduleNext();
  }

  /**
   * Schedule next run at configured hour (default 2am)
   */
  scheduleNext() {
    const now = new Date();
    const next = this.getNextScheduledTime();
    const delay = next.getTime() - now.getTime();
    
    this.nextRunTime = next;
    
    const hours = Math.floor(delay / (1000 * 60 * 60));
    const minutes = Math.floor((delay % (1000 * 60 * 60)) / (1000 * 60));
    
    console.log(`[Migration] Next run: ${next.toISOString()} (in ${hours}h ${minutes}m)`);
    
    // Clear any existing timer
    if (this.timer) {
      clearTimeout(this.timer);
    }
    
    // Schedule the job
    this.timer = setTimeout(() => {
      this.processQueue()
        .catch(err => {
          console.error('❌ [Migration] Job error:', err);
        })
        .finally(() => {
          // Schedule next run after this one completes
          this.scheduleNext();
        });
    }, delay);
  }

  /**
   * Calculate next scheduled time (default 2am)
   */
  getNextScheduledTime() {
    const now = new Date();
    const next = new Date(now);
    
    next.setHours(this.scheduleHour, 0, 0, 0);
    
    // If target time has already passed today, schedule for tomorrow
    if (next <= now) {
      next.setDate(next.getDate() + 1);
    }
    
    return next;
  }

  /**
   * Process the migration queue
   * @returns {Object} Stats about processed files
   */
  async processQueue() {
    if (this.isRunning) {
      console.log('[Migration] Already running, skipping...');
      return { skipped: true };
    }

    this.isRunning = true;
    const startTime = Date.now();
    const results = {
      processed: 0,
      succeeded: 0,
      failed: 0,
      errors: []
    };

    try {
      console.log('[Migration] ===== STARTING MIGRATION JOB =====');
      console.log(`[Migration] Time: ${new Date().toISOString()}`);
      
      const pending = await AudioMessage.findPendingMigrations(this.batchSize);
      
      if (pending.length === 0) {
        console.log('[Migration] No pending migrations');
        return results;
      }

      console.log(`[Migration] Processing ${pending.length} files`);
      console.log(`[Migration] Categories: ${[...new Set(pending.map(a => a.category))].join(', ')}`);

      for (const audio of pending) {
        results.processed++;
        
        try {
          await this.migrateFile(audio);
          results.succeeded++;
        } catch (error) {
          results.failed++;
          results.errors.push({
            permlink: audio.permlink,
            error: error.message
          });
          await this.handleMigrationError(audio, error);
        }
      }

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log('[Migration] ===== JOB COMPLETE =====');
      console.log(`[Migration] Duration: ${duration}s`);
      console.log(`[Migration] Success: ${results.succeeded}/${results.processed}`);
      if (results.failed > 0) {
        console.log(`[Migration] Failed: ${results.failed}`);
      }

      return results;
    } catch (error) {
      console.error('[Migration] Queue processing failed:', error);
      throw error;
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Migrate a single file to supernode
   * @param {Object} audio - Audio document from MongoDB
   */
  async migrateFile(audio) {
    console.log(`[Migration ${audio.permlink}] Starting (${audio.category})...`);

    // Step 1: Verify we have it locally
    if (!await this.verifyLocalCID(audio.audio_cid)) {
      throw new Error('CID not found in local IPFS');
    }
    console.log(`[Migration ${audio.permlink}] ✓ Local copy verified`);

    // Step 2: Pin to supernode
    await this.pinToSupernode(audio.audio_cid);
    console.log(`[Migration ${audio.permlink}] ✓ Pinned to supernode`);

    // Step 3: Verify pin succeeded (wait 3s for indexing)
    await new Promise(r => setTimeout(r, 3000));
    if (!await this.verifySuperNodePin(audio.audio_cid)) {
      throw new Error('Supernode verification failed');
    }
    console.log(`[Migration ${audio.permlink}] ✓ Supernode verified`);

    // Step 4: Update database
    await AudioMessage.markMigrated(
      audio.permlink,
      ['local', 'supernode']
    );
    console.log(`[Migration ${audio.permlink}] ✓ Database updated`);
  }

  /**
   * Manually migrate a single file (bypasses category filter)
   * Used for admin "Migrate Now" button
   * @param {string} permlink - The audio permlink
   * @returns {Object} Migration result
   */
  async migrateSingleFile(permlink) {
    console.log(`[Migration] Manual trigger for: ${permlink}`);
    
    const audio = await AudioMessage.getByPermlink(permlink);
    if (!audio) {
      throw new Error('Audio not found');
    }

    if (audio.migration_status === 'migrated') {
      return { success: true, message: 'Already migrated' };
    }

    await this.migrateFile(audio);
    
    return { success: true, message: 'Migration completed' };
  }

  /**
   * Verify file exists in local IPFS
   */
  async verifyLocalCID(cid) {
    try {
      const localApiUrl = process.env.IPFS_API_URL || 'http://127.0.0.1:5001';
      const response = await httpPost(
        `${localApiUrl}/api/v0/object/stat?arg=${cid}`,
        { 
          timeout: 5000,
          headers: { 'Content-Length': '0' }
        }
      );
      return response.status === 200;
    } catch (error) {
      console.warn(`[Migration] Local verification failed for ${cid}:`, error.message);
      return false;
    }
  }

  /**
   * Pin CID to 3speak supernode
   */
  async pinToSupernode(cid) {
    try {
      const response = await httpPost(
        `${this.supernodeUrl}/api/v0/pin/add?arg=${cid}&progress=false`,
        {
          timeout: 60000, // 60s timeout for large files
          headers: { 'Content-Length': '0' }
        }
      );

      if (response.status !== 200) {
        throw new Error(`Supernode API error: ${response.status}`);
      }

      return response.data;
    } catch (error) {
      if (error.code === 'ECONNABORTED') {
        throw new Error('Supernode timeout (60s)');
      }
      if (error.code === 'ECONNREFUSED') {
        throw new Error('Supernode unreachable');
      }
      throw new Error(`Supernode pin failed: ${error.message}`);
    }
  }

  /**
   * Verify supernode has the pin
   */
  async verifySuperNodePin(cid) {
    try {
      const response = await httpPost(
        `${this.supernodeUrl}/api/v0/pin/ls?arg=${cid}`,
        {
          timeout: 10000,
          headers: { 'Content-Length': '0' }
        }
      );

      // Check if response contains the CID in pins
      const data = response.data;
      return data && data.Keys && data.Keys[cid];
    } catch (error) {
      console.warn(`[Migration] Supernode verification failed for ${cid}:`, error.message);
      return false;
    }
  }

  /**
   * Handle migration error with retry logic
   */
  async handleMigrationError(audio, error) {
    console.error(`❌ [Migration ${audio.permlink}] Failed:`, error.message);
    
    const retries = (audio.migration_retries || 0) + 1;

    if (retries >= this.maxRetries) {
      console.error(`[Migration ${audio.permlink}] Max retries exceeded (${this.maxRetries})`);
      await AudioMessage.markMigrationFailed(
        audio.permlink,
        error.message,
        true // Permanently failed
      );
    } else {
      console.log(`[Migration ${audio.permlink}] Will retry (${retries}/${this.maxRetries})`);
      await AudioMessage.markMigrationFailed(
        audio.permlink,
        error.message,
        false // Temporary failure, retry in 24h
      );
    }
  }

  /**
   * Get next scheduled run time
   */
  getNextRun() {
    return this.nextRunTime;
  }

  /**
   * Check if migration job is currently running
   */
  isJobRunning() {
    return this.isRunning;
  }
}

// Export singleton instance
const worker = new MigrationWorker();

module.exports = worker;
