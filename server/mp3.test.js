const test = require('node:test');
const assert = require('node:assert/strict');
const { needsMp3, parseFfmpegDuration } = require('./utils/mp3');

test('needsMp3 skips formats podcast apps already play', () => {
  for (const fmt of ['mp3', 'm4a', 'mp4', 'aac', 'MP3', ' m4a ']) {
    assert.equal(needsMp3(fmt), false, fmt);
  }
});

test('needsMp3 converts recorder and lossless formats, and unknowns', () => {
  for (const fmt of ['webm', 'ogg', 'opus', 'wav', 'flac', '', null, undefined]) {
    assert.equal(needsMp3(fmt), true, String(fmt));
  }
});

test('parseFfmpegDuration reads the last progress line', () => {
  const stderr = [
    'Duration: N/A, start: 0.000000, bitrate: N/A',
    'size=     256kB time=00:00:16.32 bitrate= 128.5kbits/s speed=32x',
    'size=    2304kB time=00:02:27.48 bitrate= 128.0kbits/s speed=41x',
  ].join('\n');
  assert.equal(parseFfmpegDuration(stderr), 147.48);
});

test('parseFfmpegDuration handles hours and missing progress', () => {
  assert.equal(parseFfmpegDuration('time=01:02:03.50'), 3723.5);
  assert.equal(parseFfmpegDuration('no progress here'), null);
  assert.equal(parseFfmpegDuration(''), null);
});
