// Listening time in the embed (src/listen-time.js): which requests the player
// sends to the 3Speak checker, without a browser. Window, document, the audio
// element and fetch are small stand-ins.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const listeners = {};
global.window = { addEventListener: (type, fn) => { listeners[`window:${type}`] = fn; } };
global.document = { visibilityState: 'visible', addEventListener: (type, fn) => { listeners[`document:${type}`] = fn; } };

let calls;
beforeEach(() => {
  calls = [];
  delete global.window.SNAPIE_LISTEN_API;
  global.document.visibilityState = 'visible';
  global.fetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body), keepalive: !!opts.keepalive });
    return { ok: true, json: async () => (url.endsWith('/start') ? { sid: 's1', token: 't1', beatSeconds: 10 } : {}) };
  };
});

const { ListenTimeTracker } = require('../src/listen-time.js');

function media(extra = {}) {
  const handlers = {};
  return {
    currentTime: 0, duration: 62, paused: false, playbackRate: 1,
    addEventListener: (type, fn) => { handlers[type] = fn; },
    fire: (type) => handlers[type](),
    ...extra,
  };
}
const beats = () => calls.filter((c) => c.url.endsWith('/beat')).map((c) => c.body);

test('opens an anonymous embed session for the track, at the checker', async () => {
  const t = new ListenTimeTracker('tmcfounj');
  await t.start(media());
  assert.strictEqual(calls[0].url, 'https://checker.3speak.tv/audio/listen/start');
  assert.deepStrictEqual(calls[0].body, { kind: 'audio', id: 'tmcfounj', duration: 62, position: 0, source: 'embed' });
  assert.ok(!('listener' in calls[0].body), 'the embed never names the listener');
});

test('the checker address can be set by the page', async () => {
  global.window.SNAPIE_LISTEN_API = 'https://checker.example/';
  await new ListenTimeTracker('x').start(media());
  assert.strictEqual(calls[0].url, 'https://checker.example/audio/listen/start');
});

test('one session per tracker, even when play fires twice', async () => {
  const t = new ListenTimeTracker('x');
  await Promise.all([t.start(media()), t.start(media())]);
  assert.strictEqual(calls.filter((c) => c.url.endsWith('/start')).length, 1);
});

test('no track, no session; no session, no beats', async () => {
  await new ListenTimeTracker(null).start(media());
  new ListenTimeTracker('x').beat(media());
  assert.strictEqual(calls.length, 0);
});

test('beats on schedule while playing, never while paused', async () => {
  const t = new ListenTimeTracker('x');
  const m = media();
  await t.start(m);
  m.currentTime = 4; t.tick(m);
  assert.strictEqual(beats().length, 0, 'under the 10 s interval');
  t.lastBeatAt -= 10000;
  m.currentTime = 10.5; t.tick(m);
  assert.deepStrictEqual(beats()[0], { sid: 's1', token: 't1', position: 10.5, rate: 1, hidden: false });
  assert.ok(calls.at(-1).keepalive, 'a beat survives the page closing');
  t.lastBeatAt -= 10000;
  m.paused = true; t.tick(m);
  assert.strictEqual(beats().length, 1);
});

test('a seek credits the stretch played up to the jump, not the new position', async () => {
  const t = new ListenTimeTracker('x');
  const m = media();
  t.attach(m);
  await t.start(m);
  m.currentTime = 13; t.tick(m);
  m.currentTime = 45; m.fire('seeking');
  assert.strictEqual(beats().at(-1).position, 13);
});

test('leaving the tab or the page sends a last beat, flagged hidden', async () => {
  const t = new ListenTimeTracker('x');
  const m = media({ currentTime: 20 });
  t.attach(m);
  await t.start(m);
  global.document.visibilityState = 'hidden';
  listeners['document:visibilitychange']();
  assert.strictEqual(beats().at(-1).hidden, true);
  listeners['window:pagehide']();
  assert.strictEqual(beats().length, 2);
});

test('a failed start leaves listening alone', async () => {
  global.fetch = async () => { throw new Error('offline'); };
  const t = new ListenTimeTracker('x');
  await t.start(media());
  assert.strictEqual(t.sid, null);
  assert.strictEqual(t.starting, false);
});
