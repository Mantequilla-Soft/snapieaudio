/**
 * Audio upload limits for free accounts.
 *
 * Owner's rules: an account without 3Speak Pro may upload at most
 * AUDIO_LIMIT_PER_DAY audio files (default 2) per rolling 24 hours, each at most
 * AUDIO_MAX_DURATION_SECONDS long (default 900 = 15 minutes).
 *
 * Exempt:
 *   - 3Speak Pro: `embed-users.premium === true` (kept in sync by the checker's
 *     premiumSubsSync), honouring `premium_expires_at` for one-day passes.
 *   - Warm-up accounts: people in the incubation programme who have no Hive
 *     account yet and upload under their bare handle. The checker's
 *     POST /incubation/authors must call the handle `incubating` with no Hive
 *     username, AND Hive must have no account of that name, so a Hive account
 *     holder cannot pass as a warm-up user.
 *   - AUDIO_LIMIT_EXEMPT: a comma list of usernames.
 *
 * Podcast RSS imports by the 3Speak web server are never counted or refused:
 * they arrive with one of AUDIO_IMPORT_API_KEYS (a server-only key, never the
 * public browser key) plus `X-Upload-Source: rss_import`, and their rows carry
 * `upload_source: "rss_import"`, which the count leaves out.
 *
 * Every lookup FAILS OPEN: if Mongo, the checker or Hive cannot answer, the
 * upload goes through. AUDIO_DAILY_LIMITS_ENABLED=false switches it all off.
 */
const AudioMessage = require('../models/AudioMessage');

const WINDOW_MS = 24 * 60 * 60 * 1000;
const DURATION_GRACE_SECONDS = 1; // a 15:00.4 file is still "15 minutes"
const IMPORT_SOURCE = 'rss_import';
const PRO_TTL_MS = 60 * 1000;
const WARMUP_TTL_MS = 5 * 60 * 1000;
const LOOKUP_FAIL_TTL_MS = 30 * 1000;
const CACHE_MAX = 5000;

