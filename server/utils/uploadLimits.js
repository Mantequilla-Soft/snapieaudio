const DEFAULT_MAX_UPLOAD_BYTES = 104857600; // 100MB

const UNIT_MULTIPLIERS = {
  b: 1,
  kb: 1024,
  mb: 1024 * 1024,
  gb: 1024 * 1024 * 1024,
};

function parseUploadMaxBytes(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return DEFAULT_MAX_UPLOAD_BYTES;
  }

  const trimmed = String(raw).trim();

  if (/^\d+$/.test(trimmed)) {
    const n = parseInt(trimmed, 10);
    if (n > 0) return n;
  }

  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)$/i.exec(trimmed);
  if (match) {
    const value = parseFloat(match[1]);
    const unit = match[2].toLowerCase();
    const bytes = Math.floor(value * UNIT_MULTIPLIERS[unit]);
    if (bytes > 0) return bytes;
  }

  throw new Error(
    `Invalid UPLOAD_MAX_FILE_SIZE: "${raw}". Use a positive integer (bytes) ` +
    `or a value with a unit suffix (e.g. "100mb", "1gb").`
  );
}

module.exports = {
  DEFAULT_MAX_UPLOAD_BYTES,
  parseUploadMaxBytes,
  MAX_UPLOAD_BYTES: parseUploadMaxBytes(process.env.UPLOAD_MAX_FILE_SIZE),
};
