// Free-account audio upload limits (server/utils/audioLimits.js,
// server/utils/audioDuration.js and their use in uploadAudio). No test here
// touches Mongo, the checker or Hive: every lookup is replaced.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const limits = require('./utils/audioLimits');
const audioDuration = require('./utils/audioDuration');
const audioController = require('./controllers/audioController');
const ContentCreator = require('./models/ContentCreator');
const AudioMessage = require('./models/AudioMessage');

const ENV_KEYS = [
  'AUDIO_DAILY_LIMITS_ENABLED', 'AUDIO_LIMIT_PER_DAY', 'AUDIO_MAX_DURATION_SECONDS', 'AUDIO_LIMIT_EXEMPT',
  'AUDIO_IMPORT_API_KEYS', 'AUDIO_UPGRADE_URL', 'CHECKER_URL', 'HIVE_API_NODES', 'IPFS_API_URL', 'FFPROBE_PATH',
];
const HOUR = 60 * 60 * 1000;

function withEnv(t, values) {
  const saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, values);
  limits.clearCaches();
  t.after(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    limits.clearCaches();
  });
}

function createResponse() {
  return {
    statusCode: 200, body: null, headers: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    set(name, value) { this.headers[name] = value; return this; },
  };
}

const uploadReq = (headers = {}) => ({ headers: { 'x-api-key': 'public-key', 'x-user': 'alice', ...headers }, query: {} });

/** A free user: not listed, not Pro, not warm-up, with these upload dates. */
function freeUser(t, dates = []) {
  t.mock.method(limits, 'isPro', async () => false);
  t.mock.method(limits, 'isWarmup', async () => false);
  return t.mock.method(limits, 'countedUploads', async () => dates);
}

async function runGate(req) {
  const res = createResponse();
  let nextCalled = false;
  await limits.uploadGate(req, res, () => { nextCalled = true; });
  return { res, nextCalled };
}

// ── config ───────────────────────────────────────────────────────────────────

test('limits are on by default with 2 per day and 15 minutes', (t) => {
  withEnv(t, {});
  const cfg = limits.config();
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.perDay, 2);
  assert.equal(cfg.maxSeconds, 900);
});

test('AUDIO_DAILY_LIMITS_ENABLED=false is the kill switch; other values keep it on', (t) => {
  withEnv(t, { AUDIO_DAILY_LIMITS_ENABLED: 'false' });
  assert.equal(limits.config().enabled, false);
  process.env.AUDIO_DAILY_LIMITS_ENABLED = 'FALSE';
  assert.equal(limits.config().enabled, false);
  process.env.AUDIO_DAILY_LIMITS_ENABLED = 'true';
  assert.equal(limits.config().enabled, true);
  process.env.AUDIO_DAILY_LIMITS_ENABLED = '';
  assert.equal(limits.config().enabled, true);
});

test('env values are parsed, bad ones fall back to the defaults', (t) => {
  withEnv(t, { AUDIO_LIMIT_PER_DAY: '5', AUDIO_MAX_DURATION_SECONDS: 'abc', AUDIO_LIMIT_EXEMPT: ' @Bob , carol ,' });
  const cfg = limits.config();
  assert.equal(cfg.perDay, 5);
  assert.equal(cfg.maxSeconds, 900);
  assert.deepEqual([...cfg.exempt], ['bob', 'carol']);
});

// ── quota math ───────────────────────────────────────────────────────────────

test('quota: next_at is when the oldest counted upload leaves the 24 hours', (t) => {
  withEnv(t, {});
  const now = Date.parse('2026-11-20T12:00:00Z');
  assert.deepEqual(limits.quota([], limits.config(), now), { limit: 2, used: 0, remaining: 2, next_at: null });
  const one = limits.quota([now - 2 * HOUR], limits.config(), now);
  assert.equal(one.remaining, 1);
  assert.equal(one.next_at, '2026-11-21T10:00:00Z');
  const full = limits.quota([now - 5 * HOUR, now - 1 * HOUR], limits.config(), now);
  assert.equal(full.remaining, 0);
  assert.equal(full.next_at, '2026-11-21T07:00:00Z');
  // over the limit (a limit lowered later): the second-oldest frees the next slot
  const over = limits.quota([now - 9 * HOUR, now - 5 * HOUR, now - 1 * HOUR], limits.config(), now);
  assert.equal(over.remaining, 0);
  assert.equal(over.next_at, '2026-11-21T07:00:00Z');
});

