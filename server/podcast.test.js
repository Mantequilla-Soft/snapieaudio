// The podcast embed's track list (server/controllers/podcastController.js):
// which episodes of an outside show it plays, and how.
const { test } = require('node:test');
const assert = require('node:assert');
const { podcastTracks, threeSpeakPost } = require('./controllers/podcastController');

const FEED = '6ae3c77f91d7738e82354365';
const ep = (n, extra = {}) => ({
  id: `${FEED}:episode000000000${n}`.slice(0, 41), feed_id: FEED, title: `Episode ${n}`,
  audio_url: `https://host.example/ep${n}.mp3`, published_at: `2026-05-0${n}T22:03:00.000Z`, duration: 61.6, ...extra,
});

test('an outside episode plays its own file and links its 3speak.tv page', () => {
  const [t] = podcastTracks([ep(1, { art: 'tok' })]);
  assert.strictEqual(t.kind, 'external');
  assert.strictEqual(t.audio_url, 'https://host.example/ep1.mp3');
  assert.strictEqual(t.duration, 62);
  assert.strictEqual(t.created, '2026-05-01T22:03:00.000Z');
  assert.match(t.thumbnail_url, /\/podcasts\/art\/tok\/128\.jpg$/);
  assert.strictEqual(t.page, `https://3speak.tv/audio?type=external&episode=${encodeURIComponent(t.id)}`);
});

test('an episode of a 3Speak post with an audio row plays as that 3Speak audio', () => {
  const linked = new Map([['steevc/napodpomo-day-1', { permlink: 'abc12345', owner: 'steevc', thumbnail_url: null }]]);
  const [t] = podcastTracks([ep(1, { link: 'https://3speak.tv/watch?v=steevc/napodpomo-day-1' })], linked);
  assert.strictEqual(t.kind, undefined);
  assert.strictEqual(t.permlink, 'abc12345');
  assert.strictEqual(t.owner, 'steevc');
  assert.strictEqual(t.post_permlink, 'napodpomo-day-1');
});

test('a 3Speak post without an audio row stays an outside episode', () => {
  const [t] = podcastTracks([ep(1, { link: 'https://3speak.tv/@steevc/a-video' })]);
  assert.strictEqual(t.kind, 'external');
});

test('video episodes, episodes without a file and repeats are left out', () => {
  const tracks = podcastTracks([ep(1), ep(2, { video: true }), ep(3, { audio_url: '' }), ep(1)]);
  assert.deepStrictEqual(tracks.map((t) => t.title), ['Episode 1']);
});

test('threeSpeakPost reads both link forms and nothing else', () => {
  assert.deepStrictEqual(threeSpeakPost('https://3speak.tv/watch?v=Alice/ep-1'), { owner: 'alice', permlink: 'ep-1' });
  assert.deepStrictEqual(threeSpeakPost('https://www.3speak.tv/@bob/ep-2'), { owner: 'bob', permlink: 'ep-2' });
  assert.strictEqual(threeSpeakPost('https://evil.example/@bob/ep-2'), null);
  assert.strictEqual(threeSpeakPost('not a url'), null);
});
