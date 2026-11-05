// Sponsored audio spots in the embed (src/audio-ad.js), without a browser: the
// track's media element, the spot's Audio element, storage and fetch are small
// stand-ins.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const store = {};
global.window = {
  localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } },
};

class Target {
  constructor() { this.handlers = {}; }
  addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); }
  fire(type) { for (const fn of this.handlers[type] || []) fn(); }
}

let adEls;
let playRejects;
class FakeAudio extends Target {
  constructor() { super(); Object.assign(this, { src: '', paused: true, ended: false, currentTime: 0, volume: 1, muted: false }); adEls.push(this); }
  play() {
    if (playRejects) return Promise.reject(new Error('NotAllowedError'));
    this.paused = false; this.fire('play'); return Promise.resolve();
  }
  pause() { this.paused = true; this.fire('pause'); }
}
global.Audio = FakeAudio;

function media() {
  const m = new Target();
  Object.assign(m, {
    currentTime: 0, duration: 600, paused: true, volume: 0.5, muted: false,
    play() { m.paused = false; m.fire('play'); return Promise.resolve(); },
    pause() { m.paused = true; },
  });
  return m;
}

const SPOT = {
  audioUrl: 'https://checker.test/m/tts/abc.mp3', durationSeconds: 9.5, positionPercent: 0,
  message: 'Try it', productName: 'Hive Shop', clickUrl: 'https://checker.test/m/s1/tc',
  shownUrl: 'https://checker.test/m/s1/ticker-shown', adKey: 'k1', capMinutes: 5, label: 'Ad',
};

let calls;
let answer;
beforeEach(() => {
  adEls = [];
  playRejects = false;
  answer = { ...SPOT };
  for (const k of Object.keys(store)) delete store[k];
  delete global.window.SNAPIE_AD_API;
  calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, body: opts.body ? JSON.parse(opts.body) : null, keepalive: !!opts.keepalive });
    return { ok: true, json: async () => (url.endsWith('/m/session') ? { ad: null, audioAd: answer } : {}) };
  };
});

const { AudioAdSpot, normalizeSpot } = require('../src/audio-ad.js');
const tick = () => new Promise((r) => setImmediate(r));

async function setup(extra = {}) {
  const phases = [];
  const m = media();
  const ad = new AudioAdSpot({ owner: 'badadib', permlink: 'abc', onChange: (p) => phases.push(p), ...extra });
  ad.attach(m);
  await ad.request();
  return { ad, m, phases };
}

test('asks the checker for an audio spot on this track', async () => {
  await setup({ viewer: 'alice' });
  assert.strictEqual(calls[0].url, 'https://checker.3speak.tv/m/session');
  assert.deepStrictEqual(
    { ...calls[0].body, capId: undefined },
    { surface: 'audio', audioSpot: true, owner: 'badadib', permlink: 'abc', viewer: 'alice', capId: undefined, recentAdKeys: [] },
  );
  assert.strictEqual(adEls[0].src, SPOT.audioUrl);
});

test('the checker address can be overridden', async () => {
  global.window.SNAPIE_AD_API = 'https://checker.example/';
  await setup();
  assert.strictEqual(calls[0].url, 'https://checker.example/m/session');
});

test('a pre-roll pauses the track, plays the spot, reports it and resumes from the start', async () => {
  const { ad, m, phases } = await setup();
  m.currentTime = 0.6;
  await m.play();
  assert.strictEqual(m.paused, true);
  assert.strictEqual(adEls[0].paused, false);
  assert.strictEqual(ad.active, true);
  await tick();
  // Remembered for its own 5-minute cap once it really played.
  assert.ok(JSON.parse(store['3speak-ads-seen']).k1);

  adEls[0].ended = true; adEls[0].fire('ended');
  const shown = calls.filter((c) => c.url === SPOT.shownUrl);
  assert.strictEqual(shown.length, 1);
  assert.strictEqual(shown[0].keepalive, true);
  assert.strictEqual(m.currentTime, 0);
  assert.strictEqual(m.paused, false);
  assert.strictEqual(phases.at(-1), 'heard');
});

test('a mid-roll waits for its position', async () => {
  answer.positionPercent = 50;
  const { m } = await setup();
  await m.play();
  m.currentTime = 120; m.fire('timeupdate');
  assert.strictEqual(adEls[0].paused, true);
  m.currentTime = 300.2; m.fire('timeupdate');
  assert.strictEqual(adEls[0].paused, false);
  assert.strictEqual(m.paused, true);
});

test('during the spot, the play button and a play on the track toggle the spot', async () => {
  const { ad, m, phases } = await setup();
  await m.play();
  assert.strictEqual(ad.toggle(), true);
  assert.strictEqual(adEls[0].paused, true);
  assert.strictEqual(phases.at(-1), 'paused');
  await m.play();
  assert.strictEqual(m.paused, true);
  assert.strictEqual(adEls[0].paused, false);
});

test('a spot the browser refuses is dropped and the track plays on, unreported', async () => {
  playRejects = true;
  const { ad, m, phases } = await setup();
  await m.play();
  await tick();
  assert.strictEqual(m.paused, false);
  assert.strictEqual(ad.active, false);
  assert.strictEqual(calls.filter((c) => c.url === SPOT.shownUrl).length, 0);
  assert.strictEqual(phases.at(-1), 'idle');
});

test("an advertiser's own clip has no text and still plays", async () => {
  answer = { ...SPOT, message: '' };
  const { ad, m } = await setup();
  assert.strictEqual(ad.spot.message, '');
  await m.play();
  assert.strictEqual(adEls[0].paused, false);
  assert.strictEqual(m.paused, true);
  assert.strictEqual(normalizeSpot({ ...SPOT, message: undefined }).message, '');
});

test('no answer, or a bad one, means no spot', async () => {
  answer = null;
  const { m } = await setup();
  await m.play();
  assert.strictEqual(m.paused, false);
  assert.strictEqual(adEls.length, 0);
  assert.strictEqual(normalizeSpot({ ...SPOT, audioUrl: 'http://insecure/x.mp3' }), null);
  assert.strictEqual(normalizeSpot({ ...SPOT, clickUrl: 'javascript:alert(1)' }).clickUrl, null);
});

test('a playlist passes one capId for all its tracks', () => {
  const a = new AudioAdSpot({ owner: 'alice', permlink: 't1', capId: 'abc123abc123abc123' });
  const b = new AudioAdSpot({ owner: 'alice', permlink: 't2', capId: 'abc123abc123abc123' });
  assert.strictEqual(a.capId, b.capId);
  assert.notStrictEqual(new AudioAdSpot({ owner: 'a', permlink: 'b' }).capId, a.capId);
});

test('dispose stops a running spot and leaves the next track alone', async () => {
  const spot = new AudioAdSpot({ owner: 'alice', permlink: 'track1' });
  const m = media();
  spot.attach(m);
  await spot.request();
  m.play();
  assert.ok(spot.active, 'the spot started with the track');
  spot.dispose();
  assert.ok(!spot.active);
  assert.ok(adEls[0].paused, 'the spot is silenced');
  m.paused = true;
  m.play();
  m.fire('timeupdate');
  assert.ok(!m.paused, 'the shared element plays the next track, not paused by the old spot');
  assert.ok(!calls.some((c) => c.url === SPOT.shownUrl), 'a cut-off spot is not reported as heard');
});

test('a spot answered after dispose is dropped', async () => {
  const spot = new AudioAdSpot({ owner: 'alice', permlink: 'track1' });
  const pending = spot.request();
  spot.dispose();
  assert.strictEqual(await pending, null);
  assert.strictEqual(spot.spot, null);
});
