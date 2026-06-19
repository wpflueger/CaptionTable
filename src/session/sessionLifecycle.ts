export type SessionState = 'idle' | 'active' | 'interrupted' | 'stopped';

export type SessionGuidance =
  | 'I can’t hear anyone.'
  | 'Move the device closer.'
  | 'Internet connection lost. Captions are continuing.'
  | 'Captions stopped.';

export interface SessionLifecycleOptions {
  silenceThresholdMs?: number;
  lowVolumeThreshold?: number;
  lowVolumeGraceMs?: number;
  now?: () => number;
  onStateChange?: (state: SessionState) => void;
  onGuidance?: (message: SessionGuidance | null) => void;
  onWakeLockChange?: (locked: boolean) => void;
}

type WakeLockSentinel = {
  released: boolean;
  release: () => Promise<void>;
  addEventListener: (type: 'release', listener: () => void) => void;
  removeEventListener: (type: 'release', listener: () => void) => void;
};

type WakeLockNavigator = Navigator & {
  wakeLock?: {
    request: (type: 'screen') => Promise<WakeLockSentinel>;
  };
};

const DEFAULT_SILENCE_THRESHOLD_MS = 8000;
const DEFAULT_LOW_VOLUME_THRESHOLD = 0.04;
const DEFAULT_LOW_VOLUME_GRACE_MS = 3000;

/**
 * Coordinates browser session lifecycle concerns for live captioning.
 *
 * The class deliberately keeps caption text outside of its state so temporary
 * interruptions, connectivity changes, and Stop events cannot clear captions
 * that have already been rendered by the application.
 */
export class SessionLifecycle {
  private readonly silenceThresholdMs: number;
  private readonly lowVolumeThreshold: number;
  private readonly lowVolumeGraceMs: number;
  private readonly now: () => number;
  private readonly onStateChange?: (state: SessionState) => void;
  private readonly onGuidance?: (message: SessionGuidance | null) => void;
  private readonly onWakeLockChange?: (locked: boolean) => void;

  private state: SessionState = 'idle';
  private guidance: SessionGuidance | null = null;
  private wakeLock: WakeLockSentinel | null = null;
  private captionsActive = false;
  private lastAudibleAt = 0;
  private lowVolumeStartedAt: number | null = null;
  private listening = false;

  constructor(options: SessionLifecycleOptions = {}) {
    this.silenceThresholdMs = options.silenceThresholdMs ?? DEFAULT_SILENCE_THRESHOLD_MS;
    this.lowVolumeThreshold = options.lowVolumeThreshold ?? DEFAULT_LOW_VOLUME_THRESHOLD;
    this.lowVolumeGraceMs = options.lowVolumeGraceMs ?? DEFAULT_LOW_VOLUME_GRACE_MS;
    this.now = options.now ?? (() => Date.now());
    this.onStateChange = options.onStateChange;
    this.onGuidance = options.onGuidance;
    this.onWakeLockChange = options.onWakeLockChange;
  }

  get currentState(): SessionState {
    return this.state;
  }

  get currentGuidance(): SessionGuidance | null {
    return this.guidance;
  }

  async start(): Promise<void> {
    this.captionsActive = true;
    this.lastAudibleAt = this.now();
    this.lowVolumeStartedAt = null;
    this.setState('active');
    this.setGuidance(null);
    this.addBrowserListeners();
    await this.requestWakeLock();
  }

  async stop(): Promise<void> {
    this.captionsActive = false;
    this.lowVolumeStartedAt = null;
    this.removeBrowserListeners();
    await this.releaseWakeLock();
    this.setState('stopped');
    this.setGuidance('Captions stopped.');
  }

