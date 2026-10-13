/**
 * MP3 companion helpers
 *
 * Browser recordings arrive as WebM/Opus (Chrome, Firefox) which plays fine in
 * the 3speak player but not in Apple Podcasts and most classic podcast apps.
 * We keep the original untouched and add an MP3 next to it for RSS feeds.
 */

const { spawn, spawnSync } = require('child_process');

// Formats every podcast client already plays. Anything else gets an MP3.
const PODCAST_SAFE_FORMATS = ['mp3', 'm4a', 'mp4', 'aac'];

const MP3_BITRATE = process.env.MP3_BITRATE || '128k';

/**
 * Does an upload with this stored format need an MP3 companion?
 * Unknown or missing formats are converted: ffmpeg detects the real codec.
 */
function needsMp3(format) {
  const fmt = String(format || '').trim().toLowerCase();
  return !PODCAST_SAFE_FORMATS.includes(fmt);
}

/**
 * Length of the encoded output, from ffmpeg's last progress line
 * ("time=00:03:12.48"). Recorder WebM often carries no duration header, so the
 * input's "Duration: N/A" is useless; the encoder's own count is not.
 */
function parseFfmpegDuration(stderr) {
  const matches = [...String(stderr || '').matchAll(/time=(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/g)];
  if (matches.length === 0) return null;
  const [, h, m, s] = matches[matches.length - 1];
  const seconds = Number(h) * 3600 + Number(m) * 60 + Number(s);
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 100) / 100 : null;
}

/**
 * Find a working ffmpeg: FFMPEG_PATH, then the bundled ffmpeg-static binary,
 * then whatever is on PATH. Returns null when none runs, so the worker can stay
 * idle instead of marking every upload as failed.
 */
function resolveFfmpeg() {
  const candidates = [];
  if (process.env.FFMPEG_PATH) candidates.push(process.env.FFMPEG_PATH);
  try {
    const bundled = require('ffmpeg-static');
    if (bundled) candidates.push(bundled);
  } catch {
    // optional dependency not installed
  }
  candidates.push('ffmpeg');

  for (const bin of candidates) {
    const probe = spawnSync(bin, ['-hide_banner', '-version'], { timeout: 10000 });
    if (probe.status === 0) return bin;
  }
  return null;
}

/**
 * Encode inPath to a constant-bitrate MP3 at outPath.
 * CBR rather than VBR: podcast apps seek by byte offset, and CBR keeps the
 * position they compute right.
 * @returns {Promise<{ duration: number|null }>}
 */
function transcodeToMp3(ffmpegBin, inPath, outPath, { title, artist, timeoutMs = 15 * 60 * 1000 } = {}) {
  const args = [
    '-hide_banner', '-nostdin', '-y',
    '-i', inPath,
    '-vn',
    '-map_metadata', '-1',
    '-c:a', 'libmp3lame',
    '-b:a', MP3_BITRATE,
    '-ar', '44100',
    '-id3v2_version', '3',
  ];
  if (title) args.push('-metadata', `title=${title}`);
  if (artist) args.push('-metadata', `artist=${artist}`);
  args.push(outPath);

  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegBin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      stderr += chunk;
      // Keep the tail only: the last progress line is all we parse
      if (stderr.length > 64 * 1024) stderr = stderr.slice(-32 * 1024);
    });

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`ffmpeg timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const lastLine = stderr.trim().split('\n').pop() || '';
        return reject(new Error(`ffmpeg exited with ${code}: ${lastLine.slice(0, 300)}`));
      }
      resolve({ duration: parseFfmpegDuration(stderr) });
    });
  });
}

module.exports = {
  PODCAST_SAFE_FORMATS,
  MP3_BITRATE,
  needsMp3,
  parseFfmpegDuration,
  resolveFfmpeg,
  transcodeToMp3,
};
