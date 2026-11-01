/**
 * Sponsored audio spots in the embed: a 3Speak ticker ad read out by the checker's
 * text to speech, or an advertiser's own uploaded clip (no text then, `message: ''`),
 * played at its booked position while the track waits
 * (3speakchecks routes/adServe.js, surface 'audio'). Same behaviour as the audio
 * player on 3speak.tv.
 *
 *   POST {api}/m/session { surface: 'audio', audioSpot: true, owner, permlink, ... }
 *     -> { audioAd: { audioUrl, durationSeconds, positionPercent, message, productName,
 *                     clickUrl, shownUrl, adKey, capMinutes, label } } or { ad: null }
 *   POST audioAd.shownUrl once the spot played to its end (the impression)
 *
 * The checker decides everything: which creators' audio carries spots, the creator's
 * own "Ads on your audio" choice, frequency caps. This only plays what comes back.
 *
 * While the spot plays the player's controls drive it, and the track's own element is
 * paused (so the listen counters do not count the spot). Fails open everywhere: a spot
 * that cannot play is dropped and the track goes on. One spot per page.
 *
 * The checker address can be overridden with window.SNAPIE_AD_API.
 */
const SEEN_KEY = '3speak-ads-seen';
const SEEN_MINUTES = 15;
const STALL_MS = 8000;
// A pre-roll that started later than this into the track does not rewind it.
const REWIND_WITHIN_S = 3;

function readSeen(storage) {
  try {
    const raw = JSON.parse(storage.getItem(SEEN_KEY) || '{}');
    const cutoff = Date.now() - SEEN_MINUTES * 60 * 1000;
    const out = {};
    for (const [k, t] of Object.entries(raw)) if (Number(t) > cutoff) out[k] = Number(t);
    return out;
  } catch { return {}; }
}

/* The same seen-list 3speak.tv keeps (one per site): which ADS were shown, never which
 * audio was heard, each entry gone within the cap window. It can only cost a listener
 * ads, never earn any. An entry dated back drops out after the ad's own shorter cap. */
function rememberSeen(storage, key, minutes) {
  if (!key) return;
  try {
    const seen = readSeen(storage);
    const m = Number(minutes);
    seen[key] = m > 0 && m < SEEN_MINUTES ? Date.now() - (SEEN_MINUTES - m) * 60 * 1000 : Date.now();
    storage.setItem(SEEN_KEY, JSON.stringify(seen));
  } catch { /* storage unavailable */ }
}

