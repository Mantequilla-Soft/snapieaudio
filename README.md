# 🎵 SnapieAudioPlayer

Lightweight HTML5 audio player for voice messages and audio content on the 3speak/Snapie ecosystem. Features waveform visualization using WaveSurfer.js and IPFS content delivery.

## ✨ Features

- **🎨 WhatsApp/Discord-style UI** - Clean, mobile-first interface
- **📊 Waveform Visualization** - Interactive audio scrubbing with WaveSurfer.js
- **⚡ IPFS-powered** - Decentralized audio storage with automatic gateway fallback
- **🔗 Dual Access Modes** - Support for both permlinks (database) and direct CID playback
- **📱 Mobile-optimized** - Touch controls, responsive design
- **⏩ Speed Control** - 1x, 1.5x, 2x playback speeds
- **📈 Play Tracking** - MongoDB-based analytics and engagement metrics
- **🔒 Rate-limited** - Protection against API abuse
- **🎵 Content Categories** - Distinguish between ephemeral voice messages and permanent content (podcasts, songs, interviews)
- **🖼️ Thumbnail Support** - Optional cover art/artwork URLs for audio entries
- **📡 Feed API** - Public endpoints for building discovery feeds, trending pages, tag browsing, and user profiles
- **🏷️ Tag System** - Content tagging for discovery and filtering

## 🏗️ Architecture

```
Player (Frontend) ──→ Express API ──→ MongoDB ──→ IPFS Network
   ↓                      ↓              ↓            ↓
WaveSurfer.js        Audio Routes   Metadata    Audio Files
HTML5 Audio          Controllers    Schema      (CID-based)
```

## 📋 Prerequisites

- **Node.js** v16+ and npm
- **MongoDB** v5+ (local or remote)
- **IPFS Gateway** access (defaults to ipfs.3speak.tv)

## 🚀 Quick Start

### 1. Clone and Install

```bash
git clone <repository-url>
cd snapieaudio
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your settings:

```env
PORT=3000
MONGODB_URI=mongodb://localhost:27017/snapieaudio
IPFS_PRIMARY_GATEWAY=https://ipfs.3speak.tv/ipfs/
```

### 3. Start Server

```bash
# Development mode (with nodemon)
npm run dev

# Production mode
npm start
```

### 4. Test Player

Open your browser:

```
# Direct CID playback (no database needed)
http://localhost:3000/play?cid=bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabq...

# Permlink-based playback (requires database entry)
http://localhost:3000/play?a=dkojohs
```

## 📁 Project Structure

```
snapieaudio/
├── src/                      # Frontend audio player
│   ├── index.html           # Player page template
│   ├── audio-player.js      # Player logic (WaveSurfer)
│   └── audio-styles.css     # Player styling
├── server/                   # Backend API
│   ├── index.js             # Express server
│   ├── routes/
│   │   └── audio.js         # Audio API routes
│   ├── controllers/
│   │   └── audioController.js
│   └── models/
│       └── AudioMessage.js  # MongoDB schema
├── assets/                   # Static assets (icons, etc.)
├── docs/                     # Internal documentation (gitignored)
│   └── AUDIO_PLAYER_DESIGN.md
├── package.json
└── .env.example
```

## 🔌 API Endpoints

### Get Audio Metadata

```http
GET /api/audio?a=dkojohs
GET /api/audio?cid=bafybeig...

Response:
{
  "permlink": "dkojohs",
  "author": "meno",
  "cid": "bafybeigdyrzt5...",
  "category": "voice_message",
  "duration": 45,
  "format": "mp3",
  "waveform": [0.2, 0.5, 0.8, ...],
  "title": "My Audio",
  "description": "This is an example audio recording",
  "tags": ["music", "podcast", "interview"],
  "thumbnail_url": "https://files.hive.blog/file/hiveimages/cover.jpg",
  "post_permlink": "my-audio-snap-2026",
  "audioUrl": "https://ipfs.3speak.tv/ipfs/bafy...",
  "audioUrlFallback": "https://dweb.link/ipfs/bafy...",
  "plays": 150
}
```

### Get Audio Feed

```http
GET /api/audio/feed?limit=20&offset=0&sort=newest

