/**
 * SnapieAudioPlayer - Main player initialization and control
 * Handles audio playback, waveform visualization, and IPFS content loading
 */

// Optional heartbeat obfuscation — AES-256-GCM with a key derived from a
// shared LISTEN_BEAT_KEY (must match the server's). Output is
// base64(iv|ciphertext|tag), the layout the backend expects. Best-effort: any
// failure → null so the caller falls back to a plaintext beat. The key, if
// present, is injected as window.LISTEN_BEAT_KEY by the page; it ships in the
// public bundle, so this is anti-casual-tampering only.
let _beatKeyPromise = null;
function getBeatKey() {
  const k = (typeof window !== 'undefined' && window.LISTEN_BEAT_KEY) || '';
  if (!k || !globalThis.crypto?.subtle) return null;
  if (!_beatKeyPromise) {
    _beatKeyPromise = (async () => {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(k));
      return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt']);
    })().catch(() => null);
  }
  return _beatKeyPromise;
}
async function encryptBeat(obj) {
  try {
    const key = await getBeatKey();
    if (!key) return null;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj)))
    );
    const out = new Uint8Array(iv.length + ct.length);
    out.set(iv); out.set(ct, iv.length);
    let bin = '';
    for (let i = 0; i < out.length; i++) bin += String.fromCharCode(out[i]);
    return btoa(bin);
  } catch { return null; }
}

// Listening time: ListenTimeTracker lives in listen-time.js (loaded before this file).

class SnapieAudioPlayer {
  constructor() {
    this.wavesurfer = null;
    this.audioData = null;
    this.currentSpeed = 1;
    this.speeds = [1, 1.5, 2];
    this.speedIndex = 0;
    this.mode = 'full'; // 'minimal', 'compact', 'full'
    this.peaksProvided = false; // tracks whether waveform was pre-loaded from DB
    this.durationHealTolerance = 1; // seconds
    this.durationReconciled = false;

    // Event-driven listen tracking. A play is only counted once ≥66% of the
    // track has genuinely streamed: we open a server-measured session on
    // first playback and send a heartbeat (throttled to beatMs) while the
    // audio is actually advancing. The server measures the real wall-clock
    // gap between beats, so a play can't be forged with a single request.
    this.listen = { permlink: null, sid: null, token: null, beatMs: 10000, lastBeatAt: 0, credited: false, encrypted: false, starting: false };
    // Listening time for every play, anonymous (ListenTimeTracker above). Created
    // once the track's permlink is known; a CID-only load has nothing to report on.
    this.listenTime = null;
    // Playlist embed (/play?list=<id>): its tracks and the one loaded now.
    this.playlist = null;
    this.trackIndex = -1;
    this.loadSeq = 0;

    this.detectMode();
    this.initializePlayer();
    this.setupEventListeners();
    this.loadAudioFromURL();
  }

  /**
   * Detect display mode from URL parameters
   */
  detectMode() {
    const params = new URLSearchParams(window.location.search);
    const mode = params.get('mode');

    if (['minimal', 'compact', 'full'].includes(mode)) {
      this.mode = mode;
    }

    // Auto-detect iframe embedding — always transparent when inside another page
    const isEmbedded = window !== window.top;
    const iframeParam = params.get('iframe');
    if (isEmbedded || iframeParam === '1' || iframeParam === 'true') {
      document.body.classList.add('iframe-mode');
      document.body.classList.add('dark-theme'); // embedded always uses the dark theme
      // Slight dark backdrop by default (see audio-styles.css); ?bg=transparent drops it
      if (params.get('bg') === 'transparent') {
        document.body.classList.add('bg-transparent');
      }
    } else if (params.get('theme') === 'dark') {
      document.body.classList.add('dark-theme');
    }
    
    // Apply mode class to container
    const container = document.getElementById('audio-player-container');
    container.classList.add(`mode-${this.mode}`);
    
    // Hide elements based on mode
    if (this.mode === 'minimal') {
      document.getElementById('player-header').style.display = 'none';
      document.getElementById('side-chips').style.display = 'none';
    } else if (this.mode === 'compact') {
      document.getElementById('player-header').style.display = 'none';
    }
  }

