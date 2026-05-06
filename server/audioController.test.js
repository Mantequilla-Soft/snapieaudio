const test = require('node:test');
const assert = require('node:assert/strict');
const AudioMessage = require('./models/AudioMessage');
const audioController = require('./controllers/audioController');

const originalUpdateWaveform = AudioMessage.updateWaveform;

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

test.afterEach(() => {
  AudioMessage.updateWaveform = originalUpdateWaveform;
});

test('updateWaveform accepts duration-only metadata healing', async () => {
  let updateArgs = null;
  AudioMessage.updateWaveform = async (...args) => {
    updateArgs = args;
  };

  const req = {
    params: { permlink: 'audio123' },
    body: { duration: '42.75' }
  };
  const res = createResponse();

  await audioController.updateWaveform(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { success: true });
  assert.deepEqual(updateArgs, ['audio123', undefined, 42.75]);
});

test('updateWaveform rejects invalid duration values', async () => {
  let updateCalled = false;
  AudioMessage.updateWaveform = async () => {
    updateCalled = true;
  };

  const req = {
    params: { permlink: 'audio123' },
    body: { duration: 'not-a-number' }
  };
  const res = createResponse();

  await audioController.updateWaveform(req, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: 'Invalid duration' });
  assert.equal(updateCalled, false);
});
