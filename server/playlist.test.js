// The playlist embed's track list (server/controllers/playlistController.js):
// which audio rows a 3speak.tv playlist plays, and in what order.
const { test } = require('node:test');
const assert = require('node:assert');
const { playlistTracks, MAX_TRACKS } = require('./controllers/playlistController');

const row = (owner, permlink, post, extra = {}) => ({ owner, permlink, post_permlink: post, title: `t-${permlink}`, duration: 61.4, ...extra });

test("tracks follow the playlist's position order, not the order rows come back in", () => {
  const playlist = { items: [
    { author: 'alice', permlink: 'ep-2', position: 2 },
    { author: 'alice', permlink: 'ep-1', position: 1 },
    { author: 'bob', permlink: 'guest', position: 3 },
  ] };
  const rows = [row('bob', 'b1', 'guest'), row('alice', 'a2', 'ep-2'), row('alice', 'a1', 'ep-1')];
  assert.deepStrictEqual(playlistTracks(playlist, rows).map((t) => t.permlink), ['a1', 'a2', 'b1']);
});

test('video items and audio without a published row are left out', () => {
  const playlist = { items: [
    { author: 'alice', permlink: 'a-video', position: 1 },
    { author: 'alice', permlink: 'ep-1', position: 2 },
  ] };
  assert.deepStrictEqual(playlistTracks(playlist, [row('alice', 'a1', 'ep-1')]).map((t) => t.permlink), ['a1']);
});

test('a post_permlink stored as "author/permlink" still matches', () => {
  const playlist = { items: [{ author: 'alice', permlink: 'ep-1', position: 0 }] };
  const [t] = playlistTracks(playlist, [row('alice', 'a1', 'alice/ep-1')]);
  assert.strictEqual(t.permlink, 'a1');
  assert.strictEqual(t.post_permlink, 'ep-1');
});

test("the same post under another author's name does not match", () => {
  const playlist = { items: [{ author: 'alice', permlink: 'ep-1', position: 0 }] };
  assert.strictEqual(playlistTracks(playlist, [row('mallory', 'm1', 'ep-1')]).length, 0);
});

test('banned or hidden creators drop out, a track listed twice plays once', () => {
  const playlist = { items: [
    { author: 'alice', permlink: 'ep-1', position: 1 },
    { author: 'spam', permlink: 'x', position: 2 },
    { author: 'alice', permlink: 'ep-1', position: 3 },
  ] };
  const rows = [row('alice', 'a1', 'ep-1'), row('spam', 's1', 'x')];
  assert.deepStrictEqual(playlistTracks(playlist, rows, new Set(['spam'])).map((t) => t.permlink), ['a1']);
});

test('what a track carries: title (or file name), whole-second duration (MP3 first), thumbnail', () => {
  const playlist = { items: [{ author: 'alice', permlink: 'ep-1' }, { author: 'alice', permlink: 'ep-2' }] };
  const rows = [
    row('alice', 'a1', 'ep-1', { mp3_duration: 120.6, thumbnail_url: 'https://img/x.jpg' }),
    row('alice', 'a2', 'ep-2', { title: '', originalFilename: 'show.mp3', duration: undefined }),
  ];
  assert.deepStrictEqual(playlistTracks(playlist, rows), [
    { permlink: 'a1', owner: 'alice', title: 't-a1', duration: 121, thumbnail_url: 'https://img/x.jpg', post_permlink: 'ep-1', created: null },
    { permlink: 'a2', owner: 'alice', title: 'show.mp3', duration: 0, thumbnail_url: null, post_permlink: 'ep-2', created: null },
  ]);
});

test(`at most ${MAX_TRACKS} tracks`, () => {
  const n = MAX_TRACKS + 5;
  const items = Array.from({ length: n }, (_, i) => ({ author: 'alice', permlink: `ep-${i}`, position: i }));
  const rows = items.map((i, k) => row('alice', `a${k}`, i.permlink));
  assert.strictEqual(playlistTracks({ items }, rows).length, MAX_TRACKS);
});

test("the Hive post's title and date win over the upload's name and time", () => {
  const playlist = { items: [{ author: 'alice', permlink: 'ep-1' }, { author: 'alice', permlink: 'ep-2' }, { author: 'alice', permlink: 'ep-3' }] };
  const rows = [
    row('alice', 'a1', 'ep-1', { title: 'recording f879', createdAt: new Date('2026-11-01T17:33:07Z') }),
    row('alice', 'a2', 'ep-2', { title: 'Track two', createdAt: new Date('2026-11-02T10:00:00Z') }),
    row('alice', 'a3', 'ep-3', { title: 'recording 4702', createdAt: new Date('2026-11-03T01:26:38Z') }),
  ];
  const posts = new Map([
    ['alice/ep-1', { title: 'NaPodPoMo 2026 - Introduction', created: '2026-11-01T17:33:12.000Z' }],
    ['alice/ep-2', { title: 'RE: The album', created: '2026-11-02T10:00:05.000Z' }],
  ]);
  const tracks = playlistTracks(playlist, rows, new Set(), posts);
  assert.deepStrictEqual(tracks.map((t) => t.title), ['NaPodPoMo 2026 - Introduction', 'Track two', 'recording 4702']);
  assert.deepStrictEqual(tracks.map((t) => t.created), ['2026-11-01T17:33:12.000Z', '2026-11-02T10:00:05.000Z', '2026-11-03T01:26:38.000Z']);
});