  /**
   * Initialize WaveSurfer instance
   */
  initializePlayer() {
    // Adjust waveform height based on mode
    const heights = {
      minimal: 30,
      compact: 50,
      full: 60
    };
    
    const isDark = document.body.classList.contains('dark-theme');
    this.wavesurfer = WaveSurfer.create({
      container: '#waveform-container',
      waveColor: isDark ? 'rgba(255,255,255,0.25)' : '#ddd',
      progressColor: '#4a9eff',
      cursorColor: '#4a9eff',
      barWidth: this.mode === 'minimal' ? 2 : 3,
      barRadius: 3,
      cursorWidth: this.mode === 'minimal' ? 1 : 2,
      height: heights[this.mode],
      barGap: this.mode === 'minimal' ? 1 : 2,
      responsive: true,
      normalize: true
    });

    // WaveSurfer event listeners
    this.wavesurfer.on('ready', () => this.onAudioReady());
    // While a sponsored spot plays the track is paused, and the button is the spot's.
    this.wavesurfer.on('play', () => {
      if (!this.adSpot?.active) this.updatePlayPauseButton(true);
      if (this.listenTime) this.listenTime.start(this.wavesurfer.getMediaElement());
    });
    this.wavesurfer.on('pause', () => {
      if (!this.adSpot?.active) this.updatePlayPauseButton(false);
      // Send a final measured beat for the sliver since the last one — lets a
      // listener who pauses just past the threshold still be counted.
      this.beatOnce();
      if (this.listenTime) this.listenTime.beat(this.wavesurfer.getMediaElement());
    });
    // A track that finishes before the first interval (e.g. a short voice
    // message) never fires an audioprocess beat — this final beat at the end
    // captures the full genuine play so short clips still count.
    this.wavesurfer.on('finish', () => {
      this.beatOnce();
      const media = this.wavesurfer.getMediaElement();
      if (this.listenTime) this.listenTime.beat(media, Number.isFinite(media.duration) ? media.duration : media.currentTime);
      // A playlist plays on into its next track.
      if (this.playlist && this.trackIndex < this.playlist.tracks.length - 1) {
        this.loadTrack(this.trackIndex + 1, true);
      }
    });
    this.wavesurfer.on('audioprocess', () => {
      this.updateTimeDisplay();
      // audioprocess only fires while audio is genuinely advancing (not when
      // paused), so it doubles as our "still listening" signal. Beat at most
      // once per interval; the server measures the real gap between beats.
      const L = this.listen;
      if (L.sid && !L.credited && Date.now() - L.lastBeatAt >= L.beatMs) {
        this.beatOnce();
      }
      if (this.listenTime) this.listenTime.tick(this.wavesurfer.getMediaElement());
    });
    this.wavesurfer.on('error', (error) => this.handleError(error));

    this.wavesurfer.getMediaElement().addEventListener('loadedmetadata', () => {
      if (!this.durationReconciled && this.audioData && this.audioData.permlink) {
        this.reconcileAudioMetadata(this.audioData.permlink);
      }
    });
  }

