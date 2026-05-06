const test = require('node:test');
const assert = require('node:assert/strict');
const AudioMessage = require('./models/AudioMessage');
const audioController = require('./controllers/audioController');

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

function createRequest(body) {
  return {
    params: { permlink: 'audio123' },
    body
  };
}

test('updateWaveform accepts duration-only metadata healing', async (t) => {
  const updateWaveform = t.mock.method(AudioMessage, 'updateWaveform', async () => ({ matchedCount: 1 }));
  const req = createRequest({ duration: '42.75' });
  const res = createResponse();

  await audioController.updateWaveform(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { success: true });
  assert.deepEqual(updateWaveform.mock.calls[0].arguments, ['audio123', undefined, 42.75]);
});

test('updateWaveform accepts waveform-only metadata healing', async (t) => {
  const updateWaveform = t.mock.method(AudioMessage, 'updateWaveform', async () => ({ matchedCount: 1 }));
  const waveform = [[0.1, 0.2, 0.3]];
  const req = createRequest({ waveform });
  const res = createResponse();

  await audioController.updateWaveform(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { success: true });
  assert.deepEqual(updateWaveform.mock.calls[0].arguments, ['audio123', waveform, undefined]);
});

test('updateWaveform accepts waveform and duration together', async (t) => {
  const updateWaveform = t.mock.method(AudioMessage, 'updateWaveform', async () => ({ matchedCount: 1 }));
  const waveform = [[0.1, 0.2, 0.3]];
  const req = createRequest({ waveform, duration: '99.5' });
  const res = createResponse();

  await audioController.updateWaveform(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { success: true });
  assert.deepEqual(updateWaveform.mock.calls[0].arguments, ['audio123', waveform, 99.5]);
});

test('updateWaveform rejects requests missing waveform and duration', async (t) => {
  const updateWaveform = t.mock.method(AudioMessage, 'updateWaveform', async () => ({ matchedCount: 1 }));
  const req = createRequest({});
  const res = createResponse();

  await audioController.updateWaveform(req, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: 'Missing required fields' });
  assert.equal(updateWaveform.mock.callCount(), 0);
});

test('updateWaveform rejects invalid waveform values', async (t) => {
  const updateWaveform = t.mock.method(AudioMessage, 'updateWaveform', async () => ({ matchedCount: 1 }));
  const req = createRequest({ waveform: [0.1, 0.2, 0.3] });
  const res = createResponse();

  await audioController.updateWaveform(req, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: 'Invalid waveform format' });
  assert.equal(updateWaveform.mock.callCount(), 0);
});

test('updateWaveform rejects invalid duration values', async (t) => {
  const updateWaveform = t.mock.method(AudioMessage, 'updateWaveform', async () => ({ matchedCount: 1 }));
  const req = createRequest({ duration: 'not-a-number' });
  const res = createResponse();

  await audioController.updateWaveform(req, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: 'Invalid duration' });
  assert.equal(updateWaveform.mock.callCount(), 0);
});

test('updateWaveform rejects numeric strings with trailing characters', async (t) => {
  const updateWaveform = t.mock.method(AudioMessage, 'updateWaveform', async () => ({ matchedCount: 1 }));
  const req = createRequest({ duration: '42abc' });
  const res = createResponse();

  await audioController.updateWaveform(req, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: 'Invalid duration' });
  assert.equal(updateWaveform.mock.callCount(), 0);
});

test('updateWaveform rejects zero duration', async (t) => {
  const updateWaveform = t.mock.method(AudioMessage, 'updateWaveform', async () => ({ matchedCount: 1 }));
  const req = createRequest({ duration: 0 });
  const res = createResponse();

  await audioController.updateWaveform(req, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: 'Invalid duration' });
  assert.equal(updateWaveform.mock.callCount(), 0);
});

test('updateWaveform rejects negative duration', async (t) => {
  const updateWaveform = t.mock.method(AudioMessage, 'updateWaveform', async () => ({ matchedCount: 1 }));
  const req = createRequest({ duration: -1 });
  const res = createResponse();

  await audioController.updateWaveform(req, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: 'Invalid duration' });
  assert.equal(updateWaveform.mock.callCount(), 0);
});

test('updateWaveform rejects durations over 24 hours', async (t) => {
  const updateWaveform = t.mock.method(AudioMessage, 'updateWaveform', async () => ({ matchedCount: 1 }));
  const req = createRequest({ duration: 86401 });
  const res = createResponse();

  await audioController.updateWaveform(req, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: 'Invalid duration' });
  assert.equal(updateWaveform.mock.callCount(), 0);
});

test('updateWaveform returns 404 when no document is updated', async (t) => {
  const updateWaveform = t.mock.method(AudioMessage, 'updateWaveform', async () => ({ matchedCount: 0 }));
  const req = createRequest({ duration: 42 });
  const res = createResponse();

  await audioController.updateWaveform(req, res);

  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error: 'Audio not found or waveform already exists' });
  assert.equal(updateWaveform.mock.callCount(), 1);
});