test('formatLength reads like a sentence', () => {
  assert.equal(limits.formatLength(900), '15 minutes');
  assert.equal(limits.formatLength(1320), '22 minutes');
  assert.equal(limits.formatLength(1350.4), '22 minutes 30 seconds');
  assert.equal(limits.formatLength(61), '1 minute 1 second');
  assert.equal(limits.formatLength(45), '45 seconds');
});

// ── the count query ──────────────────────────────────────────────────────────

test('countedUploads counts this owner in the last 24 hours and leaves RSS imports out', async (t) => {
  withEnv(t, {});
  let seen = null;
  const fakeDb = {
    collection: (name) => ({
      find: (query, options) => {
        seen = { name, query, options };
        const chain = { sort: () => chain, limit: () => chain, toArray: async () => [{ createdAt: new Date('2026-11-20T01:00:00Z') }] };
        return chain;
      },
    }),
  };
  t.mock.method(limits, 'getDb', async () => fakeDb);
  const now = Date.parse('2026-11-20T12:00:00Z');
  const dates = await limits.countedUploads('Alice', now);
  assert.deepEqual(dates, [Date.parse('2026-11-20T01:00:00Z')]);
  assert.equal(seen.name, AudioMessage.getAudioCollectionName());
  assert.deepEqual(seen.query.owner, { $in: ['Alice', 'alice'] });
  assert.equal(seen.query.createdAt.$gte.getTime(), now - 24 * HOUR);
  assert.deepEqual(seen.query.upload_source, { $ne: 'rss_import' });
});

// ── upload gate (before the file is read) ────────────────────────────────────

test('gate: a free user under the limit goes on, marked limited', async (t) => {
  withEnv(t, {});
  freeUser(t, [Date.now() - HOUR]);
  const req = uploadReq();
  const { nextCalled } = await runGate(req);
  assert.equal(nextCalled, true);
  assert.deepEqual(req.audioLimit, { limited: true, reason: null, source: 'upload' });
});

test('gate: the third upload in 24 hours is refused with 429 and the full contract', async (t) => {
  withEnv(t, {});
  const first = Date.now() - 20 * HOUR;
  freeUser(t, [first, Date.now() - HOUR]);
  const { res, nextCalled } = await runGate(uploadReq());
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 429);
  const b = res.body;
  assert.equal(b.code, 'daily_audio_limit');
  assert.equal(b.error, 'Daily audio upload limit reached');
  assert.equal(b.limit, 2);
  assert.equal(b.used, 2);
  assert.match(b.next_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.ok(Math.abs(Date.parse(b.next_at) - (first + 24 * HOUR)) <= 1000);
  assert.ok(b.retry_after_seconds > 4 * 3600 - 5 && b.retry_after_seconds <= 4 * 3600 + 1);
  assert.equal(res.headers['Retry-After'], String(b.retry_after_seconds));
  assert.equal(b.upgrade_url, 'https://3speak.tv/wallet/alice#pro');
  assert.equal(b.message, `Free accounts can upload 2 audio files per 24 hours. Your next audio upload is possible at ${b.next_at}. 3Speak Pro removes this limit.`);
});

test('gate: Pro, warm-up and listed users are exempt and never counted', async (t) => {
  withEnv(t, { AUDIO_LIMIT_EXEMPT: 'listeduser' });
  const count = t.mock.method(limits, 'countedUploads', async () => [1, 2, 3]);
  const pro = t.mock.method(limits, 'isPro', async (u) => u === 'prouser');
  t.mock.method(limits, 'isWarmup', async (u) => u === 'warmupuser');

  for (const [user, reason] of [['prouser', 'pro'], ['warmupuser', 'warmup'], ['ListedUser', 'listed']]) {
    const req = uploadReq({ 'x-user': user });
    const { nextCalled } = await runGate(req);
    assert.equal(nextCalled, true, user);
    assert.deepEqual(req.audioLimit, { limited: false, reason, source: 'upload' });
  }
  assert.equal(count.mock.callCount(), 0);
  // the listed user is never even looked up
  assert.ok(!pro.mock.calls.some((c) => c.arguments[0] === 'listeduser'));
});

test('gate: an RSS import with the import key is never counted or refused', async (t) => {
  withEnv(t, { AUDIO_IMPORT_API_KEYS: 'server-import-key' });
  const count = freeUser(t, [1, 2, 3]);
  const req = uploadReq({ 'x-api-key': 'server-import-key', 'x-upload-source': 'rss_import' });
  const { nextCalled } = await runGate(req);
  assert.equal(nextCalled, true);
  assert.deepEqual(req.audioLimit, { limited: false, reason: 'rss_import', source: 'rss_import' });
  assert.equal(count.mock.callCount(), 0);
});

