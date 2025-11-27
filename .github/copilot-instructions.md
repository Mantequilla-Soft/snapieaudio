# SnapieAudioPlayer - Copilot Instructions

## Project Overview
Lightweight HTML5 audio player for voice messages and audio content on 3speak/Snapie ecosystem. Features waveform visualization using WaveSurfer.js.

## Tech Stack
- **Frontend**: Vanilla JavaScript, WaveSurfer.js, HTML5 Audio API
- **Backend**: Node.js, Express.js
- **Database**: MongoDB
- **Storage**: IPFS (via CID)

## Code Style
- Use ES6+ features (async/await, arrow functions, destructuring)
- Prefer `const` over `let`, avoid `var`
- Use template literals for string concatenation
- Keep functions small and focused
- Add JSDoc comments for public APIs

## Project Structure
```
src/          - Frontend audio player code
server/       - Backend API (routes, controllers, models)
assets/       - Static files (icons, styles)
docs/         - Internal documentation (gitignored)
```

## Key Concepts
- **Permlink**: 8-character unique ID for audio (e.g., "dkojohs")
- **CID**: IPFS Content Identifier for audio files
- **Waveform**: Pre-computed amplitude peaks for visualization

## Development Guidelines
- Keep player bundle size < 100KB
- Support mobile touch controls
- Implement IPFS gateway fallbacks
- Validate CIDs before processing
- Use rate limiting for API endpoints

## Testing
- Test with various audio formats (MP3, OGG, WEBM)
- Test IPFS gateway fallback scenarios
- Mobile-first responsive design
