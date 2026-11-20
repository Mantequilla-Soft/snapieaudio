/**
 * The real length of an uploaded audio file, measured on the server.
 *
 * The upload's `duration` field is what the client says; the free-account
 * length limit must not rest on that alone. ffprobe reads the container's
 * duration (FFPROBE_PATH, else `ffprobe` on PATH). Browser recordings (WebM
 * from MediaRecorder) often carry none, and the box may have no ffprobe at all
 * (the bundled ffmpeg-static has none), so the fallback decodes the file with
 * ffmpeg to nothing and reads the last progress time, like the MP3 worker.
 *
 * Returns seconds, or null when it could not be measured: the caller then
 * goes by the declared value.
 */
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { resolveFfmpeg, parseFfmpegDuration } = require('./mp3');

const PROBE_TIMEOUT_MS = 60 * 1000;

function run(bin, args, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      return resolve(null);
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; if (stdout.length > 65536) stdout = stdout.slice(-65536); });
    child.stderr.on('data', (d) => { stderr += d; if (stderr.length > 65536) stderr = stderr.slice(-65536); });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

const positive = (n) => (Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null);

async function ffprobeDuration(file) {
  const out = await run(process.env.FFPROBE_PATH || 'ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file,
  ]);
  if (!out || out.code !== 0) return null;
  return positive(parseFloat(String(out.stdout).trim()));
}

let ffmpegBin; // undefined = not looked for yet
async function ffmpegDecodeDuration(file) {
  if (ffmpegBin === undefined) ffmpegBin = resolveFfmpeg();
  if (!ffmpegBin) return null;
  const out = await run(ffmpegBin, ['-hide_banner', '-nostdin', '-i', file, '-vn', '-f', 'null', '-']);
  if (!out || out.code !== 0) return null;
  return positive(parseFfmpegDuration(out.stderr));
}

/** Seconds of audio in `buffer`, or null. `ext` only names the temp file. */
async function probeDuration(buffer, ext = 'bin') {
  if (!buffer || !buffer.length) return null;
  const safeExt = String(ext || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'bin';
  const file = path.join(os.tmpdir(), `snapieaudio-probe-${crypto.randomBytes(8).toString('hex')}.${safeExt}`);
  try {
    await fs.writeFile(file, buffer);
    return (await ffprobeDuration(file)) ?? (await ffmpegDecodeDuration(file));
  } catch (err) {
    console.warn('[audioDuration] probe failed:', err.message);
    return null;
  } finally {
    fs.unlink(file).catch(() => {});
  }
}

/** The length the limit goes by: the larger of declared and measured. */
function effectiveDuration(declared, probed) {
  const d = Number(declared);
  const values = [Number.isFinite(d) && d > 0 ? d : null, probed].filter((v) => v !== null && v !== undefined);
  return values.length ? Math.max(...values) : null;
}

module.exports = { probeDuration, effectiveDuration, ffprobeDuration, ffmpegDecodeDuration };
