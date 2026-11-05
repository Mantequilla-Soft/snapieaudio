const { connectDB, getAudioCollectionName } = require('../models/AudioMessage');
const { hivePosts } = require('../utils/hivePosts');

// 3speak.tv playlist ids are UUIDs; older ones are shorter slugs.
const PLAYLIST_ID = /^[a-zA-Z0-9-]{8,64}$/;
// A playlist embed lists every audio item, up to this many.
const MAX_TRACKS = 500;

/**
 * The playlist's audio tracks in its own order, from the 3speak.tv playlist
 * document and the matching embed-audio rows. Pure, so the tests need no Mongo.
 *
 * Playlist items name the HIVE post (author/permlink). An audio row is linked
 * to its post by `post_permlink`, which a few rows store as "author/permlink".
 * Items that are videos, or audio without a published row, are left out.
 * Items by banned or hidden creators are left out too.
 *
 * `posts` (optional) maps "author/permlink" to the Hive post's { title, created }:
 * the post's title wins over the upload's own name, as on 3speak.tv. Replies
 * (album tracks) have no title of their own and keep the upload's.
 */
function playlistTracks(playlist, audioRows, blocked = new Set(), posts = new Map()) {
  const byPost = new Map();
  for (const row of audioRows) {
    const post = String(row.post_permlink || '').split('/').pop();
    if (row.owner && post) byPost.set(`${row.owner}/${post}`, row);
  }
  const seen = new Set();
  return (playlist.items || [])
    .filter((i) => i && i.author && i.permlink && !blocked.has(i.author))
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((i) => ({ row: byPost.get(`${i.author}/${i.permlink}`), post: posts.get(`${i.author}/${i.permlink}`) }))
    .filter(({ row }) => row && !seen.has(row.permlink) && seen.add(row.permlink))
    .slice(0, MAX_TRACKS)
    .map(({ row, post }) => {
      const postTitle = String(post?.title || '').trim();
      const uploaded = row.createdAt ? new Date(row.createdAt) : null;
      return {
        permlink: row.permlink,
        owner: row.owner,
        title: (postTitle && !/^re:/i.test(postTitle) ? postTitle : '') || row.title || row.originalFilename || 'Untitled',
        duration: Math.round(Number(row.mp3_duration || row.duration) || 0),
        thumbnail_url: row.thumbnail_url || null,
        post_permlink: String(row.post_permlink || '').split('/').pop() || null,
        // When it was published: the Hive post, else the upload
        created: post?.created || (uploaded && !Number.isNaN(uploaded.getTime()) ? uploaded.toISOString() : null),
      };
    });
}

/** The album cover kept in the playlist's metadata (base64 JSON, or an object). */
function albumThumbnail(metadata) {
  try {
    const meta = typeof metadata === 'string'
      ? JSON.parse(Buffer.from(metadata, 'base64').toString('utf8'))
      : metadata;
    return meta?.album?.thumbnail || null;
  } catch {
    return null;
  }
}

/**
 * GET /api/audio/playlist/:id
 *
 * What the playlist embed (/play?list=<id>) plays. Only public playlists:
 * private ones and Watch Later answer 404, as do playlists whose owner is
 * banned or hidden.
 */
async function getPlaylist(req, res) {
  const { id } = req.params;
  if (!PLAYLIST_ID.test(String(id || ''))) {
    return res.status(400).json({ error: 'Invalid playlist id' });
  }
  try {
    const db = await connectDB();
    const playlist = await db.collection('playlists').findOne({ _id: id });
    if (!playlist || playlist.access !== 'public' || !playlist.owner) {
      return res.status(404).json({ error: 'Playlist not found' });
    }

    const refs = (playlist.items || []).filter((i) => i && i.author && i.permlink).slice(0, 1000);
    const authors = [...new Set([playlist.owner, ...refs.map((i) => i.author)])];
    const blocked = new Set(
      (await db.collection('contentcreators')
        .find({ username: { $in: authors }, $or: [{ banned: true }, { hidden: true }] })
        .project({ username: 1 })
        .toArray()
      ).map((c) => c.username)
    );
    if (blocked.has(playlist.owner)) {
      return res.status(404).json({ error: 'Playlist not found' });
    }

    const live = refs.filter((i) => !blocked.has(i.author));
    const audioRows = live.length === 0 ? [] : await db.collection(getAudioCollectionName())
      .find({
        status: 'published',
        $or: live.map((i) => ({ owner: i.author, post_permlink: { $in: [i.permlink, `${i.author}/${i.permlink}`] } })),
      })
      .project({ permlink: 1, owner: 1, title: 1, originalFilename: 1, duration: 1, mp3_duration: 1, thumbnail_url: 1, post_permlink: 1, createdAt: 1 })
      .toArray();
    const posts = await hivePosts(audioRows.map((r) => `${r.owner}/${String(r.post_permlink || '').split('/').pop()}`));

    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.json({
      id,
      name: playlist.name || `${playlist.owner} playlist`,
      owner: playlist.owner,
      cover: playlist.thumbnail || albumThumbnail(playlist.metadata),
      tracks: playlistTracks({ ...playlist, items: live }, audioRows, blocked, posts),
    });
  } catch (error) {
    console.error('Error loading playlist:', error);
    return res.status(500).json({ error: 'Failed to load playlist' });
  }
}

module.exports = { getPlaylist, playlistTracks, MAX_TRACKS };
