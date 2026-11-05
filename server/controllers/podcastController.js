const { connectDB, getAudioCollectionName } = require('../models/AudioMessage');
const { MAX_TRACKS } = require('./playlistController');

// Outside podcasts (any RSS show people follow on 3speak.tv's /audio "External")
// live in the 3Speak checker, which polls the feeds and keeps every episode.
const CHECKER = (process.env.CHECKER_URL || 'https://checker.3speak.tv').replace(/\/+$/, '');
const SITE = 'https://3speak.tv';
const FEED_ID = /^[0-9a-f]{24}$/;
const PAGE = 200;               // the checker's largest page
const TTL_MS = 5 * 60 * 1000;
const cache = new Map();        // feed id -> { at, body }

/** The checker's resized cover (64 / 128 / 256 / 512 px) for an art token. */
const artUrl = (token, px) => (token ? `${CHECKER}/podcasts/art/${token}/${px}.jpg` : null);

/** "owner/permlink" when an episode's link is a 3Speak post (3speak.tv/watch?v= or /@owner/permlink). */
function threeSpeakPost(link) {
  let url;
  try { url = new URL(link); } catch { return null; }
  if (!/^(www\.)?3speak\.tv$/i.test(url.hostname)) return null;
  const ref = url.pathname === '/watch'
    ? url.searchParams.get('v') || ''
    : decodeURIComponent(url.pathname).replace(/^\/@/, '');
  const m = /^([a-z0-9][a-z0-9.-]{1,15})\/([a-z0-9-]+)$/i.exec(ref);
  return m && (url.pathname === '/watch' || url.pathname.startsWith('/@'))
    ? { owner: m[1].toLowerCase(), permlink: m[2] }
    : null;
}

/**
 * The show's episodes as embed tracks. Pure, so the tests need no checker.
 *
 * An episode that links a 3Speak post with a published audio row (`linked`,
 * "owner/post permlink" -> row) plays as that 3Speak audio: waveform, plays,
 * tip and sponsored spots go to its creator, as on 3speak.tv. Every other
 * episode plays its own file (`kind: 'external'`), with no waveform: most
 * podcast hosts do not let another site read the file, only play it.
 */
function podcastTracks(episodes, linked = new Map()) {
  const seen = new Set();
  return episodes
    .filter((e) => e && e.id && e.audio_url && !e.video && !seen.has(e.id) && seen.add(e.id))
    .slice(0, MAX_TRACKS)
    .map((e) => {
      const post = threeSpeakPost(e.link);
      const row = post && linked.get(`${post.owner}/${post.permlink}`);
      const common = {
        title: e.title || 'Untitled',
        duration: Math.round(Number(e.duration) || 0),
        created: e.published_at || null,
      };
      if (row) {
        return {
          ...common,
          permlink: row.permlink,
          owner: row.owner,
          thumbnail_url: row.thumbnail_url || artUrl(e.art, 128),
          post_permlink: post.permlink,
        };
      }
      return {
        ...common,
        kind: 'external',
        id: e.id,
        audio_url: e.audio_url,
        thumbnail_url: artUrl(e.art, 128),
        page: `${SITE}/audio?type=external&episode=${encodeURIComponent(e.id)}`,
      };
    });
}

async function checkerJson(path) {
  const res = await fetch(`${CHECKER}${path}`, { signal: AbortSignal.timeout(10000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`checker HTTP ${res.status}`);
  return res.json();
}

/**
 * GET /api/audio/podcast/:id
 *
 * What the podcast embed (/play?podcast=<id>) plays: an outside show's
 * episodes, newest MAX_TRACKS of them. Private shows answer 404 (the checker
 * only shows them to their followers, and an embed is anonymous).
 */
async function getPodcast(req, res) {
  const { id } = req.params;
  if (!FEED_ID.test(String(id || ''))) {
    return res.status(400).json({ error: 'Invalid podcast id' });
  }
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) {
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.json(hit.body);
  }
  try {
    const first = await checkerJson(`/podcasts/feed/${id}?limit=${PAGE}`);
    if (!first || !first.feed || first.feed.private) {
      return res.status(404).json({ error: 'Podcast not found' });
    }
    const episodes = [...(first.episodes || [])];
    while (episodes.length < MAX_TRACKS && episodes.length < (first.total || 0)) {
      const page = await checkerJson(`/podcasts/feed/${id}/older?offset=${episodes.length}&limit=${PAGE}`);
      const more = page?.episodes || [];
      if (!more.length) break;
      episodes.push(...more);
    }

    // Episodes of 3Speak posts play as the 3Speak audio when there is one.
    const posts = episodes.map((e) => threeSpeakPost(e.link)).filter(Boolean);
    const linked = new Map();
    if (posts.length) {
      const db = await connectDB();
      const rows = await db.collection(getAudioCollectionName())
        .find({
          status: 'published',
          $or: posts.map((p) => ({ owner: p.owner, post_permlink: { $in: [p.permlink, `${p.owner}/${p.permlink}`] } })),
        })
        .project({ permlink: 1, owner: 1, thumbnail_url: 1, post_permlink: 1 })
        .toArray();
      for (const r of rows) linked.set(`${r.owner}/${String(r.post_permlink).split('/').pop()}`, r);
    }

    const feed = first.feed;
    const body = {
      id,
      kind: 'podcast',
      name: feed.title || 'Podcast',
      author: feed.author || '',
      cover: artUrl(feed.art, 128),
      link: `${SITE}/audio?type=external&podcast=${id}`,
      tracks: podcastTracks(episodes, linked),
    };
    cache.set(id, { at: Date.now(), body });
    while (cache.size > 500) cache.delete(cache.keys().next().value);
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.json(body);
  } catch (error) {
    console.error('Error loading podcast:', error.message);
    return res.status(502).json({ error: 'Could not load the podcast' });
  }
}

module.exports = { getPodcast, podcastTracks, threeSpeakPost };