Query Parameters:
- limit: Items per page (default 20, max 100)
- offset: Pagination offset (default 0)
- sort: newest|oldest|plays|trending (default newest)
- category: voice_message|podcast|song|interview|audiobook|noise_sample
- tag: Filter by tag (e.g., "music")
- owner: Filter by username

Response:
{
  "items": [
    {
      "permlink": "abc123xy",
      "owner": "meno",
      "audio_cid": "QmdMsEX...",
      "category": "podcast",
      "duration": 1800,
      "format": "mp3",
      "title": "My Podcast",
      "tags": ["podcast", "tech"],
      "thumbnail_url": "https://...",
      "plays": 152,
      "createdAt": "2026-02-20T10:30:00Z",
      "audioUrl": "https://ipfs.3speak.tv/ipfs/...",
      ...
    }
  ],
  "pagination": {
    "limit": 20,
    "offset": 0,
    "total": 156,
    "hasMore": true
  }
}

Examples:
GET /api/audio/feed?sort=plays              # Trending audio
GET /api/audio/feed?category=podcast        # All podcasts
GET /api/audio/feed?tag=music&sort=plays    # Trending music
GET /api/audio/feed?owner=meno              # User's audio
```

### Track Listens (event-driven)

A play is counted only after the listener has **genuinely streamed ≥66%** of
the track — never on mere load. The player opens a server-measured session and
sends a heartbeat (~every 3s, plus a final one on pause/finish) while the
audio is actually advancing; the
server credits only the wall-clock gap it observes between beats (clamped per
beat), so a play can't be forged with a single request.

```http
POST /api/audio/play-start
Content-Type: application/json

{ "permlink": "dkojohs", "username": "alice" }   // username optional (anonymous embed omits it)

Response:
{ "sid": "…", "token": "…", "beatSeconds": 3, "threshold": 0.66, "payable": false, "encrypted": false }
```

```http
POST /api/audio/play-beat
Content-Type: application/json

{ "sid": "…", "token": "…" }      // or { "enc": "<base64>" } when LISTEN_BEAT_KEY is set

Response:
{ "progress": 0.71, "credited": true, "done": true }
```

At ≥66% the server bumps `plays` and writes **one row to `audio-listen-log`**
(deduped per listener — by username when logged in, else by IP). Every credited
listen lives in this one collection for reporting, each carrying:

- `payable: false` — anonymous / non-`ppl` / self / unmeasured listen. Counts
  toward `plays` and analytics only.
- `payable: true` — logged-in listener on a pay-per-listen (`ppl`) track who is
  not the author; eligible for the weekly payout.
- `listenedSeconds` + `trackDuration` — how much of the track was genuinely
  streamed, tagged with `ip` and `username` (null when anonymous).
- `createdAt` (full timestamp) + `listenDate` (UTC `YYYY-MM-DD`) — when the
  listen happened, for time-series reporting and consolidation grouping.

After 5 months a checker cron folds each track's old rows into its `embed-audio`
doc (`archivedListens` / `archivedPayableListens`) and deletes them, so the
collection stays bounded while lifetime totals are preserved.

> ⚠️ **Payout coupling:** the shared 3speak-checker payout worker credits the
> track owner for every row, so it filters `payable: { $ne: false }` to skip
> anonymous rows. Both services must be deployed together.

A track with **missing/zero duration** can't be measured, so `play-start`
records one full listen (deduped by IP per day, `payable:false`) and returns
`{ "tracked": false, "reason": "no_duration" }` instead of a session.

> **Legacy:** `POST /api/audio/play` (blind count-on-load) still exists for
> backward compatibility but the bundled player no longer calls it.

```http
POST /api/audio/play
Content-Type: application/json

