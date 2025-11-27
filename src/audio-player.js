/**
 * SnapieAudioPlayer - Main player initialization and control
 * Handles audio playback, waveform visualization, and IPFS content loading
 */

class SnapieAudioPlayer {
  constructor() {
    this.wavesurfer = null;
    this.audioData = null;
    this.currentSpeed = 1;
    this.speeds = [1, 1.5, 2];
    this.speedIndex = 0;
    this.mode = 'full'; // 'minimal', 'compact', 'full'
    
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
    const iframe = params.get('iframe');
    
    if (['minimal', 'compact', 'full'].includes(mode)) {
      this.mode = mode;
    }
    
    // Enable iframe mode for clean embedding (no scrollbars)
    if (iframe === '1' || iframe === 'true') {
      document.body.classList.add('iframe-mode');
    }
    
    // Apply mode class to container
    const container = document.getElementById('audio-player-container');
    container.classList.add(`mode-${this.mode}`);
    
    // Hide elements based on mode
    if (this.mode === 'minimal') {
      document.getElementById('player-header').style.display = 'none';
      document.getElementById('speed-btn').style.display = 'none';
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
    
    this.wavesurfer = WaveSurfer.create({
      container: '#waveform-container',
      waveColor: '#ddd',
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
    this.wavesurfer.on('play', () => this.updatePlayPauseButton(true));
    this.wavesurfer.on('pause', () => this.updatePlayPauseButton(false));
    this.wavesurfer.on('audioprocess', () => this.updateTimeDisplay());
    this.wavesurfer.on('error', (error) => this.handleError(error));
  }

  /**
   * Set up UI event listeners
   */
  setupEventListeners() {
    const playPauseBtn = document.getElementById('play-pause-btn');
    const speedBtn = document.getElementById('speed-btn');

    playPauseBtn.addEventListener('click', () => this.togglePlayPause());
    speedBtn.addEventListener('click', () => this.toggleSpeed());

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.code === 'Space') {
        e.preventDefault();
        this.togglePlayPause();
      }
    });
  }

  /**
   * Load audio from URL parameters
   */
  async loadAudioFromURL() {
    const params = new URLSearchParams(window.location.search);
    const permlink = params.get('a');
    const cid = params.get('cid');

    this.showLoading(true);

    try {
      if (permlink) {
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
  async loadByPermlink(permlink) {
    const response = await fetch(`/api/audio?a=${permlink}`);
    
    if (!response.ok) {
      throw new Error('Audio not found');
    }

    this.audioData = await response.json();
    await this.loadAudioFile(this.audioData.audioUrl, this.audioData.audioUrlFallback);
    
    document.getElementById('audio-title').textContent = 
      this.audioData.title || 'Voice Message';
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
   * Load audio file with multiple gateway fallbacks
   */
  async loadAudioFileWithGateways(gateways) {
    let lastError = null;
    
    for (let i = 0; i < gateways.length; i++) {
      try {
        console.log(`Trying gateway ${i + 1}/${gateways.length}: ${gateways[i]}`);
        await this.wavesurfer.load(gateways[i]);
        console.log(`✓ Successfully loaded from gateway ${i + 1}`);
        return; // Success!
      } catch (error) {
        lastError = error;
        console.warn(`✗ Gateway ${i + 1} failed:`, error.message);
        // Continue to next gateway
      }
    }
    
    // All gateways failed
    console.error('All IPFS gateways failed', lastError);
    throw new Error('Unable to load audio from IPFS. The file may not be available on the network yet.');
  }

  /**
   * Load audio file with fallback support (for database mode)
   */
  async loadAudioFile(primaryUrl, fallbackUrl) {
    await this.loadAudioFileWithGateways([primaryUrl, fallbackUrl]);
  }

  /**
   * Called when audio is ready to play
   */
  onAudioReady() {
    this.showLoading(false);
    this.updateTimeDisplay();
    
    // Track play count if permlink exists
    if (this.audioData && this.audioData.permlink) {
      this.trackPlay(this.audioData.permlink);
    }
  }

  /**
   * Toggle play/pause
   */
  togglePlayPause() {
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
   * Track play count
   */
  async trackPlay(permlink) {
    try {
      const response = await fetch('/api/audio/play', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ permlink })
      });
      
      if (!response.ok) {
        console.warn(`Failed to track play: ${response.status} ${response.statusText}`);
        return;
      }
      
      const data = await response.json();
      if (data.success) {
        console.log(`✓ Play tracked. Total plays: ${data.plays}`);
      }
    } catch (error) {
      console.warn('Failed to track play count:', error);
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