test('gate: the import marker with the public key, or the import key without it, is a normal upload', async (t) => {
  withEnv(t, { AUDIO_IMPORT_API_KEYS: 'server-import-key' });
  freeUser(t, [Date.now() - 2 * HOUR, Date.now() - HOUR]);
  const spoofed = await runGate(uploadReq({ 'x-upload-source': 'rss_import' }));
  assert.equal(spoofed.res.statusCode, 429);
  // Narrate / automations on the web server use the import key but no marker: counted
  const automation = await runGate(uploadReq({ 'x-api-key': 'server-import-key' }));
  assert.equal(automation.res.statusCode, 429);
});

test('gate: switched off, nothing is looked up', async (t) => {
  withEnv(t, { AUDIO_DAILY_LIMITS_ENABLED: 'false' });
  const count = freeUser(t, [1, 2, 3]);
  const req = uploadReq();
  const { nextCalled } = await runGate(req);
  assert.equal(nextCalled, true);
  assert.equal(req.audioLimit.limited, false);
  assert.equal(count.mock.callCount(), 0);
  assert.equal(limits.isPro.mock.callCount(), 0);
});

test('gate: fails open when a lookup or the count fails', async (t) => {
  withEnv(t, {});
  t.mock.method(limits, 'isPro', async () => null); // Mongo did not answer
  t.mock.method(limits, 'isWarmup', async () => false);
  t.mock.method(limits, 'countedUploads', async () => [1, 2, 3]);
  const a = uploadReq();
  assert.equal((await runGate(a)).nextCalled, true);
  assert.equal(a.audioLimit.limited, false);

  limits.isPro.mock.mockImplementation(async () => false);
  limits.countedUploads.mock.mockImplementation(async () => { throw new Error('mongo down'); });
  const b = uploadReq();
  assert.equal((await runGate(b)).nextCalled, true);
  assert.equal(b.audioLimit.limited, false);
});

// ── Pro and warm-up lookups ──────────────────────────────────────────────────

function fakeUsersDb(row, onQuery = () => {}) {
  return { collection: (name) => ({ findOne: async (q) => { onQuery(name, q); return row; } }) };
}

test('isPro reads embed-users.premium and honours premium_expires_at', async (t) => {
  withEnv(t, {});
  let seen;
  t.mock.method(limits, 'getDb', async () => fakeUsersDb({ premium: true }, (name, q) => { seen = { name, q }; }));
  assert.equal(await limits.isPro('@Alice'), true);
  assert.deepEqual(seen, { name: 'embed-users', q: { username: 'alice' } });

  limits.clearCaches();
  limits.getDb.mock.mockImplementation(async () => fakeUsersDb({ premium: true, premium_expires_at: new Date(Date.now() - 1000) }));
  assert.equal(await limits.isPro('alice'), false);

  limits.clearCaches();
  limits.getDb.mock.mockImplementation(async () => fakeUsersDb(null));
  assert.equal(await limits.isPro('alice'), false);

  limits.clearCaches();
  limits.getDb.mock.mockImplementation(async () => { throw new Error('down'); });
  assert.equal(await limits.isPro('alice'), null);
});

function mockFetch(t, handler) {
  return t.mock.method(globalThis, 'fetch', async (url, init) => {
    const out = await handler(String(url), JSON.parse(init.body));
    if (out instanceof Error) throw out;
    return { ok: true, status: 200, json: async () => out };
  });
}

test('isWarmup: incubating on the checker and no Hive account of that name', async (t) => {
  withEnv(t, { CHECKER_URL: 'https://checker.test', HIVE_API_NODES: 'https://hive.test' });
  const calls = mockFetch(t, (url, body) => {
    if (url === 'https://checker.test/incubation/authors') {
      assert.deepEqual(body, { handles: ['newbie'] });
      return { authors: { newbie: { status: 'incubating', hiveUsername: null } } };
    }
    assert.equal(body.method, 'condenser_api.get_accounts');
    return { result: [] };
  });
  assert.equal(await limits.isWarmup('newbie'), true);
  assert.equal(calls.mock.callCount(), 2);
  // cached: no second lookup
  assert.equal(await limits.isWarmup('newbie'), true);
  assert.equal(calls.mock.callCount(), 2);
});

test('isWarmup: a Hive account holder cannot pass as a warm-up user', async (t) => {
  withEnv(t, { CHECKER_URL: 'https://checker.test', HIVE_API_NODES: 'https://hive.test' });
  mockFetch(t, (url) => (url.startsWith('https://checker.test')
    ? { authors: { alice: { status: 'incubating', hiveUsername: null } } }
    : { result: [{ name: 'alice' }] }));
  assert.equal(await limits.isWarmup('alice'), false);
});