function normalizeSpot(a) {
  if (!a || typeof a.audioUrl !== 'string' || !/^https:\/\//i.test(a.audioUrl)) return null;
  const durationSeconds = Number(a.durationSeconds);
  // An uploaded audio spot (the advertiser's own clip) has no text: message is ''.
  if (!(durationSeconds > 0)) return null;
  const https = (u) => (typeof u === 'string' && /^https:\/\//i.test(u) ? u : null);
  return {
    audioUrl: a.audioUrl,
    durationSeconds,
    positionPercent: Math.min(100, Math.max(0, Number(a.positionPercent) || 0)),
    message: typeof a.message === 'string' ? a.message : '',
    productName: a.productName || null,
    clickUrl: https(a.clickUrl),
    shownUrl: https(a.shownUrl),
    adKey: a.adKey || null,
    capMinutes: Number(a.capMinutes) || null,
    label: a.label || 'Ad',
  };
}

class AudioAdSpot {
  /**
   * @param owner, permlink  the embed-audio track
   * @param viewer           optional Hive name (the page's ?user=), as the listen counter uses
   * @param onChange         (phase, spot) => void; phase 'idle' | 'playing' | 'paused' | 'heard'
   */
  constructor({ owner, permlink, viewer = null, onChange = () => {} }) {
    this.api = (window.SNAPIE_AD_API || 'https://checker.3speak.tv').replace(/\/+$/, '');
    this.owner = owner;
    this.permlink = permlink;
    this.viewer = viewer;
    this.onChange = onChange;
    this.storage = (() => { try { return window.localStorage; } catch { return null; } })() || { getItem: () => null, setItem: () => {} };
    this.capId = Array.from((globalThis.crypto?.getRandomValues?.(new Uint8Array(12))) || [], (b) => b.toString(16).padStart(2, '0')).join('') || null;
    this.spot = null;
    this.el = null;
    this.media = null;
    this.active = false;
    this.started = false;
    this.done = false;
    this.resumeAt = 0;
    this.lastProgressAt = 0;
    this.watchdog = null;
  }

  /** Ask the checker. Resolves to the spot or null; never throws. */
  async request() {
    if (!this.owner || !this.permlink) return null;
    try {
      const res = await fetch(`${this.api}/m/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          surface: 'audio',
          audioSpot: true,
          owner: this.owner,
          permlink: this.permlink,
          viewer: this.viewer || null,
          capId: this.capId,
          recentAdKeys: Object.keys(readSeen(this.storage)),
        }),
      });
      if (!res.ok) return null;
      const spot = normalizeSpot((await res.json())?.audioAd);
      if (!spot) return null;
      this.spot = spot;
      // Fetching the sound records nothing, so it is loaded ahead.
      this.el = new Audio();
      this.el.preload = 'auto';
      this.el.src = spot.audioUrl;
      this.bindAd();
      if (this.media) this.check();
      return spot;
    } catch {
      return null;
    }
  }

  /** The track's media element (WaveSurfer's). Call once the track is loaded. */
  attach(media) {
    this.media = media;
    media.addEventListener('play', () => this.onMainPlay());
    media.addEventListener('timeupdate', () => this.onMainTime());
    media.addEventListener('volumechange', () => { if (this.el) { this.el.volume = media.volume; this.el.muted = media.muted; } });
    if (this.spot) this.check();
  }

  /** Play/pause of the spot for the player's own button. False when no spot runs. */
  toggle() {
    if (!this.active || !this.el) return false;
    if (this.el.paused) this.el.play().catch(() => this.finish(false)); else this.el.pause();
    return true;
  }

  bindAd() {
    const el = this.el;
    el.addEventListener('play', () => { if (this.active) { this.started = true; this.onChange('playing', this.spot); } });
    el.addEventListener('pause', () => { if (this.active && !el.ended) this.onChange('paused', this.spot); });
    el.addEventListener('timeupdate', () => { this.lastProgressAt = Date.now(); });
    el.addEventListener('ended', () => this.finish(true));
    el.addEventListener('error', () => this.finish(false));
  }

  // When the booked position is reached: the time to resume from, else null.
  due() {
    if (!this.spot || !this.el || this.active || this.done || !this.media) return null;
    const pct = this.spot.positionPercent;
    if (pct <= 0) return 0;
    const d = this.media.duration;
    if (!(Number.isFinite(d) && d > 0)) return null;
    const at = (pct / 100) * d;
    return this.media.currentTime >= at ? at : null;
  }

  check() {
    if (this.media && !this.media.paused && !this.active) {
      const at = this.due();
      if (at != null) this.begin(at);
    }
  }

  onMainPlay() {
    // During the spot a play on the track means play/pause of the spot.
    if (this.active) {
      this.media.pause();
      this.toggle();
      return;
    }
    const at = this.due();
    if (at != null) this.begin(at);
  }

  onMainTime() {
    if (this.active) { if (!this.media.paused) this.media.pause(); return; }
    this.check();
  }

  begin(at) {
    this.active = true;
    this.started = false;
    this.resumeAt = at;
    this.lastProgressAt = Date.now();
    this.media.pause();
    this.el.volume = this.media.volume;
    this.el.muted = this.media.muted;
    try { this.el.currentTime = 0; } catch { /* not loaded yet */ }
    this.onChange('playing', this.spot);
    this.el.play().then(() => rememberSeen(this.storage, this.spot.adKey, this.spot.capMinutes))
      .catch(() => this.finish(false));
    this.watchdog = setInterval(() => {
      if (this.active && !this.el.paused && Date.now() - this.lastProgressAt > STALL_MS) this.finish(false);
    }, 1000);
    // Node (the tests) only: never what keeps a process alive.
    this.watchdog?.unref?.();
  }

  finish(heard) {
    if (!this.active) return;
    // Resume unless the listener had paused the spot. A spot only begins on a
    // playing track, so one that never got going resumes it.
    const resume = heard || !this.started || !this.el.paused;
    this.active = false;
    this.done = true;
    clearInterval(this.watchdog);
    try { this.el.pause(); } catch { /* gone */ }
    if (heard && this.spot.shownUrl) {
      try {
        fetch(this.spot.shownUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', keepalive: true })
          .catch(() => {});
      } catch { /* the advertiser's loss, never the listener's */ }
    }
    this.onChange(heard ? 'heard' : 'idle', this.spot);
    const m = this.media;
    if (m.currentTime > this.resumeAt && m.currentTime - this.resumeAt < REWIND_WITHIN_S) m.currentTime = this.resumeAt;
    if (resume) m.play().catch(() => {});
  }
}

// The browser gets a global; Node (server/audio-ad.test.js) gets a module.
if (typeof module !== 'undefined' && module.exports) module.exports = { AudioAdSpot, normalizeSpot };
else window.AudioAdSpot = AudioAdSpot;