const intEnv = (raw, fallback, min) => {
  const n = Number.parseInt(String(raw ?? '').trim(), 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
};
const list = (raw) => String(raw || '').split(',').map((s) => s.trim()).filter(Boolean);
const norm = (u) => String(u || '').trim().toLowerCase().replace(/^@/, '');

/** Settings, read on every call so a test (or a restart) sees the env as it is. */
function config(env = process.env) {
  return {
    // Enforced unless explicitly switched off (owner, 2026-11-20).
    enabled: String(env.AUDIO_DAILY_LIMITS_ENABLED ?? '').trim().toLowerCase() !== 'false',
    perDay: intEnv(env.AUDIO_LIMIT_PER_DAY, 2, 0),
    maxSeconds: intEnv(env.AUDIO_MAX_DURATION_SECONDS, 900, 1),
    exempt: new Set(list(env.AUDIO_LIMIT_EXEMPT).map(norm)),
    importKeys: new Set(list(env.AUDIO_IMPORT_API_KEYS)),
    proCollection: env.AUDIO_PRO_USERS_COLLECTION || 'embed-users',
    checkerUrl: (env.CHECKER_URL || 'https://checker.3speak.tv').replace(/\/+$/, ''),
    hiveNodes: list(env.HIVE_API_NODES || 'https://api.hive.blog,https://api.deathwing.me,https://api.openhive.network'),
    upgradeUrl: env.AUDIO_UPGRADE_URL || 'https://3speak.tv/wallet/{user}#pro',
  };
}

/** A server-side podcast RSS import: a trusted import key AND the import marker. */
function isImportUpload(req, cfg = config()) {
  const key = req.headers?.['x-api-key'] || req.query?.api_key;
  if (!key || !cfg.importKeys.has(key)) return false;
  return String(req.headers?.['x-upload-source'] || '').trim().toLowerCase() === IMPORT_SOURCE;
}

/** The uploader named by the request (X-User header, or ?owner= on the quota route). */
function requestUser(req, { allowQuery = false } = {}) {
  const raw = req.headers?.['x-user'] || (allowQuery ? req.query?.owner : '') || '';
  const user = String(raw).trim();
  return user && user !== 'anonymous' ? user : null;
}

// ── small TTL caches ─────────────────────────────────────────────────────────
function makeCache() {
  const map = new Map();
  return {
    get(key) {
      const hit = map.get(key);
      if (!hit) return undefined;
      if (Date.now() > hit.until) { map.delete(key); return undefined; }
      return hit.value;
    },
    set(key, value, ttl) {
      map.set(key, { value, until: Date.now() + ttl });
      while (map.size > CACHE_MAX) map.delete(map.keys().next().value);
    },
    clear() { map.clear(); },
  };
}
const proCache = makeCache();
const warmupCache = makeCache();

// ── lookups (on module.exports so tests can replace them) ────────────────────
async function getDb() {
  return AudioMessage.connectDB();
}

/** true / false, or null when it could not be told (fail open). */
async function isPro(user, cfg = config()) {
  const key = norm(user);
  const cached = proCache.get(key);
  if (cached !== undefined) return cached;
  try {
    const db = await exported.getDb();
    const row = await db.collection(cfg.proCollection).findOne(
      { username: key },
      { projection: { _id: 0, premium: 1, premium_expires_at: 1 } },
    );
    const exp = row?.premium_expires_at ? new Date(row.premium_expires_at).getTime() : null;
    const pro = !!(row && row.premium === true && (!exp || !Number.isFinite(exp) || exp > Date.now()));
    proCache.set(key, pro, PRO_TTL_MS);
    return pro;
  } catch (err) {
    console.warn(`[audioLimits] Pro lookup for ${key} failed, not limiting: ${err.message}`);
    proCache.set(key, null, LOOKUP_FAIL_TTL_MS);
    return null;
  }
}

async function postJson(url, body, timeoutMs = 5000) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Does a Hive account of this name exist? Tries each node in turn. */
async function hiveAccountExists(name, cfg = config()) {
  let lastError;
  for (const node of cfg.hiveNodes) {
    try {
      const out = await postJson(node, { jsonrpc: '2.0', id: 1, method: 'condenser_api.get_accounts', params: [[name]] }, 6000);
      if (!Array.isArray(out?.result)) throw new Error(out?.error?.message || 'no result');
      return out.result.some((a) => norm(a?.name) === name);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('no Hive node');
}

/** true / false, or null when it could not be told (fail open). */
async function isWarmup(user, cfg = config()) {
  const key = norm(user);
  const cached = warmupCache.get(key);
  if (cached !== undefined) return cached;
  try {
    const out = await postJson(`${cfg.checkerUrl}/incubation/authors`, { handles: [key] });
    const author = out?.authors?.[key];
    let warmup = !!(author && author.status === 'incubating' && !author.hiveUsername);
    // An incubating handle that is also a Hive account name is that Hive
    // account uploading: it does not get the warm-up exemption.
    if (warmup && (await exported.hiveAccountExists(key, cfg))) warmup = false;
    warmupCache.set(key, warmup, WARMUP_TTL_MS);
    return warmup;
  } catch (err) {
    console.warn(`[audioLimits] warm-up lookup for ${key} failed, not limiting: ${err.message}`);
    warmupCache.set(key, null, LOOKUP_FAIL_TTL_MS);
    return null;
  }
}

/**
 * Why (if at all) this user is not limited.
 * → { exempt, reason: 'pro' | 'warmup' | 'listed' | 'disabled' | 'lookup_failed' | null }
 */
async function exemption(user, cfg = config()) {
  if (!cfg.enabled) return { exempt: true, reason: 'disabled' };
  const key = norm(user);
  if (cfg.exempt.has(key)) return { exempt: true, reason: 'listed' };
  const pro = await exported.isPro(key, cfg);
  if (pro === true) return { exempt: true, reason: 'pro' };
  const warmup = await exported.isWarmup(key, cfg);
  if (warmup === true) return { exempt: true, reason: 'warmup' };
  if (pro === null || warmup === null) return { exempt: true, reason: 'lookup_failed' };
  return { exempt: false, reason: null };
}

/**
 * The upload dates (oldest first) that count against the user's last 24 hours:
 * rows actually written for this owner, RSS imports left out. Uses the
 * { owner: 1, createdAt: -1 } index the model already creates.
 */
async function countedUploads(user, now = Date.now()) {
  const db = await exported.getDb();
  const owners = [...new Set([String(user).trim(), norm(user)])];
  const rows = await db.collection(AudioMessage.getAudioCollectionName())
    .find(
      { owner: { $in: owners }, createdAt: { $gte: new Date(now - WINDOW_MS) }, upload_source: { $ne: IMPORT_SOURCE } },
      { projection: { _id: 0, createdAt: 1 } },
    )
    .sort({ createdAt: 1 })
    .limit(500)
    .toArray();
  return rows.map((r) => new Date(r.createdAt).getTime()).filter(Number.isFinite);
}

/** ISO time to the second, rounded up so it is never a moment too early. */
const isoSeconds = (ms) => new Date(Math.ceil(ms / 1000) * 1000).toISOString().replace(/\.000Z$/, 'Z');

/**
 * The quota from the counted upload dates.
 * next_at: when the next slot frees up (the oldest counted upload leaves the
 * 24-hour window). With nothing left, that is when the next upload is possible.
 */
function quota(dates, cfg = config(), now = Date.now()) {
  const used = dates.length;
  const remaining = Math.max(0, cfg.perDay - used);
  let nextAt = null;
  if (used > 0) {
    const freeing = used >= cfg.perDay ? dates[used - cfg.perDay] : dates[0];
    nextAt = freeing !== undefined ? freeing + WINDOW_MS : now;
  }
  return { limit: cfg.perDay, used, remaining, next_at: nextAt === null ? null : isoSeconds(nextAt) };
}

function plural(n, one) {
  return `${n} ${one}${n === 1 ? '' : 's'}`;
}

/** "15 minutes", "22 minutes 30 seconds", "45 seconds". */
function formatLength(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m === 0) return plural(s, 'second');
  return s ? `${plural(m, 'minute')} ${plural(s, 'second')}` : plural(m, 'minute');
}

const upgradeUrlFor = (user, cfg) => cfg.upgradeUrl.replace('{user}', encodeURIComponent(norm(user)));

/** 413 body: the file is longer than a free account may upload. */
function tooLongBody(user, duration, cfg = config()) {
  const rounded = Math.round(duration);
  return {
    error: 'Audio too long',
    code: 'audio_too_long',
    message: `Free accounts can upload audio up to ${formatLength(cfg.maxSeconds)} long. `
      + `This file is ${formatLength(rounded)}. 3Speak Pro removes this limit.`,
    max_seconds: cfg.maxSeconds,
    duration: rounded,
    upgrade_url: upgradeUrlFor(user, cfg),
  };
}

/** 429 body + Retry-After seconds: the daily count is used up. */
function dailyLimitBody(user, q, cfg = config(), now = Date.now()) {
  const nextMs = q.next_at ? Date.parse(q.next_at) : now + WINDOW_MS;
  const retryAfter = Math.max(1, Math.ceil((nextMs - now) / 1000));
  const files = cfg.perDay === 1 ? '1 audio file' : `${cfg.perDay} audio files`;
  return {
    error: 'Daily audio upload limit reached',
    code: 'daily_audio_limit',
    message: `Free accounts can upload ${files} per 24 hours. `
      + `Your next audio upload is possible at ${q.next_at || isoSeconds(nextMs)}. 3Speak Pro removes this limit.`,
    limit: q.limit,
    used: q.used,
    next_at: q.next_at || isoSeconds(nextMs),
    retry_after_seconds: retryAfter,
    upgrade_url: upgradeUrlFor(user, cfg),
  };
}

function sendDailyLimit(res, user, q, cfg) {
  const body = dailyLimitBody(user, q, cfg);
  res.set?.('Retry-After', String(body.retry_after_seconds));
  return res.status(429).json(body);
}

/**
 * Upload gate, BEFORE multer reads the file: refuses a user whose daily count
 * is used up (nothing is stored or pinned), and tells the controller whether
 * the duration limit applies (req.audioLimit).
 */
async function uploadGate(req, res, next) {
  const cfg = config();
  req.audioLimit = { limited: false, reason: 'disabled', source: 'upload' };
  if (isImportUpload(req, cfg)) {
    req.audioLimit = { limited: false, reason: 'rss_import', source: IMPORT_SOURCE };
    return next();
  }
  const user = requestUser(req);
  if (!cfg.enabled || !user) return next(); // the controller answers a missing user
  try {
    const ex = await exported.exemption(user, cfg);
    if (ex.exempt) {
      req.audioLimit = { limited: false, reason: ex.reason, source: 'upload' };
      return next();
    }
    const q = quota(await exported.countedUploads(user), cfg);
    if (q.remaining <= 0) return sendDailyLimit(res, user, q, cfg);
    req.audioLimit = { limited: true, reason: null, source: 'upload' };
    return next();
  } catch (err) {
    console.warn(`[audioLimits] upload gate for ${user} failed, not limiting: ${err.message}`);
    req.audioLimit = { limited: false, reason: 'lookup_failed', source: 'upload' };
    return next();
  }
}

/**
 * Called by the controller after the file is in, before it is pinned: the
 * duration check (larger of declared and probed) and a second look at the
 * count (two uploads started at once both passed the gate).
 * → null to go on, or true when it has answered the request.
 */
async function checkBeforeStore(req, res, { user, duration }) {
  const cfg = config();
  if (!req.audioLimit?.limited || !cfg.enabled) return null;
  if (Number.isFinite(duration) && duration > cfg.maxSeconds + DURATION_GRACE_SECONDS) {
    res.status(413).json(tooLongBody(user, duration, cfg));
    return true;
  }
  try {
    const q = quota(await exported.countedUploads(user), cfg);
    if (q.remaining <= 0) {
      sendDailyLimit(res, user, q, cfg);
      return true;
    }
  } catch (err) {
    console.warn(`[audioLimits] recount for ${user} failed, not limiting: ${err.message}`);
  }
  return null;
}

/** GET /api/audio/quota */
async function quotaRoute(req, res) {
  const cfg = config();
  const user = requestUser(req, { allowQuery: true });
  if (!user) {
    return res.status(400).json({ error: 'Username required', message: 'Pass the X-User header or ?owner=' });
  }
  const unlimited = (used) => ({ limit: null, used, remaining: null, next_at: null, max_seconds: null });
  if (!cfg.enabled) {
    return res.json({ enabled: false, exempt: true, reason: null, audio: unlimited(0) });
  }
  try {
    const ex = await exported.exemption(user, cfg);
    const dates = await exported.countedUploads(user).catch(() => null);
    if (ex.exempt) {
      const reason = ['pro', 'warmup', 'listed'].includes(ex.reason) ? ex.reason : null;
      return res.json({ enabled: true, exempt: true, reason, audio: unlimited(dates ? dates.length : 0) });
    }
    if (!dates) throw new Error('count failed');
    return res.json({ enabled: true, exempt: false, reason: null, audio: { ...quota(dates, cfg), max_seconds: cfg.maxSeconds } });
  } catch (err) {
    console.warn(`[audioLimits] quota for ${user} failed: ${err.message}`);
    // Fail open, like the upload itself.
    return res.json({ enabled: true, exempt: true, reason: null, audio: unlimited(0) });
  }
}

function clearCaches() {
  proCache.clear();
  warmupCache.clear();
}

const exported = {
  WINDOW_MS,
  IMPORT_SOURCE,
  config,
  isImportUpload,
  requestUser,
  getDb,
  isPro,
  isWarmup,
  hiveAccountExists,
  exemption,
  countedUploads,
  quota,
  formatLength,
  tooLongBody,
  dailyLimitBody,
  uploadGate,
  checkBeforeStore,
  quotaRoute,
  clearCaches,
};

module.exports = exported;