test('isWarmup: graduated, unknown or with a Hive username is not warm-up', async (t) => {
  withEnv(t, { CHECKER_URL: 'https://checker.test' });
  const authors = {
    grad: { status: 'graduated', hiveUsername: null },
    linked: { status: 'incubating', hiveUsername: 'linked' },
  };
  mockFetch(t, (url, body) => ({ authors: { [body.handles[0]]: authors[body.handles[0]] } }));
  assert.equal(await limits.isWarmup('grad'), false);
  assert.equal(await limits.isWarmup('linked'), false);
  assert.equal(await limits.isWarmup('nobody'), false);
});

test('isWarmup fails open (null) when the checker does not answer', async (t) => {
  withEnv(t, { CHECKER_URL: 'https://checker.test' });
  mockFetch(t, () => new Error('ECONNREFUSED'));
  t.mock.method(limits, 'isPro', async () => false);
  assert.equal(await limits.isWarmup('someone'), null);
  const ex = await limits.exemption('someone');
  assert.deepEqual(ex, { exempt: true, reason: 'lookup_failed' });
});

// ── duration ─────────────────────────────────────────────────────────────────

test('effectiveDuration takes the larger of declared and probed', () => {
  assert.equal(audioDuration.effectiveDuration('300', 1320.5), 1320.5);
  assert.equal(audioDuration.effectiveDuration('1000', 600), 1000);
  assert.equal(audioDuration.effectiveDuration('300', null), 300);
  assert.equal(audioDuration.effectiveDuration('nope', 42), 42);
  assert.equal(audioDuration.effectiveDuration('0', null), null);
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

test('probeDuration measures a real file, with ffprobe and with the ffmpeg fallback', { skip: !hasFfmpeg && 'no ffmpeg on this machine' }, async (t) => {
  withEnv(t, {});
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audiolimits-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'tone.ogg');
  const made = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:a', 'libvorbis', file]);
  assert.equal(made.status, 0, String(made.stderr));
  const buf = fs.readFileSync(file);

  const probed = await audioDuration.probeDuration(buf, 'ogg');
  assert.ok(probed > 2.8 && probed < 3.2, `probed ${probed}`);

  process.env.FFPROBE_PATH = path.join(dir, 'no-such-ffprobe');
  const decoded = await audioDuration.probeDuration(buf, 'ogg');
  assert.ok(decoded > 2.8 && decoded < 3.2, `decoded ${decoded}`);

  assert.equal(await audioDuration.probeDuration(Buffer.from('not audio at all'), 'mp3'), null);
});

// ── uploadAudio with the limits ──────────────────────────────────────────────

function controllerReq(audioLimit, body = {}) {
  return {
    headers: { 'x-user': 'alice', 'x-api-key': 'public-key' },
    body: { duration: '300', format: 'webm', ...body },
    file: { buffer: Buffer.from('fake'), originalname: 'recording.webm', size: 4 },
    audioLimit,
    get: () => undefined,
  };
}

function controllerMocks(t, { probed = null, dates = [] } = {}) {
  t.mock.method(ContentCreator, 'canUserUpload', async () => ({ allowed: true, reason: null }));
  t.mock.method(ContentCreator, 'create', async () => ({}));
  t.mock.method(AudioMessage, 'create', async () => { throw new Error('must not be reached in this test'); });
  t.mock.method(limits, 'countedUploads', async () => dates);
  return t.mock.method(audioDuration, 'probeDuration', async () => probed);
}

test('upload: a probed length over 15 minutes is refused with 413 although the client said 5', async (t) => {
  withEnv(t, {});
  controllerMocks(t, { probed: 1320.4 });
  const res = createResponse();
  await audioController.uploadAudio(controllerReq({ limited: true, source: 'upload' }), res);
  assert.equal(res.statusCode, 413);
  assert.deepEqual(res.body, {
    error: 'Audio too long',
    code: 'audio_too_long',
    message: 'Free accounts can upload audio up to 15 minutes long. This file is 22 minutes. 3Speak Pro removes this limit.',
    max_seconds: 900,
    duration: 1320,
    upgrade_url: 'https://3speak.tv/wallet/alice#pro',
  });
});

test('upload: the declared length counts when the probe fails or reads less', async (t) => {
  withEnv(t, {});
  const probe = controllerMocks(t, { probed: null });
  const res = createResponse();
  await audioController.uploadAudio(controllerReq({ limited: true, source: 'upload' }, { duration: '1000' }), res);
  assert.equal(res.statusCode, 413);
  assert.equal(res.body.duration, 1000);
  assert.equal(probe.mock.callCount(), 1);

  probe.mock.mockImplementation(async () => 600);
  const res2 = createResponse();
  await audioController.uploadAudio(controllerReq({ limited: true, source: 'upload' }, { duration: '1000' }), res2);
  assert.equal(res2.statusCode, 413);
  assert.equal(res2.body.duration, 1000);
});

test('upload: a count filled up meanwhile is refused with 429 before pinning', async (t) => {
  withEnv(t, {});
  controllerMocks(t, { probed: 120, dates: [Date.now() - 3 * HOUR, Date.now() - HOUR] });
  const res = createResponse();
  await audioController.uploadAudio(controllerReq({ limited: true, source: 'upload' }), res);
  assert.equal(res.statusCode, 429);
  assert.equal(res.body.code, 'daily_audio_limit');
  assert.ok(res.headers['Retry-After']);
});

test('upload: exempt and import uploads are never probed or refused for length', async (t) => {
  withEnv(t, { IPFS_API_URL: 'http://127.0.0.1:9' }); // nothing listens: stops at the pin
  const probe = controllerMocks(t, { probed: 7200 });
  for (const audioLimit of [{ limited: false, reason: 'pro', source: 'upload' }, { limited: false, reason: 'rss_import', source: 'rss_import' }]) {
    const res = createResponse();
    await audioController.uploadAudio(controllerReq(audioLimit, { duration: '7200' }), res);
    assert.ok(![413, 429].includes(res.statusCode), `status ${res.statusCode}`);
  }
  assert.equal(probe.mock.callCount(), 0);
  assert.equal(AudioMessage.create.mock.callCount(), 0);
});

test('upload: a limited upload within the rules goes on to the pin', async (t) => {
  withEnv(t, { IPFS_API_URL: 'http://127.0.0.1:9' });
  controllerMocks(t, { probed: 899.6, dates: [Date.now() - HOUR] });
  const res = createResponse();
  await audioController.uploadAudio(controllerReq({ limited: true, source: 'upload' }, { duration: '899' }), res);
  assert.ok(![413, 429].includes(res.statusCode), `status ${res.statusCode}`);
  assert.equal(limits.countedUploads.mock.callCount(), 1);
});

// ── GET /api/audio/quota ─────────────────────────────────────────────────────

async function getQuota(req) {
  const res = createResponse();
  await audioController.getQuota({ headers: {}, query: {}, ...req }, res);
  return res;
}

test('quota: switched off says enabled false, exempt true', async (t) => {
  withEnv(t, { AUDIO_DAILY_LIMITS_ENABLED: 'false' });
  const res = await getQuota({ headers: { 'x-user': 'alice' } });
  assert.deepEqual(res.body, {
    enabled: false, exempt: true, reason: null,
    audio: { limit: null, used: 0, remaining: null, next_at: null, max_seconds: null },
  });
});

test('quota: a free user sees the allowance', async (t) => {
  withEnv(t, {});
  const at = Date.now() - 2 * HOUR;
  freeUser(t, [at]);
  const res = await getQuota({ query: { owner: 'alice' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.enabled, true);
  assert.equal(res.body.exempt, false);
  assert.equal(res.body.reason, null);
  const { next_at, ...rest } = res.body.audio;
  assert.deepEqual(rest, { limit: 2, used: 1, remaining: 1, max_seconds: 900 });
  assert.ok(Math.abs(Date.parse(next_at) - (at + 24 * HOUR)) <= 1000);
});

test('quota: Pro, warm-up and listed users get their reason', async (t) => {
  withEnv(t, { AUDIO_LIMIT_EXEMPT: 'listeduser' });
  t.mock.method(limits, 'isPro', async (u) => u === 'prouser');
  t.mock.method(limits, 'isWarmup', async (u) => u === 'warmupuser');
  t.mock.method(limits, 'countedUploads', async () => [1]);
  for (const [user, reason] of [['prouser', 'pro'], ['warmupuser', 'warmup'], ['listeduser', 'listed']]) {
    const res = await getQuota({ headers: { 'x-user': user } });
    assert.equal(res.body.exempt, true);
    assert.equal(res.body.reason, reason);
    assert.equal(res.body.audio.limit, null);
  }
});

test('quota: X-User wins over ?owner=, and a request without a user is a 400', async (t) => {
  withEnv(t, {});
  const count = freeUser(t, []);
  await getQuota({ headers: { 'x-user': 'alice' }, query: { owner: 'bob' } });
  assert.equal(count.mock.calls[0].arguments[0], 'alice');
  const res = await getQuota({});
  assert.equal(res.statusCode, 400);
});