  /**
   * Set up UI event listeners
   */
  setupEventListeners() {
    const playPauseBtn = document.getElementById('play-pause-btn');
    const speedBtn = document.getElementById('speed-btn');

    playPauseBtn.addEventListener('click', () => this.togglePlayPause());
    speedBtn.addEventListener('click', () => this.toggleSpeed());
    this.setupVolume();

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.code === 'Space') {
        e.preventDefault();
        this.togglePlayPause();
      } else if (e.code === 'KeyM' && !e.ctrlKey && !e.metaKey && !e.altKey && this.mode !== 'minimal') {
        this.toggleMute();
      }
    });
  }

  /**
   * Volume chip under the speed chip. With a mouse, hovering it opens a slider
   * to its left and clicking it mutes; on touch screens the first tap opens the
   * slider and a tap while it is open mutes. iOS ignores a page's volume (only
   * the hardware buttons set it), so there the chip only mutes. The spoken ad
   * spots follow this volume (audio-ad.js mirrors it). The level is remembered
   * for the next track, mute is not, so nobody comes back to a silent player.
   */
  setupVolume() {
    const wrap = document.getElementById('volume-wrap');
    const btn = document.getElementById('volume-btn');
    const slider = document.getElementById('volume-slider');
    if (!wrap || this.mode === 'minimal') return;
    const media = this.wavesurfer.getMediaElement();

    const probe = new Audio();
    probe.volume = 0.5;
    this.volumeAdjustable = probe.volume === 0.5;
    if (!this.volumeAdjustable) wrap.classList.add('mute-only');
    const canHover = window.matchMedia('(hover: hover)').matches;

    try {
      const saved = parseFloat(localStorage.getItem('snapieaudio:volume'));
      if (this.volumeAdjustable && saved > 0 && saved <= 1) media.volume = saved;
    } catch { /* storage blocked in this embed */ }
    this.lastVolume = media.volume || 1;

    slider.addEventListener('input', () => {
      const v = Number(slider.value) / 100;
      media.volume = v;
      media.muted = v === 0;
    });
    btn.addEventListener('click', () => {
      if (this.volumeAdjustable && !canHover && !wrap.classList.contains('open')) {
        wrap.classList.add('open');
        return;
      }
      this.toggleMute();
    });
    document.addEventListener('pointerdown', (e) => {
      if (!wrap.contains(e.target)) wrap.classList.remove('open');
    });
    // Scroll over the chip or the slider to nudge the volume
    wrap.addEventListener('wheel', (e) => {
      if (!this.volumeAdjustable) return;
      e.preventDefault();
      const v = Math.min(1, Math.max(0, (media.muted ? 0 : media.volume) + (e.deltaY < 0 ? 0.05 : -0.05)));
      media.volume = v;
      media.muted = v === 0;
    }, { passive: false });

    media.addEventListener('volumechange', () => this.renderVolume());
    this.renderVolume();
  }

  toggleMute() {
    const media = this.wavesurfer.getMediaElement();
    if (media.muted || media.volume === 0) {
      if (media.volume === 0) media.volume = this.lastVolume || 1;
      media.muted = false;
    } else {
      media.muted = true;
    }
  }

  renderVolume() {
    const btn = document.getElementById('volume-btn');
    const slider = document.getElementById('volume-slider');
    if (!btn) return;
    const media = this.wavesurfer.getMediaElement();
    const level = media.muted ? 0 : media.volume;
    if (media.volume > 0) {
      this.lastVolume = media.volume;
      try { localStorage.setItem('snapieaudio:volume', String(media.volume)); } catch { /* storage blocked */ }
    }

    const pct = Math.round(level * 100);
    slider.value = String(pct);
    slider.style.setProperty('--fill', `${pct}%`);
    slider.setAttribute('aria-valuetext', `${pct}%`);
    btn.querySelector('.vol-high').style.display = level >= 0.5 ? '' : 'none';
    btn.querySelector('.vol-low').style.display = level > 0 && level < 0.5 ? '' : 'none';
    btn.querySelector('.vol-off').style.display = level === 0 ? '' : 'none';
    const label = level === 0 ? 'Unmute' : 'Mute';
    btn.setAttribute('aria-label', label);
    btn.title = `${label} (M)`;
  }

  /**
   * Load audio from URL parameters
   */
  async loadAudioFromURL() {
    const params = new URLSearchParams(window.location.search);
    const permlink = params.get('a');
    const cid = params.get('cid');
    const list = params.get('list');
    const podcast = params.get('podcast');

    this.showLoading(true);

    try {
      if (list || podcast) {
        await this.loadPlaylist(list || podcast, list ? 'playlist' : 'podcast');
      } else if (permlink) {
        await this.loadByPermlink(permlink);
      } else if (cid) {
        await this.loadByCID(cid);
      } else {
        throw new Error('No audio identifier provided');
      }
    } catch (error) {
      this.handleError(error);
    }
  }

  /**
   * Load audio by permlink (from database)
   */
  async loadByPermlink(permlink, isCurrent = () => true) {
    const response = await fetch(`/api/audio?a=${encodeURIComponent(permlink)}`);

    if (!response.ok) {
      throw new Error('Audio not found');
    }

    const audioData = await response.json();
    // A playlist listener can pick another track while this one is loading.
    if (!isCurrent()) return;
    this.audioData = audioData;
    if (this.flatWave) {
      this.flatWave = false;
      this.wavesurfer.setOptions({ normalize: true });
    }
    this.durationReconciled = false;
    this.peaksProvided = false;

    // One track per embed: measure its listening time (anonymous).
    if (!this.listenTime) {
      this.listenTime = new ListenTimeTracker(this.audioData.permlink || permlink);
      this.listenTime.attach(this.wavesurfer.getMediaElement());
    }

    const gateways = [this.audioData.audioUrl, this.audioData.audioUrlFallback];

    // Self-healing: if valid waveform peaks are stored, use them for instant render + streaming.
    // Guard the format: WaveSurfer v7 requires number[][] (array of channel arrays), not a flat array.
    const storedPeaks = this.audioData.waveform;
    const validPeaks = Array.isArray(storedPeaks) &&
                       storedPeaks.length > 0 &&
                       Array.isArray(storedPeaks[0]);

    if (validPeaks && this.audioData.duration) {
      this.peaksProvided = true;
      await this.loadAudioFileWithGateways(gateways, storedPeaks, this.audioData.duration, isCurrent);
    } else {
      await this.loadAudioFileWithGateways(gateways, null, null, isCurrent);
    }
    if (!isCurrent()) return;
    // A new source resets the element's rate; keep the listener's speed.
    if (this.currentSpeed !== 1) this.wavesurfer.setPlaybackRate(this.currentSpeed);

    document.getElementById('audio-title').textContent =
      this.audioData.title || 'Voice Message';

    this.setupTipButton();
    this.setupAudioAd();
  }

  /**
   * Playlist embed: /play?list=<3speak.tv playlist id>. Every audio item of a
   * public playlist, in its order, under the player; a finished track moves on
   * to the next. Each track is loaded like a single embed (loadByPermlink), so
   * the play counter, listening time, tip button and sponsored spot all follow
   * the track that is playing. Video items are not listed: this is the audio
   * player.
   */
  async loadPlaylist(id, kind = 'playlist') {
    const what = kind === 'podcast' ? 'podcast' : 'playlist';
    const response = await fetch(`/api/audio/${what}/${encodeURIComponent(id)}`);
    if (!response.ok) {
      throw new Error(response.status === 404 ? `${what === 'podcast' ? 'Podcast' : 'Playlist'} not found` : `Could not load the ${what}`);
    }
    const data = await response.json();
    const tracks = Array.isArray(data.tracks) ? data.tracks : [];
    if (tracks.length === 0) throw new Error(what === 'podcast' ? 'This podcast has no episodes yet' : 'This playlist has no audio yet');

    const params = new URLSearchParams(window.location.search);
    // By date, oldest first, unless the page asks for ?sort=desc. The listener can flip it.
    this.sortDesc = params.get('sort') === 'desc';
    this.playlist = { ...data, inOrder: tracks, tracks: this.sortedTracks(tracks) };
    // One anonymous frequency-cap id for the whole playlist (audio-ad.js).
    this.capId = window.AudioAdSpot ? window.AudioAdSpot.newCapId() : null;
    this.renderPlaylist();

    const start = Math.min(tracks.length - 1, Math.max(0, (parseInt(params.get('track'), 10) || 1) - 1));
    await this.loadTrack(start, false);
  }

  /** The tracks by publish date; undated ones last, ties keep the playlist's order. */
  sortedTracks(tracks) {
    const at = (t) => { const ms = Date.parse(t.created); return Number.isNaN(ms) ? null : ms; };
    const dir = this.sortDesc ? -1 : 1;
    return tracks
      .map((t, i) => ({ t, i, ms: at(t) }))
      .sort((a, b) => {
        if (a.ms === null || b.ms === null) return (a.ms === null) - (b.ms === null) || a.i - b.i;
        return (a.ms - b.ms) * dir || a.i - b.i;
      })
      .map((x) => x.t);
  }

  /** Oldest or newest first. The track that is playing keeps playing. */
  setSort(desc) {
    if (desc === this.sortDesc) return;
    const current = this.playlist.tracks[this.trackIndex];
    this.sortDesc = desc;
    this.playlist.tracks = this.sortedTracks(this.playlist.inOrder);
    this.trackIndex = Math.max(0, this.playlist.tracks.indexOf(current));
    this.page = Math.floor(this.trackIndex / this.pageSize);
    this.renderTrackList();
    this.renderActiveTrack();
  }

  /**
   * A small copy of a cover or thumbnail. 3Speak's own images go through
   * 3speak.tv's resizer, anything else through Hive's image proxy. If the small
   * copy fails the original is tried, and after that the image is hidden.
   */
  setSmallImage(img, url, px) {
    const u = String(url || '').trim();
    if (!u) { img.style.visibility = 'hidden'; return; }
    const own = u.match(/^https?:\/\/images\.3speak\.tv\/(.+)$/i);
    // The checker's podcast art comes resized already.
    const small = /\/podcasts\/art\//.test(u) ? u : own
      ? `https://3speak.tv/img/a/${own[1].split('?')[0]}?px=${px}`
      : /^https?:\/\//i.test(u) && !u.startsWith('https://images.hive.blog/')
        ? `https://images.hive.blog/${px}x${px}/${u}` : u;
    img.style.visibility = '';
    img.onerror = () => {
      if (img.src !== u) img.src = u;
      else { img.onerror = null; img.style.visibility = 'hidden'; }
    };
    img.src = small;
  }

  renderPlaylist() {
    const { id, name, owner, author, cover, tracks, kind } = this.playlist;
    document.body.classList.add('playlist-mode');

    const head = document.getElementById('playlist-head');
    const link = document.getElementById('playlist-name');
    const host = new URLSearchParams(window.location.search).get('tip') === 'preview'
      ? 'https://preview.3speak.tv' : 'https://3speak.tv';
    link.textContent = name;
    // A podcast's page comes with it; a playlist's is built here (?tip=preview → preview).
    link.href = this.playlist.link
      ? this.playlist.link.replace(/^https:\/\/3speak\.tv/, host)
      : `${host}/playlist/${encodeURIComponent(id)}`;
    const noun = kind === 'podcast' ? ['episode', 'episodes'] : ['track', 'tracks'];
    const count = `${tracks.length} ${tracks.length === 1 ? noun[0] : noun[1]}`;
    const by = owner ? `@${owner}` : author;
    document.getElementById('playlist-meta').textContent = by ? `${by} · ${count}` : count;
    document.querySelector('.playlist-bar-label').textContent = kind === 'podcast' ? 'Episodes' : 'Tracks';

    const coverSrc = cover || tracks.find((t) => t.thumbnail_url)?.thumbnail_url ||
      (owner ? `https://images.hive.blog/u/${owner}/avatar/small` : '');
    this.setSmallImage(document.getElementById('playlist-cover'), coverSrc, 96);
    head.style.display = '';

    const sort = document.getElementById('sort-select');
    sort.value = this.sortDesc ? 'desc' : 'asc';
    sort.addEventListener('change', () => this.setSort(sort.value === 'desc'));
    document.getElementById('playlist-bar').style.display = '';

    document.getElementById('prev-btn').addEventListener('click', () => {
      if (this.trackIndex > 0) this.loadTrack(this.trackIndex - 1, true);
    });
    document.getElementById('next-btn').addEventListener('click', () => {
      if (this.trackIndex < tracks.length - 1) this.loadTrack(this.trackIndex + 1, true);
    });

    this.setupPaging();
    document.getElementById('playlist-tracks').style.display = '';
    this.renderTrackList();
    this.refitPages();
  }

  /**
   * Paging: as many rows per page as the list has room for, between 5 and 10.
   * The host page decides the room by the iframe's height; a direct visit
   * (no iframe) gets the list's max-height. Measured again whenever the frame
   * is resized.
   */
  fitPageSize() {
    const list = document.getElementById('playlist-tracks');
    const row = list.querySelector('li');
    const rowHeight = (row && row.offsetHeight) || 40;
    const room = document.body.classList.contains('iframe-mode')
      ? list.clientHeight
      : parseFloat(getComputedStyle(list).maxHeight) || 320;
    return Math.min(10, Math.max(5, Math.floor(room / rowHeight)));
  }

  pageCount() {
    return Math.max(1, Math.ceil(this.playlist.tracks.length / this.pageSize));
  }

  /** Show page `page` (0-based), clamped. */
  showPage(page) {
    this.page = Math.min(this.pageCount() - 1, Math.max(0, page));
    this.renderTrackList();
    this.renderActiveTrack(false);
  }

  /** Re-measure; a different page size keeps the playing track in view. */
  refitPages() {
    const size = this.fitPageSize();
    if (size === this.pageSize) return;
    this.pageSize = size;
    this.showPage(Math.floor(Math.max(0, this.trackIndex) / size));
  }

  setupPaging() {
    this.pageSize = 5;
    this.page = 0;
    document.getElementById('page-prev').addEventListener('click', () => this.showPage(this.page - 1));
    document.getElementById('page-next').addEventListener('click', () => this.showPage(this.page + 1));
    const list = document.getElementById('playlist-tracks');
    if (window.ResizeObserver) new ResizeObserver(() => this.refitPages()).observe(list);
    else window.addEventListener('resize', () => this.refitPages());
  }

  renderPager() {
    const pages = this.pageCount();
    document.getElementById('playlist-pager').style.display = pages > 1 ? '' : 'none';
    document.getElementById('page-info').textContent = `${this.page + 1} / ${pages}`;
    document.getElementById('page-prev').disabled = this.page <= 0;
    document.getElementById('page-next').disabled = this.page >= pages - 1;
  }

  renderTrackList() {
    const list = document.getElementById('playlist-tracks');
    list.textContent = '';
    list.scrollTop = 0;
    const from = this.page * this.pageSize;
    this.renderPager();
    this.playlist.tracks.slice(from, from + this.pageSize).forEach((track, k) => {
      const i = from + k;
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'playlist-track';
      btn.dataset.index = String(i);
      const num = document.createElement('span');
      num.className = 'track-num';
      num.textContent = String(i + 1);
      const thumb = document.createElement('img');
      thumb.className = 'track-thumb';
      thumb.alt = '';
      thumb.loading = 'lazy';
      thumb.width = 28;
      thumb.height = 28;
      this.setSmallImage(thumb, track.thumbnail_url || this.playlist.cover, 64);
      const title = document.createElement('span');
      title.className = 'track-title';
      title.textContent = track.title;
      btn.title = track.title;
      const dur = document.createElement('span');
      dur.className = 'track-duration';
      dur.textContent = track.duration ? this.formatTime(track.duration) : '';
      btn.append(num, thumb, title, dur);
      btn.addEventListener('click', () => {
        if (i === this.trackIndex) this.togglePlayPause();
        else this.loadTrack(i, true);
      });
      li.appendChild(btn);
      list.appendChild(li);
    });
  }

  /** Load track `index` of the playlist; `autoplay` once it is ready. */
  async loadTrack(index, autoplay) {
    const track = this.playlist?.tracks[index];
    if (!track) return;
    const seq = ++this.loadSeq;
    const media = this.wavesurfer.getMediaElement();

    // Close out the track that was playing: its last measured beats, then
    // retire its listening-time and ad helpers so they do not act on the next one.
    this.beatOnce();
    if (this.listenTime) this.listenTime.dispose(media);
    this.listenTime = null;
    if (this.adSpot) this.adSpot.dispose();
    this.adSpot = null;
    this.renderAd('idle', {});
    const after = document.getElementById('ad-more-btn');
    if (after) after.style.display = 'none';
    document.getElementById('tip-btn').style.display = 'none';
    document.getElementById('error-message').style.display = 'none';

    this.trackIndex = index;
    this.renderActiveTrack();
    this.showLoading(true);
    try {
      if (track.kind === 'external') await this.loadExternal(track, () => seq === this.loadSeq);
      else await this.loadByPermlink(track.permlink, () => seq === this.loadSeq);
      if (seq !== this.loadSeq) return;           // the listener already picked another
      // The Hive post's title, as 3speak.tv shows it, not the upload's own name.
      document.getElementById('audio-title').textContent = track.title;
      // A browser that refuses to start playback leaves the track loaded and paused.
      if (autoplay) this.wavesurfer.play()?.catch?.(() => this.updatePlayPauseButton(false));
    } catch (error) {
      if (seq === this.loadSeq) this.handleError(error);
    }
  }

  /**
   * An outside podcast episode: its own file, straight from the podcast's host.
   * Most hosts do not let another site read the file, only play it, so there is
   * no waveform to draw: a flat strip stands in for it and fills as it plays
   * (stored peaks mean WaveSurfer never fetches the file). Listening time and
   * sponsored spots go by the checker's episode id; the tip button opens the
   * episode on 3speak.tv, where the show's Lightning tips are.
   */
  async loadExternal(track, isCurrent = () => true) {
    this.audioData = { title: track.title, external: true, episodeId: track.id };
    this.durationReconciled = true;
    this.peaksProvided = true;
    if (!this.flatWave) {
      this.flatWave = true;
      this.wavesurfer.setOptions({ normalize: false });
    }
    if (window.ListenTimeTracker) {
      this.listenTime = new ListenTimeTracker(track.id, 'podcast');
      this.listenTime.attach(this.wavesurfer.getMediaElement());
    }
    const peaks = [new Array(400).fill(0.16)];
    await this.loadAudioFileWithGateways([track.audio_url], peaks, track.duration || undefined, isCurrent);
    if (!isCurrent()) return;
    if (this.currentSpeed !== 1) this.wavesurfer.setPlaybackRate(this.currentSpeed);

    const tip = document.getElementById('tip-btn');
    if (tip && this.mode !== 'minimal' && track.page) {
      const host = new URLSearchParams(window.location.search).get('tip') === 'preview'
        ? 'https://preview.3speak.tv' : 'https://3speak.tv';
      tip.href = track.page.replace(/^https:\/\/3speak\.tv/, host);
      tip.title = 'Tip the podcast on 3Speak';
      tip.setAttribute('aria-label', 'Tip the podcast on 3Speak');
      tip.style.display = '';
      this.bindTipClick(tip);
    }

    if (window.AudioAdSpot) {
      this.adSpot = new window.AudioAdSpot({
        episodeId: track.id,
        viewer: this.getListenUser(),
        capId: this.capId || null,
        onChange: (phase, spot) => this.renderAd(phase, spot),
      });
      this.adSpot.attach(this.wavesurfer.getMediaElement());
      this.adSpot.request();
    }
  }

  /** Mark the playing track; `follow` turns to its page first (a new track, not the listener browsing). */
  renderActiveTrack(follow = true) {
    const list = document.getElementById('playlist-tracks');
    if (follow && this.pageSize) {
      const page = Math.floor(this.trackIndex / this.pageSize);
      if (page !== this.page) { this.page = page; this.renderTrackList(); }
    }
    const rows = list.querySelectorAll('.playlist-track');
    let row = null;
    rows.forEach((r) => {
      const current = Number(r.dataset.index) === this.trackIndex;
      r.classList.toggle('is-current', current);
      if (current) { r.setAttribute('aria-current', 'true'); row = r; } else r.removeAttribute('aria-current');
    });
    // Scroll the list itself: scrollIntoView would also scroll the host page.
    if (row) {
      const top = row.offsetTop - list.offsetTop;
      if (top < list.scrollTop) list.scrollTop = top;
      else if (top + row.offsetHeight > list.scrollTop + list.clientHeight) {
        list.scrollTop = top + row.offsetHeight - list.clientHeight;
      }
    }
    document.getElementById('prev-btn').disabled = this.trackIndex <= 0;
    document.getElementById('next-btn').disabled = this.trackIndex >= this.playlist.tracks.length - 1;
  }

  /**
   * Sponsored audio spots (src/audio-ad.js): the checker decides whether this track
   * carries one. While it plays, a strip takes the waveform's place (the disclosure,
   * the product, the message and its link); after it, a "Find out more" chip stays
   * for the rest of the track (not in minimal mode, like speed and tip).
   */
  setupAudioAd() {
    const d = this.audioData || {};
    if (!window.AudioAdSpot || !d.owner || !d.permlink) return;
    this.adSpot = new window.AudioAdSpot({
      owner: d.owner,
      permlink: d.permlink,
      viewer: this.getListenUser(),
      capId: this.capId || null,
      onChange: (phase, spot) => this.renderAd(phase, spot),
    });
    this.adSpot.attach(this.wavesurfer.getMediaElement());
    this.adSpot.request();
  }

  renderAd(phase, spot) {
    const strip = document.getElementById('ad-strip');
    const wave = document.getElementById('waveform-container');
    const after = document.getElementById('ad-more-btn');
    if (!strip || !wave) return;
    const running = phase === 'playing' || phase === 'paused';
    strip.style.display = running ? '' : 'none';
    wave.style.display = running ? 'none' : '';
    if (running) {
      strip.querySelector('.ad-label').textContent = spot.label || 'Ad';
      strip.querySelector('.ad-product').textContent = spot.productName || '';
      strip.querySelector('.ad-message').textContent = spot.message || '';
      const more = strip.querySelector('.ad-more');
      if (spot.clickUrl) { more.href = spot.clickUrl; more.style.display = ''; } else more.style.display = 'none';
      this.updatePlayPauseButton(phase === 'playing');
    }
    if (after && phase === 'heard' && spot.clickUrl && this.mode !== 'minimal') {
      after.href = spot.clickUrl;
      after.title = spot.productName ? `Find out more about ${spot.productName}` : 'Find out more';
      after.querySelector('.ad-label').textContent = spot.label || 'Ad';
      after.style.display = '';
    }
  }

  /**
   * Tip button: opens the creator's tip page on 3speak.tv (HIVE / HBD or
   * Lightning) in a popup, because an embed can't sign or pay by itself. The
   * page closes itself once the tip is sent. Shown only for audio with a Hive
   * post, which is what a tip is credited to, and not in minimal mode. Where
   * popups don't exist or are blocked (phones, some host sites) the link opens
   * as an ordinary tab.
   *
   * `?tip=preview` points it at preview.3speak.tv for testing; no other host
   * can be chosen, so an embed can't send viewers to a look-alike tip page.
   */
  setupTipButton() {
    const btn = document.getElementById('tip-btn');
    const d = this.audioData || {};
    if (!btn || this.mode === 'minimal' || !d.owner || !d.post_permlink) return;

    const params = new URLSearchParams(window.location.search);
    const host = params.get('tip') === 'preview' ? 'https://preview.3speak.tv' : 'https://3speak.tv';
    const url = `${host}/tip/@${encodeURIComponent(d.owner)}/${encodeURIComponent(d.post_permlink)}?kind=audio`;
    btn.href = url;
    btn.title = 'Tip the creator';
    btn.setAttribute('aria-label', 'Tip the creator');
    btn.style.display = '';
    this.bindTipClick(btn);
  }

  /** Opens the tip link in a popup. A playlist changes the link per track; the handler is bound once. */
  bindTipClick(btn) {
    if (this.tipBound) return;
    this.tipBound = true;
    btn.addEventListener('click', (e) => {
      const url = btn.href;
      const w = 440;
      const h = 720;
      const left = Math.max(0, Math.round((window.screen.width - w) / 2));
      const top = Math.max(0, Math.round((window.screen.height - h) / 2));
      const win = window.open(url, '3speak-tip', `popup,width=${w},height=${h},left=${left},top=${top}`);
      if (win) e.preventDefault();
    });
  }

  /**
   * Load audio by CID (direct IPFS)
   */
  async loadByCID(cid) {
    if (!this.isValidCID(cid)) {
      throw new Error('Invalid CID format');
    }

    // Try multiple gateways in order
    const gateways = [
      `https://ipfs.io/ipfs/${cid}`,
      `https://dweb.link/ipfs/${cid}`,
      `https://cloudflare-ipfs.com/ipfs/${cid}`
    ];
    
    await this.loadAudioFileWithGateways(gateways);
    
    document.getElementById('audio-title').textContent = 'Audio Playback';
  }

  /**
   * Load audio file with multiple gateway fallbacks.
   * When peaks + duration are provided, WaveSurfer renders the waveform instantly
   * from stored data and streams the audio rather than downloading it fully first.
   */
  async loadAudioFileWithGateways(gateways, peaks = null, duration = null, isCurrent = () => true) {
    let lastError = null;

    for (let i = 0; i < gateways.length; i++) {
      // Another playlist track was picked: no fallback for this one.
      if (!isCurrent()) return;
      try {
        console.log(`Trying gateway ${i + 1}/${gateways.length}: ${gateways[i]}`);
        if (peaks && duration) {
          await this.wavesurfer.load(gateways[i], peaks, duration);
        } else {
          await this.wavesurfer.load(gateways[i]);
        }
        console.log(`✓ Successfully loaded from gateway ${i + 1}`);
        return;
      } catch (error) {
        lastError = error;
        console.warn(`✗ Gateway ${i + 1} failed:`, error.message);
      }
    }

    console.error('All IPFS gateways failed', lastError);
    throw new Error('Unable to load audio from IPFS. The file may not be available on the network yet.');
  }

  /**
   * Called when audio is ready to play
   */
  onAudioReady() {
    this.showLoading(false);
    this.updateTimeDisplay();

    if (this.audioData && this.audioData.permlink) {
      this.startListenSession(this.audioData.permlink);

      if (!this.durationReconciled) {
        this.reconcileAudioMetadata(this.audioData.permlink);
      }

      // Self-healing: on first load (no stored peaks), save them for next time
      if (!this.peaksProvided) {
        this.saveWaveformPeaks(this.audioData.permlink);
      }
    }
  }

  /**
   * Extract waveform peaks from the decoded audio and store them in the DB.
   * Fires silently after first load — next load will be instant.
   */
  async saveWaveformPeaks(permlink) {
    try {
      const peaks = this.wavesurfer.exportPeaks({ channels: 1, maxLength: 800, precision: 5 });
      const duration = this.wavesurfer.getDuration();

      if (!peaks || !peaks.length || !duration) return;

      const response = await fetch(`/api/audio/${permlink}/waveform`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ waveform: peaks, duration })
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.warn(`Could not save waveform peaks: ${response.status} ${errorText}`);
        return;
      }

      console.log('✓ Waveform peaks saved — next load will be instant');
    } catch (error) {
      console.warn('Could not save waveform peaks:', error);
    }
  }

  /**
   * Correct stale duration metadata when the decoded player duration differs
   * from what was stored with the audio record.
   */
  async reconcileAudioMetadata(permlink) {
    try {
      if (this.durationReconciled) return;

      const actualDuration = this.getActualDuration();
      if (!actualDuration) return;

      const storedDuration = Number(this.audioData.duration);
      const storedDurationIsValid = Number.isFinite(storedDuration) && storedDuration > 0;

      if (
        storedDurationIsValid &&
        Math.abs(actualDuration - storedDuration) < this.durationHealTolerance
      ) {
        this.durationReconciled = true;
        return;
      }

      this.durationReconciled = true;
      const response = await fetch(`/api/audio/${permlink}/waveform`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ duration: actualDuration })
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.warn(`Could not reconcile audio duration: ${response.status} ${errorText}`);
        return;
      }

      const previousDuration = storedDurationIsValid ? `${storedDuration}s` : 'missing/invalid';
      this.audioData.duration = actualDuration;
      console.log(`✓ Audio duration corrected from ${previousDuration} to ${actualDuration}s`);
    } catch (error) {
      console.warn('Could not reconcile audio metadata:', error);
    }
  }

  /**
   * Prefer the media element's metadata duration when available because
   * WaveSurfer can be initialized with stale precomputed peak duration.
   */
  getActualDuration() {
    const mediaDuration = this.wavesurfer.getMediaElement().duration;
    if (Number.isFinite(mediaDuration) && mediaDuration > 0) {
      return mediaDuration;
    }

    return this.wavesurfer.getDuration();
  }

  /**
   * Toggle play/pause
   */
  togglePlayPause() {
    if (this.adSpot && this.adSpot.toggle()) return;
    this.wavesurfer.playPause();
  }

  /**
   * Update play/pause button icon
   */
  updatePlayPauseButton(isPlaying) {
    const playIcon = document.getElementById('play-icon');
    const pauseIcon = document.getElementById('pause-icon');
    
    if (isPlaying) {
      playIcon.style.display = 'none';
      pauseIcon.style.display = 'block';
    } else {
      playIcon.style.display = 'block';
      pauseIcon.style.display = 'none';
    }
  }

  /**
   * Toggle playback speed
   */
  toggleSpeed() {
    this.speedIndex = (this.speedIndex + 1) % this.speeds.length;
    this.currentSpeed = this.speeds[this.speedIndex];
    
    this.wavesurfer.setPlaybackRate(this.currentSpeed);
    document.getElementById('speed-btn').textContent = `${this.currentSpeed}x`;
  }

  /**
   * Update time display
   */
  updateTimeDisplay() {
    const currentTime = this.wavesurfer.getCurrentTime();
    const duration = this.wavesurfer.getDuration();
    
    document.getElementById('current-time').textContent = this.formatTime(currentTime);
    document.getElementById('total-time').textContent = this.formatTime(duration);
  }

  /**
   * Format time in MM:SS
   */
  formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  /**
   * Validate IPFS CID format (supports both CIDv0 and CIDv1)
   */
  isValidCID(cid) {
    // CIDv0: Qm + 44 base58 characters
    const isCIDv0 = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(cid);
    // CIDv1: bafy + base32 characters
    const isCIDv1 = /^bafy[a-z0-9]{54,}$/.test(cid);
    return isCIDv0 || isCIDv1;
  }

  /**
   * Optional logged-in Hive user. The embed is anonymous by default, but an
   * embedding page may pass ?user=alice so the listen can earn a
   * pay-per-listen credit on opted-in (ppl) tracks. Anonymous playback still
   * counts toward the public `plays` stat — it just never earns a credit.
   */
  getListenUser() {
    const params = new URLSearchParams(window.location.search);
    const u = (params.get('user') || params.get('username') || '').trim().toLowerCase();
    return /^[a-z][a-z0-9.-]{2,15}$/.test(u) ? u : null;
  }

  /**
   * Open a measured listen session for this track. Only counts a play once
   * the listener has genuinely streamed ≥66% of it (server-measured via the
   * heartbeats sent from the audioprocess handler) — never on mere load.
   */
  async startListenSession(permlink) {
    // Reset state for this track and guard against double-open.
    if (this.listen.starting || (this.listen.sid && this.listen.permlink === permlink)) return;
    this.listen = { permlink, sid: null, token: null, beatMs: 10000, lastBeatAt: 0, credited: false, encrypted: false, starting: true };

    try {
      const body = { permlink };
      const user = this.getListenUser();
      if (user) body.username = user;

      const response = await fetch('/api/audio/play-start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        console.warn(`Could not open listen session: ${response.status} ${response.statusText}`);
        return;
      }

      const data = await response.json();
      // Ignore a stale response if the track changed while we were waiting.
      if (!data?.sid || this.listen.permlink !== permlink) return;

      this.listen.sid = data.sid;
      this.listen.token = data.token;
      this.listen.encrypted = !!data.encrypted;
      this.listen.beatMs = (data.beatSeconds || 10) * 1000;
      this.listen.lastBeatAt = Date.now(); // first beat one interval from now
    } catch (error) {
      console.warn('Could not open listen session:', error);
    } finally {
      this.listen.starting = false;
    }
  }

  /**
   * Send one heartbeat. Called (throttled) from audioprocess while the audio
   * is really advancing. Best-effort — never disrupts playback.
   */
  async beatOnce() {
    const L = this.listen;
    if (!L.sid || L.credited) return;
    L.lastBeatAt = Date.now(); // throttle before the await so we don't double-fire

    try {
      let body = { sid: L.sid, token: L.token };
      if (L.encrypted) {
        const enc = await encryptBeat(body);
        if (!enc) return; // server requires encryption but we couldn't — skip
        body = { enc };
      }

      const response = await fetch('/api/audio/play-beat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!response.ok) return;

      const data = await response.json();
      if (data?.done || data?.credited) {
        L.credited = true; // threshold reached — stop beating
        console.log('✓ Listen counted');
      }
    } catch (error) {
      // best-effort — never disrupt playback
    }
  }

  /**
   * Show/hide loading spinner
   */
  showLoading(show) {
    const spinner = document.getElementById('loading-spinner');
    const container = document.getElementById('player-controls');
    
    spinner.style.display = show ? 'block' : 'none';
    container.style.opacity = show ? '0.5' : '1';
  }

  /**
   * Handle errors
   */
  handleError(error) {
    console.error('Audio player error:', error);
    this.showLoading(false);
    
    const errorMsg = document.getElementById('error-message');
    errorMsg.style.display = 'block';
    errorMsg.textContent = error.message || 'Failed to load audio. Please try again.';
  }
}

// Initialize player when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  new SnapieAudioPlayer();
});
