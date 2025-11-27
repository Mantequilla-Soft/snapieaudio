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
  "duration": 45,
  "format": "mp3",
  "waveform": [0.2, 0.5, 0.8, ...],
  "audioUrl": "https://ipfs.3speak.tv/ipfs/bafy...",
  "audioUrlFallback": "https://dweb.link/ipfs/bafy...",
  "plays": 150
}
```

### Track Play Count

```http
POST /api/audio/play
Content-Type: application/json

{
  "permlink": "dkojohs"
}

Response:
{
  "success": true,
  "plays": 151
}
```

## 📊 MongoDB Schema

```javascript
{
  permlink: "dkojohs",        // Unique 8-char ID
  author: "meno",
  cid: "bafybeigdyrzt5...",  // IPFS CID
  duration: 45,               // Seconds
  format: "mp3",
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