  /**
   * Report normalized microphone volume between 0 and 1. Call this from the
   * audio-level meter while captions are active.
   */
  reportInputVolume(volume: number): void {
    if (!this.captionsActive || this.state === 'stopped') {
      return;
    }

    const timestamp = this.now();
    const normalizedVolume = Math.max(0, Math.min(1, volume));

    if (normalizedVolume > this.lowVolumeThreshold) {
      this.lastAudibleAt = timestamp;
      this.lowVolumeStartedAt = null;
      if (this.guidance === 'I can’t hear anyone.' || this.guidance === 'Move the device closer.') {
        this.setGuidance(null);
      }
      return;
    }

    this.lowVolumeStartedAt ??= timestamp;
    const silentForMs = timestamp - this.lastAudibleAt;
    const lowVolumeForMs = timestamp - this.lowVolumeStartedAt;

    if (silentForMs >= this.silenceThresholdMs) {
      this.setGuidance('I can’t hear anyone.');
    } else if (lowVolumeForMs >= this.lowVolumeGraceMs) {
      this.setGuidance('Move the device closer.');
    }
  }

  async handleVisibilityChange(): Promise<void> {
    if (!this.captionsActive || this.state === 'stopped') {
      return;
    }

    if (document.visibilityState === 'hidden') {
      await this.releaseWakeLock();
      this.setState('interrupted');
      return;
    }

    this.setState('active');
    await this.requestWakeLock();
  }

  handleOnlineStatusChange(): void {
    if (!this.captionsActive || this.state === 'stopped') {
      return;
    }

    if (!navigator.onLine) {
      this.setGuidance('Internet connection lost. Captions are continuing.');
      return;
    }

    if (this.guidance === 'Internet connection lost. Captions are continuing.') {
      this.setGuidance(null);
    }
  }

  private async requestWakeLock(): Promise<void> {
    if (!this.captionsActive || document.visibilityState !== 'visible') {
      return;
    }

    const wakeLockApi = (navigator as WakeLockNavigator).wakeLock;
    if (!wakeLockApi || this.wakeLock) {
      return;
    }

    try {
      this.wakeLock = await wakeLockApi.request('screen');
      this.wakeLock.addEventListener('release', this.handleWakeLockRelease);
      this.onWakeLockChange?.(true);
    } catch {
      this.onWakeLockChange?.(false);
    }
  }

  private async releaseWakeLock(): Promise<void> {
    const lock = this.wakeLock;
    if (!lock) {
      return;
    }

    lock.removeEventListener('release', this.handleWakeLockRelease);
    this.wakeLock = null;
    if (!lock.released) {
      await lock.release();
    }
    this.onWakeLockChange?.(false);
  }

  private readonly handleWakeLockRelease = (): void => {
    this.wakeLock = null;
    this.onWakeLockChange?.(false);
    if (this.captionsActive && document.visibilityState === 'visible') {
      void this.requestWakeLock();
    }
  };

  private addBrowserListeners(): void {
    if (this.listening) {
      return;
    }

    document.addEventListener('visibilitychange', this.handleVisibilityChangeListener);
    window.addEventListener('online', this.handleOnlineStatusChangeListener);
    window.addEventListener('offline', this.handleOnlineStatusChangeListener);
    this.listening = true;
  }

  private removeBrowserListeners(): void {
    if (!this.listening) {
      return;
    }

    document.removeEventListener('visibilitychange', this.handleVisibilityChangeListener);
    window.removeEventListener('online', this.handleOnlineStatusChangeListener);
    window.removeEventListener('offline', this.handleOnlineStatusChangeListener);
    this.listening = false;
  }

  private readonly handleVisibilityChangeListener = (): void => {
    void this.handleVisibilityChange();
  };

  private readonly handleOnlineStatusChangeListener = (): void => {
    this.handleOnlineStatusChange();
  };

  private setState(state: SessionState): void {
    if (this.state === state) {
      return;
    }

    this.state = state;
    this.onStateChange?.(state);
  }

  private setGuidance(message: SessionGuidance | null): void {
    if (this.guidance === message) {
      return;
    }

    this.guidance = message;
    this.onGuidance?.(message);
  }
}
