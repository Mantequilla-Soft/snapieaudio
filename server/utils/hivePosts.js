/**
 * Title and date of Hive posts, the way 3speak.tv shows an episode: an audio
 * row keeps the upload's own name ("recording f879"), the post carries the real
 * title. Batched JSON-RPC (condenser_api.get_content), 50 per call, cached for
 * an hour. A Hive outage leaves what is not cached out; callers fall back to
 * the audio row.
 */
const NODES = (process.env.HIVE_API_NODES || 'https://api.hive.blog,https://api.deathwing.me,https://api.openhive.network')
  .split(',').map((s) => s.trim()).filter(Boolean);
const TTL_MS = 60 * 60 * 1000;
const CACHE_MAX = 5000;
const cache = new Map(); // "author/permlink" -> { at, title, created }

async function rpcBatch(calls) {
  let lastError;
  for (const node of NODES) {
    try {
      const res = await fetch(node, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(calls),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const out = await res.json();
      if (!Array.isArray(out)) throw new Error('not a batch answer');
      return out;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('no Hive node');
}

/** Map "author/permlink" -> { title, created } for the keys Hive answered. */
async function hivePosts(keys) {
  const now = Date.now();
  const unique = [...new Set(keys)];
  const missing = unique.filter((k) => !(now - (cache.get(k)?.at || 0) < TTL_MS));
  for (let i = 0; i < missing.length; i += 50) {
    const chunk = missing.slice(i, i + 50);
    try {
      const results = await rpcBatch(chunk.map((k, n) => ({
        jsonrpc: '2.0', id: n, method: 'condenser_api.get_content', params: k.split('/'),
      })));
      for (const r of results) {
        const key = chunk[r?.id];
        const post = r?.result;
        if (!key || !post || !post.author) continue;
        // Hive stores times without a zone; they are UTC.
        const created = post.created ? new Date(`${post.created}Z`).toISOString() : null;
        cache.set(key, { at: now, title: post.title || '', created });
      }
    } catch (err) {
      console.warn('Could not read Hive posts for playlist titles:', err.message);
    }
  }
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  const out = new Map();
  for (const k of unique) if (cache.has(k)) out.set(k, cache.get(k));
  return out;
}

module.exports = { hivePosts };
