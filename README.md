<p align="center">
  <img src=".github/assets/snapie-logo.png" width="112" alt="Snapie">
</p>

<h1 align="center">Snapie Audio</h1>

<p align="center">
  <strong>Audio hosting and a waveform player for voice messages, podcasts and songs.</strong><br>
  Part of <a href="https://snapie.io">Snapie</a>, by Mantequilla Soft. Powers audio on <a href="https://3speak.tv">3Speak</a>.
</p>

<p align="center">
  <a href="https://github.com/Mantequilla-Soft/snapieaudio/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Mantequilla-Soft/snapieaudio/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="node >=18" src="https://img.shields.io/badge/node-%3E%3D18-4a9eff">
  <img alt="Express 4" src="https://img.shields.io/badge/Express-4-1a2332">
  <img alt="MongoDB driver 6" src="https://img.shields.io/badge/MongoDB-6-4a9eff">
  <img alt="WaveSurfer.js 7" src="https://img.shields.io/badge/WaveSurfer.js-7-1a2332">
  <img alt="storage IPFS" src="https://img.shields.io/badge/storage-IPFS-4a9eff">
  <img alt="license MIT" src="https://img.shields.io/badge/license-MIT-blue">
</p>

<p align="center">
  Part of <a href="https://snapie.io">Snapie</a> · sibling repo: <a href="https://github.com/Mantequilla-Soft/snapievideoplayer">Snapie Video Player</a>
</p>

---

Snapie Audio is a small Node.js service that stores audio on IPFS, keeps its metadata in
MongoDB and serves an embeddable player at `/play`. One iframe plays a single track, a
whole 3Speak playlist or an outside podcast, with a waveform, speed and volume chips, a
tip button and listen counting that cannot be faked with a single request.

It is for apps that want voice messages or long-form audio without building their own
storage and player: 3speak.tv uses it for audio posts, playlists and uploads, and any site
can drop the iframe in. The upload API is key-protected, the player and the read API are
public.

## Contents