{ "permlink": "dkojohs" }

Response:
{ "success": true, "plays": 151 }
```

## 📊 MongoDB Schema

```javascript
{
  permlink: "dkojohs",        // Unique 8-char ID
  author: "meno",
  cid: "bafybeigdyrzt5...",  // IPFS CID
  category: "voice_message",  // Content type: voice_message, podcast, song, interview, audiobook, noise_sample
  duration: 45,               // Seconds
  format: "mp3",
  title: "My Audio",
  description: "This is an example audio recording",
  tags: ["music", "podcast"],  // Array of content discovery tags
  thumbnail_url: "https://files.hive.blog/...",  // Optional cover art
  post_permlink: "my-audio-snap-2026",  // Optional blockchain post reference
  waveform: {
    peaks: [0.2, 0.5, ...],
    length: 100
  },
  plays: 150,
  created: ISODate("2025-11-26T10:30:00Z"),
  status: "active"
}
```

## 🎨 Usage Examples

### Embed in HTML

```html
<iframe 
  src="https://audio.3speak.tv/play?a=dkojohs" 
  width="600" 
  height="100" 
  frameborder="0">
</iframe>
```

### React Component

```jsx
const AudioMessage = ({ permlink }) => (
  <iframe 
    src={`https://audio.3speak.tv/play?a=${permlink}`}
    style={{ border: 'none', width: '100%', height: '100px' }}
    allow="autoplay"
  />
);
```

### What an embedder needs to do

**Nothing.** Listen tracking is entirely self-contained in the player the
iframe loads from this server — it calls same-origin endpoints, so there are
no scripts, keys, or CORS setup to add on the host page.

- **Existing embeds upgrade automatically.** The iframe fetches the player
  fresh from the server on every load, so once this server is deployed there's
  nothing to change in already-placed embeds.
- **Counting requires real playback.** Heartbeats fire from the audio's
  `audioprocess` event, so a play is counted only after the listener genuinely
  streams ≥66% of the track. Keep `allow="autoplay"` if you want playback (and
  therefore counting) to start on its own; otherwise it begins on first play.
- **Optional — credit a listener (pay-per-listen):** pass a Hive username so a
  qualifying listen on a `ppl` track earns a credit. The default embed is
  anonymous and still counts toward the public `plays` stat.

  ```html
  <iframe src="https://audio.3speak.tv/play?a=dkojohs&user=alice"></iframe>
  ```

### Handing over the logged-in username

Other frontends can identify the listener two ways — both feed the same
server-measured session, and both are optional (omit → anonymous, which still
counts toward `plays`):

1. **Embedding the iframe** — append `?user=<hive-username>` to the player URL
   (as above). The bundled player reads it and sends it on `play-start`. The
   embedding page is responsible for only setting it for a genuinely logged-in
   user.
2. **Calling the API directly** (custom player) — send the username in the
   `play-start` body:

   ```http
   POST /api/audio/play-start
   { "permlink": "dkojohs", "username": "alice" }
   ```

The username is only honoured if it's a valid Hive name; a listen earns the
author only when the track is `ppl`, the user is logged in, and the user is not
the track owner (self-listens never pay). Anonymous listens on a `ppl` track
still credit the author at a reduced weight.

> **Operators (deploying this server), not embedders:** the new
> `/api/audio/play-start` + `/play-beat` routes must be live or the player
> degrades gracefully (no counting, no errors). If you set `LISTEN_BEAT_KEY`,
> you must also inject the **same** value into the player page as
> `window.LISTEN_BEAT_KEY`, or the server will require encrypted beats the
> client can't produce and counting silently stops. Left unset, beats are
> plaintext and everything works out of the box.

## 🛠️ Development

### Available Scripts

```bash
npm start      # Start production server
npm run dev    # Start development server with nodemon
npm test       # Run tests (to be implemented)
```

### Adding Test Data

Create a sample audio entry in MongoDB:

```javascript
db.audio_messages.insertOne({
  permlink: "testaud1",
  author: "testuser",
  cid: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabq...",
  duration: 45,
  format: "mp3",
  bitrate: 128,
  waveform: { peaks: Array(100).fill(0).map(() => Math.random()), length: 100 },
  title: "Test Audio",
  plays: 0,
  created: new Date(),
  status: "active",
  visibility: "public"
});
```

Test it:
```
http://localhost:3000/play?a=testaud1
```

## 🔧 Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3000 | Server port |
| `MONGODB_URI` | mongodb://localhost:27017 | MongoDB connection |
| `DB_NAME` | snapieaudio | Database name |
| `IPFS_PRIMARY_GATEWAY` | ipfs.3speak.tv/ipfs/ | Primary IPFS gateway |
| `IPFS_FALLBACK_GATEWAY_1` | dweb.link/ipfs/ | Fallback gateway #1 |
| `IPFS_FALLBACK_GATEWAY_2` | cloudflare-ipfs.com/ipfs/ | Fallback gateway #2 |
| `RATE_LIMIT_WINDOW_MS` | 60000 | Rate limit window |
| `RATE_LIMIT_MAX_REQUESTS` | 100 | Max requests per window |

### MongoDB Indexes

Indexes are automatically created on startup:

```javascript
db.audio_messages.createIndex({ permlink: 1 }, { unique: true })
db.audio_messages.createIndex({ author: 1, created: -1 })
db.audio_messages.createIndex({ cid: 1 })
db.audio_messages.createIndex({ created: -1 })
```

## 🌐 Live Pages

- **Landing Page**: `https://audio.3speak.tv/` - Project overview and features
- **Demo Upload**: `https://audio.3speak.tv/demo` - Try uploading audio (24h expiry)
- **Admin Panel**: `https://audio.3speak.tv/admin` - Storage management (password protected)
- **Player**: `https://audio.3speak.tv/play?a=PERMLINK` - Audio playback

