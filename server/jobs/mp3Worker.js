/**
 * MP3 Worker
 * Adds an MP3 companion to every upload that podcast apps cannot play as-is
 * (WebM/Opus from browser recorders, OGG, WAV). The original stays untouched;
 * the MP3 is pinned next to it and stored as mp3_cid.
 *
 * Runs on every service start, and again after each upload. Every upload it
 * has looked at gets mp3_checked: true plus an mp3_status:
 *   converted   - mp3_cid / mp3_size / mp3_duration are set
 *   not_needed  - already mp3/m4a/aac
 *   failed      - gave up after MP3_MAX_ATTEMPTS (mp3_error says why)
 * Unchecked uploads are simply { mp3_checked: { $ne: true } }.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const AudioMessage = require('../models/AudioMessage');
const { needsMp3, resolveFfmpeg, transcodeToMp3, MP3_BITRATE } = require('../utils/mp3');

const CID_PATTERN = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|baf[a-z0-9]{50,})$/;

class Mp3Worker {
  constructor() {
    this.maxAttempts = parseInt(process.env.MP3_MAX_ATTEMPTS || '3');
    this.retryDelayMs = parseInt(process.env.MP3_RETRY_DELAY_MINUTES || '60') * 60 * 1000;
    this.fetchTimeoutMs = parseInt(process.env.MP3_FETCH_TIMEOUT_SECONDS || '300') * 1000;
    this.batchSize = 20;
    this.ffmpeg = null;
    this.isRunning = false;
    this.rerunRequested = false;
    this.stats = { converted: 0, not_needed: 0, failed: 0, retried: 0 };
  }

  /**
   * Called once at service start. Without a working ffmpeg the worker stays
   * idle and leaves every upload unchecked, so a later deploy picks them up.
   */
  start() {
    this.ffmpeg = resolveFfmpeg();
    if (!this.ffmpeg) {
      console.error('⚠️  [MP3] No working ffmpeg found (FFMPEG_PATH, ffmpeg-static, PATH). MP3 worker idle.');
      return;
    }
    console.log('🚀 MP3 Worker started');
    console.log(`   ffmpeg: ${this.ffmpeg}`);
    console.log(`   Bitrate: ${MP3_BITRATE} CBR`);
    this.kick();
  }

  /**
   * Process everything unchecked. Safe to call any time (e.g. after an upload):
   * if a run is in progress it runs once more when that one finishes.
   */
  kick() {
    if (!this.ffmpeg) return;
    if (this.isRunning) {
      this.rerunRequested = true;
      return;
    }
    this.run()
      .catch(err => console.error('❌ [MP3] Run failed:', err.message))
      .finally(() => {
        if (this.rerunRequested) {
          this.rerunRequested = false;
          this.kick();
        }
      });
  }

  async run() {
    this.isRunning = true;
    const startTime = Date.now();
    const runStats = { converted: 0, not_needed: 0, failed: 0, retried: 0 };
    // Anything that fails and is retried later must not come back in this run
    const seen = new Set();

    try {
      for (;;) {
        const batch = (await AudioMessage.findMp3Unchecked(this.batchSize))
          .filter(audio => !seen.has(audio.permlink));
        if (batch.length === 0) break;

        for (const audio of batch) {
          seen.add(audio.permlink);
          const outcome = await this.checkOne(audio);
          runStats[outcome]++;
          this.stats[outcome]++;
        }
      }

      const total = Object.values(runStats).reduce((a, b) => a + b, 0);
      if (total > 0) {
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[MP3] Run complete in ${duration}s: ${JSON.stringify(runStats)}`);
      }
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Check one upload and record the result.
   * @returns {'converted'|'not_needed'|'failed'|'retried'}
   */
  async checkOne(audio) {
    if (!needsMp3(audio.format)) {
      await AudioMessage.markMp3Checked(audio.permlink, { mp3_status: 'not_needed' });
      return 'not_needed';
    }

    try {
      const result = await this.convert(audio);
      await AudioMessage.markMp3Checked(audio.permlink, {
        mp3_status: 'converted',
        mp3_cid: result.cid,
        mp3_size: result.size,
        mp3_duration: result.duration,
        mp3_bitrate: MP3_BITRATE,
        mp3_error: null
      });
      console.log(`[MP3 ${audio.permlink}] ✓ ${audio.format} → mp3 ${result.cid} (${result.size} bytes)`);
      return 'converted';
    } catch (error) {
      const attempts = (audio.mp3_attempts || 0) + 1;
      const permanent = error.permanent || attempts >= this.maxAttempts;
      console.error(`❌ [MP3 ${audio.permlink}] Attempt ${attempts} failed: ${error.message}`);

      if (permanent) {
        await AudioMessage.markMp3Checked(audio.permlink, {
          mp3_status: 'failed',
          mp3_attempts: attempts,
          mp3_error: error.message
        });
        return 'failed';
      }
      await AudioMessage.markMp3Retry(
        audio.permlink,
        error.message,
        attempts,
        new Date(Date.now() + this.retryDelayMs)
      );
      return 'retried';
    }
  }

  /**
   * Fetch the original, encode, pin the MP3 locally.
   */
  async convert(audio) {
    if (!CID_PATTERN.test(audio.audio_cid || '')) {
      const err = new Error(`Invalid audio_cid: ${audio.audio_cid}`);
      err.permanent = true;
      throw err;
    }

    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'snapie-mp3-'));
    const inPath = path.join(dir, 'source');
    const outPath = path.join(dir, 'out.mp3');

    try {
      await this.fetchOriginal(audio.audio_cid, inPath);

      const { duration } = await transcodeToMp3(this.ffmpeg, inPath, outPath, {
        title: audio.title || undefined,
        artist: audio.owner || undefined
      });

      const { size } = await fsp.stat(outPath);
      if (size === 0) throw new Error('ffmpeg produced an empty file');

      const cid = await this.addToIpfs(outPath);
      return { cid, size, duration };
    } finally {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Read the original from the local node first (where uploads are pinned),
   * then from the gateways for anything the local node no longer has.
   */
  async fetchOriginal(cid, destPath) {
    const errors = [];

    try {
      const ipfs = await this.ipfsClient();
      await pipeline(
        Readable.from(ipfs.cat(cid, { timeout: this.fetchTimeoutMs })),
        fs.createWriteStream(destPath)
      );
      return;
    } catch (error) {
      errors.push(`local: ${error.message}`);
    }

    const gateways = [
      process.env.IPFS_PRIMARY_GATEWAY,
      process.env.IPFS_SUPERNODE_URL || 'https://ipfs.3speak.tv',
      process.env.IPFS_FALLBACK_GATEWAY_1,
      process.env.IPFS_FALLBACK_GATEWAY_2
    ].filter(Boolean).map(gw => gw.replace(/\/+$/, '').replace(/\/ipfs$/, ''));

    for (const gateway of [...new Set(gateways)]) {
      try {
        const response = await fetch(`${gateway}/ipfs/${cid}`, {
          signal: AbortSignal.timeout(this.fetchTimeoutMs)
        });
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
        await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destPath));
        return;
      } catch (error) {
        errors.push(`${gateway}: ${error.message}`);
      }
    }

    throw new Error(`Could not fetch original (${errors.join('; ')})`);
  }

  async addToIpfs(filePath) {
    const ipfs = await this.ipfsClient();
    const { cid } = await ipfs.add(fs.createReadStream(filePath), { pin: true });
    const mp3Cid = cid.toString();

    // Same check as uploads: never store a CID the node has not pinned
    for await (const pin of ipfs.pin.ls({ paths: [cid] })) {
      if (pin.cid.toString() === mp3Cid) return mp3Cid;
    }
    throw new Error(`MP3 pin not found after add: ${mp3Cid}`);
  }

  async ipfsClient() {
    if (!this.ipfs) {
      const { create } = await import('ipfs-http-client');
      this.ipfs = create({ url: process.env.IPFS_API_URL || 'http://127.0.0.1:5001' });
    }
    return this.ipfs;
  }

  getStatus() {
    return {
      enabled: !!this.ffmpeg,
      ffmpeg: this.ffmpeg,
      running: this.isRunning,
      sinceStart: this.stats
    };
  }
}

// Export singleton instance
const worker = new Mp3Worker();

module.exports = worker;
