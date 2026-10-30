/**
 * Listening time, measured by the 3Speak checker the way 3speak.tv's own audio
 * player and video watch time are (3speakchecks routes/audioListen.js):
 *
 *   POST {api}/audio/listen/start { kind: 'audio', id: <permlink>, duration, position, source: 'embed' }
 *   POST {api}/audio/listen/beat  { sid, token, position, rate, hidden }
 *
 * ANONYMOUS: the embed never names the listener (listener rewards are 3speak.tv
 * only). The checker times the beats itself and counts only forward playback, so
 * nothing here can claim listening that did not happen. Separate from the
 * pay-per-listen counter above, which is unchanged.
 *
 * The checker address can be overridden with window.SNAPIE_LISTEN_API.
 */
class ListenTimeTracker {
  constructor(permlink) {
    this.api = `${(window.SNAPIE_LISTEN_API || 'https://checker.3speak.tv').replace(/\/+$/, '')}/audio/listen`;
    this.permlink = permlink;
    this.sid = null;
    this.token = null;
    this.beatMs = 10000;
    this.lastBeatAt = 0;
    this.lastTime = 0;
    this.starting = false;
  }

  async start(media) {
    if (this.sid || this.starting || !this.permlink) return;
    this.starting = true;
    try {
      const res = await fetch(`${this.api}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'audio',
          id: this.permlink,
          duration: Number.isFinite(media.duration) && media.duration > 0 ? media.duration : undefined,
          position: media.currentTime || 0,
          source: 'embed',
        }),
      });
      const data = res.ok ? await res.json() : null;
      if (data && data.sid) {
        this.sid = data.sid;
        this.token = data.token;
        this.beatMs = Math.max(2000, (Number(data.beatSeconds) || 10) * 1000);
        this.lastBeatAt = Date.now();
      }
    } catch (_) {
      // Listening without measuring is fine.
    } finally {
      this.starting = false;
    }
  }

  beat(media, position = media.currentTime) {
    if (!this.sid) return;
    this.lastBeatAt = Date.now();
    try {
      fetch(`${this.api}/beat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sid: this.sid, token: this.token, position, rate: media.playbackRate || 1,
          hidden: document.visibilityState === 'hidden',
        }),
        // Survives the page or the iframe closing.
        keepalive: true,
      }).catch(() => {});
    } catch (_) { /* best effort */ }
  }

  /** While playing: remember the position (a seek moves it first) and beat on schedule. */
  tick(media) {
    this.lastTime = media.currentTime;
    if (this.sid && !media.paused && Date.now() - this.lastBeatAt >= this.beatMs) this.beat(media);
  }

  /** Wire to the media element. Returns nothing; lives as long as the page. */
  attach(media) {
    // 'seeking' fires with the NEW time already set: credit the stretch up to the jump.
    media.addEventListener('seeking', () => this.beat(media, this.lastTime));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && !media.paused) this.beat(media);
    });
    window.addEventListener('pagehide', () => { if (!media.paused) this.beat(media); });
  }
}

// The browser gets a global; Node (server/listen-time.test.js) gets a module.
if (typeof module !== 'undefined' && module.exports) module.exports = { ListenTimeTracker };
else window.ListenTimeTracker = ListenTimeTracker;