## 🚦 Roadmap

### Phase 1: MVP ✅
- [x] Basic player with WaveSurfer.js
- [x] MongoDB schema & API endpoints
- [x] CID-based playback
- [x] IPFS gateway fallback
- [x] Play tracking

### Phase 2: Upload System ✅
- [x] Audio upload endpoint with API key auth
- [x] IPFS pinning (local node)
- [x] Permlink auto-generation
- [x] File validation & processing
- [x] Demo upload page
- [x] Admin storage management panel

### Phase 3: Enhancement
- [ ] Speed control UI
- [ ] Download functionality
- [ ] Share buttons
- [ ] Mobile app integration

### Phase 4: Integration
- [ ] React component library
- [ ] Snapie chat integration
- [ ] Hive blockchain support
- [ ] Podcast RSS feeds

## 🐛 Troubleshooting

### Player won't load audio

1. Check IPFS gateway is accessible:
   ```bash
   curl https://ipfs.3speak.tv/ipfs/<your-cid>
   ```

2. Verify MongoDB connection:
   ```bash
   mongosh mongodb://localhost:27017/snapieaudio
   db.audio_messages.find()
   ```

3. Check browser console for errors

### CORS issues

If embedding in external sites, update CORS settings in `server/index.js`:

```javascript
app.use(cors({
  origin: ['https://yourdomain.com'],
  credentials: true
}));
```

## 🤝 Contributing

Contributions welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## 📄 License

MIT License - see LICENSE file for details

## 🔗 Related Projects

- [WaveSurfer.js](https://wavesurfer-js.org/) - Audio waveform visualization
- [3speak](https://3speak.tv/) - Decentralized video platform
- [IPFS](https://ipfs.tech/) - Distributed file system

## 📧 Contact

For questions or support, reach out to the 3speak/Snapie team.

---

**Built with ❤️ for the 3speak/Snapie ecosystem**