- [How it works](#how-it-works)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Reference](#reference): [player URL](#player-url) · [embedding](#embedding) · [read API](#read-api) · [upload API](#upload-api) · [listen counting](#listen-counting) · [upload limits](#upload-limits) · [admin API](#admin-api) · [data model](#data-model) · [background jobs](#background-jobs)
- [Development and tests](#development-and-tests)
- [Repository layout](#repository-layout)
- [Security notes](#security-notes)
- [Contributing](#contributing)
- [License](#license)

## How it works

```
  your app ── POST /api/audio/upload (X-API-Key, X-User) ──▶ Snapie Audio ──▶ IPFS node (pin)
                                                                 │
                                                                 ▼
                                                         MongoDB: embed-audio
                                                                 │
  <iframe src="/play?a=…"> ── GET /api/audio?a=… ───────────────┘
        │
        ├── fetches the file from an IPFS gateway (primary, then fallback)
        ├── POST /api/audio/play-start, then /play-beat while it really plays
        └── optional: sponsored spots and listening time via the 3Speak checker
```

1. **Upload.** A client sends the file plus its declared `duration` and `format`. The
   server checks the API key and the uploader, adds the file to the local IPFS node with
   a pin, verifies the pin, and writes a row with an 8 character `permlink`.
2. **Play.** `/play?a=<permlink>` loads the player page. It asks the API for the metadata,
   which includes a primary and a fallback gateway URL chosen from the file's pin status,
   and draws the waveform (stored peaks when present, else decoded once and saved back).
3. **Count.** A play counts only after the listener streamed 66% of the track, measured by
   the server from the time between heartbeats.
4. **Keep.** Background jobs add an MP3 copy for podcast apps and, in production, copy
   songs, podcasts and interviews to a second IPFS node.

## Quick start

Needs Node.js 18 or newer, MongoDB, and a Kubo (go-ipfs) node with its HTTP API reachable
(default `http://127.0.0.1:5001`). The player works without an IPFS node for `?cid=`
playback; uploads need one.

```bash
git clone https://github.com/Mantequilla-Soft/snapieaudio.git
cd snapieaudio
npm install
cp .env.example .env   # then edit it, see Configuration
npm run dev            # nodemon; or `npm start`
```

Then open:

```
http://localhost:3000/                  # landing page
http://localhost:3000/docs              # API documentation page
http://localhost:3000/play?cid=<cid>    # play any IPFS CID, no database row needed
http://localhost:3000/play?a=<permlink> # play an uploaded track
http://localhost:3000/health            # { "status": "ok" }
```

`ffmpeg-static` is an optional dependency; when it installs, the MP3 worker and the length
check have an ffmpeg without any system package.

## Configuration

All settings come from environment variables (`.env` is loaded with dotenv). Keys and
passwords have no default: set your own.

| Variable | Purpose | Default |
|---|---|---|
| `PORT` | HTTP port | `3000` |
| `NODE_ENV` | `production` turns on the migration worker and https in returned URLs | unset |
| `TRUST_PROXY` | Express `trust proxy` hops, so rate limits see the real client IP | `1` |
| `MONGODB_URI` | MongoDB connection string | `mongodb://localhost:27017` |
| `MONGODB_DATABASE` | Database name (the server reads this one, not `DB_NAME`) | `snapieaudio` |
| `MONGODB_COLLECTION_AUDIO` | Collection for audio rows | `embed-audio` |
| `IPFS_API_URL` | Kubo HTTP API used for uploads, pins and health | `http://127.0.0.1:5001` |
| `IPFS_PRIMARY_GATEWAY` | Gateway base URL for local pins, without `/ipfs` (e.g. `https://ipfs.example.com`) | none |
| `IPFS_SUPERNODE_URL` | Second node: gateway for migrated files and Kubo API the migration pins to | `https://ipfs.3speak.tv` |
| `IPFS_FALLBACK_GATEWAY_1` / `_2` | Public fallback gateway base URLs | none |
| `API_KEYS` | Comma list of keys accepted by the upload and edit routes | none |
| `DEMO_API_KEY` | Key used by `/demo`; its uploads are never migrated and get a 24 hour `pin_until` | none |
| `ADMIN_PASSWORD` | Password for `/admin` and `/api/admin/*` | none, **always set it** |
| `UPLOAD_MAX_FILE_SIZE` | Bytes, or with a unit (`100mb`, `1gb`) | `100mb` |
| `UPLOAD_ALLOWED_FORMATS` | Allowed file extensions | `mp3,m4a,ogg,webm,wav` |
| `RATE_LIMIT_WINDOW_MS` | Rate limit window | `60000` |
| `RATE_LIMIT_MAX_REQUESTS` | Requests per window for play, playlist, podcast and waveform routes | `100` |
| `BEAT_RATE_LIMIT_MAX_REQUESTS` | Requests per window for `/play-beat` | `600` |
| `LISTEN_BEAT_SECONDS` | Heartbeat interval the player is told to use | `3` |
| `LISTEN_DEDUPE_MIN` | Same logged-in listener and track counts once per this many minutes | `30` |
| `PLAY_DEDUPE_MIN` | Same IP and track counts once per this many minutes (anonymous) | `30` |
| `LISTEN_BEAT_KEY` | Optional heartbeat encryption key (see [listen counting](#listen-counting)) | unset |
| `ENABLE_MIGRATIONS` | `false` turns the migration worker off | on in production |
| `MIGRATION_SCHEDULE_HOUR` | Hour of the daily migration run | `2` |
| `ENABLE_MP3_TRANSCODE` | `false` turns the MP3 companion worker off | on |
| `MP3_BITRATE` | MP3 companion bitrate (CBR) | `128k` |
| `MP3_MAX_ATTEMPTS` | Attempts before an upload is marked `failed` | `3` |
| `MP3_RETRY_DELAY_MINUTES` | Wait between attempts | `60` |
| `MP3_FETCH_TIMEOUT_SECONDS` | Timeout for reading an original from IPFS | `300` |
| `FFMPEG_PATH` | A specific ffmpeg binary | `ffmpeg-static`, else `ffmpeg` |
| `FFPROBE_PATH` | ffprobe for measuring upload length (falls back to an ffmpeg decode) | `ffprobe` |
| `AUDIO_DAILY_LIMITS_ENABLED` | `false` switches the [upload limits](#upload-limits) off | on |
| `AUDIO_LIMIT_PER_DAY` | Uploads per rolling 24 hours for limited accounts | `2` |
| `AUDIO_MAX_DURATION_SECONDS` | Longest upload for limited accounts | `1200` |
| `AUDIO_LIMIT_EXEMPT` | Comma list of usernames without limits | empty |
| `AUDIO_IMPORT_API_KEYS` | Keys (also listed in `API_KEYS`) whose RSS imports are never counted | empty |
| `AUDIO_PRO_USERS_COLLECTION` | Collection with the per-user `premium` flag | `embed-users` |
| `AUDIO_UPGRADE_URL` | `upgrade_url` in limit refusals, `{user}` is filled in | `https://3speak.tv/wallet/{user}#pro` |
| `CHECKER_URL` | 3Speak checker, for podcast episodes and warm-up lookups | `https://checker.3speak.tv` |
| `HIVE_API_NODES` | Comma list of Hive API nodes for post titles and account checks | `https://api.hive.blog,https://api.deathwing.me,https://api.openhive.network` |

The player page reads three optional globals, for a fork that injects them into
`src/index.html`: `window.LISTEN_BEAT_KEY`, `window.SNAPIE_AD_API` and
`window.SNAPIE_LISTEN_API` (both default to `https://checker.3speak.tv`).

## Reference

### Player URL

`/play` takes one source and any of the display options.

| Param | Example | Does |
|---|---|---|
| `a` | `?a=dkojohs` | Plays one track by permlink |
| `cid` | `?cid=bafybei…` | Plays an IPFS CID directly, no database row needed |
| `list` | `?list=<playlist id>` | Plays every audio item of a public 3speak.tv playlist, advancing on its own |
| `podcast` | `?podcast=<feed id>` | Plays every episode of an outside show followed on 3speak.tv |
| `track` | `&track=3` | Start at this track (1-based) of a list or podcast |
| `sort` | `&sort=desc` | List order by date, newest first (default oldest first; the listener can flip it) |
| `user` | `&user=badadib` | Credits the listen to this Hive account (also accepted as `username`) |
| `mode` | `&mode=compact` | `full` (default), `compact`, or `minimal` (no header, chips or tip button) |
| `theme` | `&theme=dark` | Dark theme when opened as a page; inside an iframe it is always dark |
| `bg` | `&bg=transparent` | In an iframe, drops the slight dark backdrop |
| `iframe` | `&iframe=1` | Forces iframe styling outside a frame |

Player features: waveform scrubbing (WaveSurfer.js 7), speed chip (1x, 1.5x, 2x), volume
chip with a remembered level (press **M** to mute), a tip button that opens the creator's
3speak.tv tip page when the track is linked to a Hive post, and sponsored audio spots
served by the 3Speak checker (fails open: a spot that cannot play is skipped).

### Embedding

```html
<iframe
  src="https://audio.3speak.tv/play?a=dkojohs"
  width="600" height="100" frameborder="0" allow="autoplay">
</iframe>
```

```jsx
const AudioMessage = ({ permlink }) => (
  <iframe
    src={`https://audio.3speak.tv/play?a=${permlink}`}
    style={{ border: 'none', width: '100%', height: '100px' }}
    allow="autoplay"
  />
);
```

An embedder needs no script, key or CORS setup: the player calls its own origin. Add
`&user=<hive-account>` only for a listener who is really logged in on your page.

### Read API

| Route | Does |
|---|---|
| `GET /api/audio?a=<permlink>` | Metadata of a published track |
| `GET /api/audio?cid=<cid>` | Gateway URLs for a CID (`mode: "direct"`, no database lookup) |
| `GET /api/audio/feed` | Paged list of published tracks |
| `GET /api/audio/playlist/:id` | Audio tracks of a public playlist, in its order |
| `GET /api/audio/podcast/:id` | Episodes of an outside podcast |
| `GET /health` | `{ status, timestamp }` |
| `GET /api/audio/health/ipfs` | Kubo version, repo usage and migration queue (503 when IPFS is down) |

**Track metadata** (`GET /api/audio?a=dkojohs`):

```json
{
  "permlink": "dkojohs",
  "owner": "badadib",
  "audio_cid": "bafybei…",
  "category": "podcast",
  "duration": 1800,
  "format": "mp3",
  "waveform": { "peaks": [0.2, 0.5, 0.8], "length": 100 },
  "audioUrl": "https://<gateway>/ipfs/bafybei…",
  "audioUrlFallback": "https://<fallback>/ipfs/bafybei…",
  "mp3Url": null,
  "ipfs_status": "pinned_local",
  "title": "My Podcast",
  "description": "…",
  "tags": ["podcast", "tech"],
  "thumbnail_url": "https://…",
  "post_permlink": "my-audio-post",
  "plays": 150
}
```

**Feed** (`GET /api/audio/feed`):

| Query | Values | Default |
|---|---|---|
| `limit` | 1 to 100 | `20` |
| `offset` | number | `0` |
| `sort` | `newest`, `oldest`, `plays`, `trending` | `newest` |
| `category` | e.g. `voice_message`, `podcast`, `song`, `interview` | all |
| `tag` | one tag | all |
| `owner` | username | all |

Returns `{ items: [...], pagination: { limit, offset, total, hasMore }, filters }`, each
item with the fields above plus `likes`, `createdAt`, `mp3_cid` and `mp3Url`.

**Playlist** (`GET /api/audio/playlist/:id`) returns `{ id, name, owner, cover, tracks }`,
each track `{ permlink, owner, title, duration, thumbnail_url, post_permlink, created }`.
Only `access: "public"` playlists are served (private ones and Watch Later answer 404),
up to 500 tracks; video items, unpublished audio and items by banned or hidden creators
are left out. A track's title is its Hive post's title when it has one. This route reads
the `playlists` and `contentcreators` collections, so it needs the database 3speak.tv
writes to.

**Podcast** (`GET /api/audio/podcast/:id`, a 24 hex character feed id) returns
`{ id, kind: "podcast", name, author, cover, link, tracks }`, read from the 3Speak checker
and cached for 5 minutes. An episode that links to a published 3Speak audio post plays as
that track (waveform, plays, tip and spots apply); every other episode has
`kind: "external"` and plays its own file without a waveform, because most podcast hosts
let other sites stream a file but not read it.

### Upload API

All routes here need an `X-API-Key` header (or `?api_key=`) from `API_KEYS`, and an
`X-User` header naming the uploader or owner.

```bash
curl -X POST http://localhost:3000/api/audio/upload \
  -H "X-API-Key: <your-api-key>" \
  -H "X-User: badadib" \
  -F "audio=@episode.mp3" \
  -F "duration=1800" \
  -F "format=mp3" \
  -F "category=podcast" \
  -F "title=My Podcast" \
  -F 'tags=["podcast","tech"]'
```

Multipart fields: `audio` (the file) plus `duration` and `format` (both required), and
optionally `title`, `description`, `tags` (JSON array), `category` (default
`voice_message`), `thumbnail_url`, `post_permlink`, `waveform` (JSON peaks), `codec`,
`bitrate`, `sampleRate`, `channels`, `context_type`, `context_id`, `reply_to`.

`201` answer: `{ success, permlink, cid, playUrl, apiUrl }`. Other answers: `400` missing
file, user or metadata; `403` banned uploader; `413`/`429` [upload limits](#upload-limits);
`503` IPFS unreachable; `507` IPFS repo full. Uploads are also limited to 10 per minute
per IP. A first upload by an unknown username creates its `contentcreators` row.

| Route | Body | Auth |
|---|---|---|
| `PATCH /api/audio/:permlink` | `{ title?, description?, tags?, post_permlink? }` | key + owner |
| `PATCH /api/audio/:permlink/thumbnail` | `{ thumbnail_url }` (http or https, max 2048 chars) | key + owner |
| `PATCH /api/audio/:permlink/post-permlink` | `{ post_permlink }` (max 256 chars) | key + owner |
| `PATCH /api/audio/:permlink/waveform` | `{ waveform: [[…peaks]], duration }` | none, only fills a missing waveform |
| `GET /api/audio/quota` | user from `X-User` or `?owner=` | key |

### Listen counting

A play counts once the listener has streamed 66% of the track, never on load:

```http
POST /api/audio/play-start
{ "permlink": "dkojohs", "username": "badadib" }      // username optional

→ { "sid": "…", "token": "…", "beatSeconds": 3, "threshold": 0.66, "payable": false, "encrypted": false }

POST /api/audio/play-beat
{ "sid": "…", "token": "…" }                          // or { "enc": "<base64>" } with LISTEN_BEAT_KEY

→ { "progress": 0.71, "credited": true, "done": true }
```

- The token is an HMAC over the session, track and IP. The server credits only the real
  time between beats, capped per beat, so a paused tab or a forged beat adds nothing.
- At 66% the server bumps `plays` and writes one row to `audio-listen-log` with
  `username` (or null), `ip`, `listenedSeconds`, `trackDuration`, `ppl`, `payable`,
  `createdAt` and `listenDate`. Repeats inside the dedupe windows are not counted.
- `payable: true` only when the track has `ppl: true` (pay per listen), the listener gave a
  valid Hive name and is not the owner. Anything that pays out per row must skip rows
  with `payable: false`.
- A track with no duration cannot be measured: `play-start` records one listen per IP per
  day and answers `{ "tracked": false, "reason": "no_duration" }`.
- `LISTEN_BEAT_KEY` makes beats AES-256-GCM ciphertext. The player needs the same value as
  `window.LISTEN_BEAT_KEY`, or counting stops. The key ships in public JS, so it only
  deters casual tampering; the time measurement is the real protection.
- `POST /api/audio/play` (`{ permlink }`) is the old count-on-load route, kept for outside
  callers. The bundled player does not use it.

Separately, the player reports anonymous listening time to the 3Speak checker
(`src/listen-time.js`).

### Upload limits

On by default; `AUDIO_DAILY_LIMITS_ENABLED=false` turns them off for your instance. A
limited account may upload `AUDIO_LIMIT_PER_DAY` files per rolling 24 hours, each at most
`AUDIO_MAX_DURATION_SECONDS` long.

- **Exempt:** users with `premium: true` (and no past `premium_expires_at`) in
  `AUDIO_PRO_USERS_COLLECTION`, warm-up accounts the checker reports as incubating that
  have no Hive account, and `AUDIO_LIMIT_EXEMPT`.
- **Not counted:** uploads made with a key from `AUDIO_IMPORT_API_KEYS` plus the header
  `X-Upload-Source: rss_import` (stored as `upload_source: "rss_import"`).
- **Length:** the larger of the declared `duration` and the measured one (ffprobe, else an
  ffmpeg decode). The count is checked before the file is read and the length before it
  is pinned, so a refused upload stores nothing.
- Every lookup fails open: if the database, the checker or Hive cannot answer, the upload
  goes through.

Refusals carry a stable `code`, a full sentence in `message` and a short `error`:

```json
// 413
{ "error": "Audio too long", "code": "audio_too_long", "message": "…",
  "max_seconds": 1200, "duration": 1320, "upgrade_url": "…" }

// 429, plus a Retry-After header
{ "error": "Daily audio upload limit reached", "code": "daily_audio_limit", "message": "…",
  "limit": 2, "used": 2, "next_at": "2026-11-21T14:32:00Z", "retry_after_seconds": 16320, "upgrade_url": "…" }
```

A `429` without `code` is the per-minute rate limit. `GET /api/audio/quota` answers
`{ enabled, exempt, reason, audio: { limit, used, remaining, next_at, max_seconds } }`,
with `reason` one of `"pro"`, `"warmup"`, `"listed"` or `null`; exempt users get `null`
limits.

### Admin API

`/admin` and `/admin/users` are browser pages for the routes below. `POST
/api/admin/login` with `{ password }` returns a token; send it as
`Authorization: Bearer <token>`.

| Route | Does |
|---|---|
| `GET /api/admin/stats` · `/files` · `/category-stats` | Storage figures and the file list |
| `DELETE /api/admin/files/:permlink` | Delete a file |
| `GET /api/admin/users` · `/users/:username` | Uploaders, with stats |
| `PUT /api/admin/users/:username/ban` | Toggle an uploader's ban |
| `GET /api/admin/mp3/stats` | MP3 companion progress |
| `GET /api/admin/migrations/stats` · `/pending` · `/schedule` | Migration queue |
| `POST /api/admin/migrations/trigger` | Run the migration now |
| `POST /api/admin/migrations/:permlink` · `/retry/:permlink` | Migrate or retry one file |

### Data model

Audio rows live in `MONGODB_COLLECTION_AUDIO` (default `embed-audio`). Only rows with
`status: "published"` are served.

```javascript
{
  permlink: "dkojohs",             // 8 characters, unique
  owner: "badadib",
  audio_cid: "bafybei…",
  ipfs_status: "pinned_local",     // or pinned_distributed after migration
  category: "voice_message",       // free text; song, podcast, interview get migrated
  duration: 45, format: "webm", size: 123456,
  title: "…", description: "…", tags: ["…"],
  thumbnail_url: null, post_permlink: null,   // post_permlink links the Hive post
  waveform: { peaks: [/* … */], length: 100 },
  plays: 0, ppl: false,
  upload_source: "upload",         // or rss_import
  migration_status: "pending",     // pending | skip | migrated | …
  pin_until: null,                 // set to +24h for demo uploads
  mp3_checked: true, mp3_status: "converted", mp3_cid: "Qm…", mp3_duration: 146.5,
  createdAt: ISODate("…")
}
```

Indexes are created on start. Other collections: `contentcreators` (uploaders, bans),
`audio-listen-log` and `audio-listen-sessions` (TTL), and, read only, `playlists` and the
premium collection.

### Background jobs

- **MP3 companions** (`server/jobs/mp3Worker.js`). Browser recordings are WebM/Opus,
  which many podcast apps refuse. On every start and after each upload the worker adds a
  CBR MP3 next to the original, pins it locally and stores `mp3_cid`. mp3, m4a and aac
  are marked `not_needed`. Failures retry after `MP3_RETRY_DELAY_MINUTES`, up to
  `MP3_MAX_ATTEMPTS`. With no working ffmpeg it stays idle.
- **Migration** (`server/jobs/migrationWorker.js`, production only). Once a day at
  `MIGRATION_SCHEDULE_HOUR` it pins `song`, `podcast` and `interview` uploads on the
  second node (`IPFS_SUPERNODE_URL`, Kubo API), verifies the pin and marks them
  `pinned_distributed`. Voice messages and demo uploads stay local.
- **Pin audit** (`node server/audit-pins.js`). One-off check of database rows marked
  `pinned_local` against the local node's pins.

## Development and tests

```bash
npm run dev    # nodemon server/index.js
npm start      # node server/index.js
npm run lint   # ESLint
npm test       # node --test server/*.test.js
```

The unit tests (`server/*.test.js`) cover the player's ad and listen-time scripts, the
upload controller, upload limits, MP3 handling, playlists and podcasts, with no database
or IPFS node. The `server/test-*.js` and `test-thumbnail-api.sh` files are manual scripts
against a running server and database.

[CI](.github/workflows/ci.yml) runs `npm ci`, lint and tests on Node 20 and 24 for every
push and pull request to `main`. [Deploy](.github/workflows/deploy.yml) runs the same
checks on push to `main`, then deploys over SSH using `DEPLOY_*` repository secrets.
[`snapieaudio.service`](snapieaudio.service) is a sample systemd unit.

## Repository layout

```
.
├── server/
│   ├── index.js              # Express app: pages, static files, routes, workers
│   ├── routes/
│   │   ├── audio.js          # /api/audio: read, upload, edit, listen, health
│   │   └── admin.js          # /api/admin: password-protected management
│   ├── controllers/          # audio, listen, playlist, podcast, admin handlers
│   ├── models/               # AudioMessage (embed-audio), ContentCreator (contentcreators)
│   ├── middleware/           # API key check, multer upload
│   ├── utils/                # upload limits, duration probe, mp3, Hive posts, size parsing
│   ├── jobs/                 # mp3Worker, migrationWorker
│   ├── audit-pins.js         # one-off pin audit
│   └── *.test.js             # node:test suites
├── src/
│   ├── index.html            # player page (/play)
│   ├── audio-player.js       # player: modes, playlists, waveform, chips, tip, counting
│   ├── audio-ad.js           # sponsored audio spots
│   ├── listen-time.js        # listening time reports
│   ├── audio-styles.css      # player styles
│   ├── index-landing.html    # landing page (/)
│   ├── docs.html             # API docs page (/docs)
│   ├── demo.html             # demo upload page (/demo)
│   └── admin*.html           # admin pages (/admin, /admin/users)
├── .github/workflows/        # ci.yml, deploy.yml
├── snapieaudio.service       # sample systemd unit
└── .env.example              # settings template
```

## Security notes

- **Always set `ADMIN_PASSWORD`.** The admin token is `base64("admin:" + password)`, so
  it is as secret as the password itself, and with the variable unset the expected token
  is a fixed, guessable string. Serve the admin pages over HTTPS only.
- **API keys are full upload rights.** Any holder can upload as any `X-User`; give keys
  only to servers you trust, and keep `AUDIO_IMPORT_API_KEYS` server-side. The key used
  by `/demo` ships in that page's HTML, so treat `DEMO_API_KEY` as public.
- **`LISTEN_BEAT_KEY` is not a secret** once set, since the player needs it in public
  JS. Listen counting relies on server-side timing, the HMAC token and dedupe windows.
- **CORS is open** (`cors()` with no origin list) because the player and read API are
  meant to be embedded. Restrict it in `server/index.js` if your deployment needs to.
- **Rate limits key on the client IP.** Behind a proxy set `TRUST_PROXY` to the right
  number of hops, or every listener shares one bucket.

## Contributing

Issues and pull requests are welcome. Chat with us on [Discord](https://discord.gg/NSFS2VGj83).

## License

[MIT](LICENSE) © Mantequilla Soft.
