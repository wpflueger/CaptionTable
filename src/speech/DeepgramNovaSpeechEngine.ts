import { AudioPipeline, BrowserAudioPipeline } from '../audio/AudioPipeline';
import {
  SPEECH_ERROR_MESSAGES,
  SpeechEngine,
  SpeechEngineCallbacks,
  SpeechErrorState,
} from './SpeechEngine';

export interface DeepgramNovaSpeechEngineOptions {
  apiKey: string;
  language?: string;
  model?: 'nova-3' | 'nova-2' | string;
  mediaStream?: MediaStream;
  ownsMediaStream?: boolean;
  audioFixtureUrl?: string;
  audioStatsIntervalMs?: number;
  audioSource?: AudioPipeline;
  silenceGate?: SilenceGateOptions;
}

export interface SilenceGateOptions {
  enabled?: boolean;
  speechThreshold?: number;
  silenceTimeoutMs?: number;
  minConnectionMs?: number;
  preRollMs?: number;
}

export interface MediaStreamOptions {
  ownsStream?: boolean;
}

export interface AudioSourceOptions {
  ownsSource?: boolean;
}

type DeepgramWord = {
  word?: string;
  punctuated_word?: string;
  speaker?: number;
};

type DeepgramMessage = {
  type?: string;
  error?: string;
  reason?: string;
  description?: string;
  is_final?: boolean;
  speech_final?: boolean;
  channel?: {
    alternatives?: Array<{
      transcript?: string;
      words?: DeepgramWord[];
    }>;
  };
};

type WavFixture = {
  sampleRate: number;
  channels: number;
  byteRate: number;
  blockAlign: number;
  data: ArrayBuffer;
};

const DEFAULT_MODEL = 'nova-3';
const KEEPALIVE_INTERVAL_MS = 8000;
const PCM_BUFFER_SIZE = 4096;
const DEFAULT_AUDIO_STATS_INTERVAL_MS = 500;
const DEFAULT_SILENCE_GATE: Required<SilenceGateOptions> = {
  enabled: false,
  speechThreshold: 0.025,
  silenceTimeoutMs: 60_000,
  minConnectionMs: 10_000,
  preRollMs: 1500,
};

export class DeepgramNovaSpeechEngine implements SpeechEngine {
  private callbacks: SpeechEngineCallbacks = {};
  private language: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly audioFixtureUrl?: string;
  private readonly audioStatsIntervalMs: number;
  private readonly silenceGate: Required<SilenceGateOptions>;

  private active = false;
  private manuallyStopped = false;
  private providedStream: MediaStream | null = null;
  private providedStreamOwned = false;
  private audioSource: AudioPipeline | null = null;
  private ownsAudioSource = false;
  private unsubscribePcm: (() => void) | null = null;
  private unsubscribeLevel: (() => void) | null = null;
  private socket: WebSocket | null = null;
  private keepAliveTimer: number | null = null;
  private fixtureTimer: number | null = null;
  private connecting = false;
  private closingForSilence = false;
  private pausedForSilence = false;
  private stoppingAudioSource: Promise<void> | null = null;
  private lastSpeechAt = 0;
  private connectedAt = 0;
  private preRollMaxBytes = 0;
  private preRollBytes = 0;
  private preRollChunks: ArrayBuffer[] = [];
  private sentFirstAudioChunk = false;
  private audioChunksSent = 0;
  private audioBytesSent = 0;
  private lastAudioStatsEmitMs = Number.NEGATIVE_INFINITY;
  private lastAudioStatsChunks = 0;
  private lastAudioStatsBytes = 0;

  constructor(options: DeepgramNovaSpeechEngineOptions) {
    this.apiKey = options.apiKey;
    this.language = options.language ?? 'en-US';
    this.model = options.model ?? DEFAULT_MODEL;
    this.providedStream = options.mediaStream ?? null;
    this.providedStreamOwned = options.ownsMediaStream ?? false;
    this.audioSource = options.audioSource ?? null;
    this.audioFixtureUrl = options.audioFixtureUrl;
    this.audioStatsIntervalMs = options.audioStatsIntervalMs ?? DEFAULT_AUDIO_STATS_INTERVAL_MS;
    this.silenceGate = { ...DEFAULT_SILENCE_GATE, ...(options.silenceGate ?? {}) };
  }

  start(): void {
    if (this.active) return;

    this.manuallyStopped = false;
    this.closingForSilence = false;
    this.pausedForSilence = false;
    this.connecting = false;
    this.connectedAt = 0;
    this.lastSpeechAt = 0;
    this.sentFirstAudioChunk = false;
    this.audioChunksSent = 0;
    this.audioBytesSent = 0;
    this.lastAudioStatsEmitMs = Number.NEGATIVE_INFINITY;
    this.lastAudioStatsChunks = 0;
    this.lastAudioStatsBytes = 0;
    this.callbacks.onAvailabilityChange?.({ available: true });

    this.active = true;
    this.callbacks.onActiveChange?.(true);

    if (this.audioFixtureUrl) {
      this.callbacks.onStatusChange?.('Connecting to Deepgram Nova…');
      void this.startFixtureSession();
      return;
    }

    void this.startLiveSession();
  }

  stop(): void {
    this.manuallyStopped = true;
    this.active = false;
    this.callbacks.onActiveChange?.(false);
    this.clearKeepAlive();
    this.clearFixtureTimer();
    this.unsubscribeFromAudio();
    this.flushAudioStats(true);

    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'CloseStream' }));
    }
    this.socket?.close();
    this.socket = null;
    this.connecting = false;
    this.closingForSilence = false;
    this.pausedForSilence = false;

    if (this.ownsAudioSource && this.audioSource) {
      const source = this.audioSource;
      this.audioSource = null;
      this.ownsAudioSource = false;
      this.stoppingAudioSource = source.stop().finally(() => {
        if (this.stoppingAudioSource) this.stoppingAudioSource = null;
      });
      void this.stoppingAudioSource;
    }

    this.clearPreRoll();
  }

  setMediaStream(stream: MediaStream | null, options: MediaStreamOptions = {}): void {
    this.providedStream = stream;
    this.providedStreamOwned = options.ownsStream ?? false;
  }

  setAudioSource(source: AudioPipeline | null, options: AudioSourceOptions = {}): void {
    this.audioSource = source;
    this.ownsAudioSource = options.ownsSource ?? false;
  }

  setLanguage(language: string): void {
    this.language = language;
  }

  setCallbacks(callbacks: SpeechEngineCallbacks): void {
    this.callbacks = callbacks;
    this.callbacks.onAvailabilityChange?.({ available: true });
  }

  isActive(): boolean {
    return this.active;
  }

  private async startLiveSession(): Promise<void> {
    try {
      const source = await this.ensureAudioSource();
      const info = source.info;
      if (!info) throw new Error('Audio source is not ready.');

      this.preRollMaxBytes = Math.max(0, Math.ceil(info.sampleRate * info.channels * 2 * (this.silenceGate.preRollMs / 1000)));
      this.unsubscribeLevel = source.subscribeLevel((level) => this.handleInputLevel(level));
      this.unsubscribePcm = source.subscribePcm((pcm) => this.handlePcm(pcm));

      if (this.silenceGate.enabled) {
        this.callbacks.onStatusChange?.('Waiting for speech before connecting to Deepgram…');
        return;
      }

      this.callbacks.onStatusChange?.('Connecting to Deepgram Nova…');
      await this.connectAudioSource();
    } catch (error) {
      this.active = false;
      this.callbacks.onActiveChange?.(false);
      this.callbacks.onStatusChange?.('Could not start microphone capture or Web Audio.');
      this.emitError({ code: 'microphone-permission', message: SPEECH_ERROR_MESSAGES['microphone-permission'], cause: error });
    }
  }

  private async ensureAudioSource(): Promise<AudioPipeline> {
    if (this.stoppingAudioSource) {
      await this.stoppingAudioSource;
    }

    if (!this.audioSource) {
      if (!navigator.mediaDevices?.getUserMedia && !this.providedStream) {
        throw new Error(SPEECH_ERROR_MESSAGES['transcription-unavailable']);
      }
      this.audioSource = new BrowserAudioPipeline({
        mediaStream: this.providedStream ?? undefined,
        ownsMediaStream: this.providedStreamOwned,
        pcmBufferSize: PCM_BUFFER_SIZE,
      });
      this.ownsAudioSource = true;
    }

    if (!this.audioSource.info) {
      await this.audioSource.start();
    }

    return this.audioSource;
  }

  private async connectAudioSource(): Promise<void> {
    if (!this.active || this.connecting || this.socket?.readyState === WebSocket.OPEN) return;

    this.connecting = true;
    try {
      const source = await this.ensureAudioSource();
      const info = source.info;
      if (!info) throw new Error('Audio source is not ready.');

      this.closingForSilence = false;
      this.createSocket(info.sampleRate, info.channels, {
        onOpen: () => {
          this.connecting = false;
          this.connectedAt = Date.now();
          const resumedAfterSilence = this.pausedForSilence;
          this.pausedForSilence = false;
          this.callbacks.onStatusChange?.(
            resumedAfterSilence
              ? `Reconnected to Deepgram after silence. Speaker labels may restart.`
              : `Connected to Deepgram. Streaming ${info.sampleRate}Hz PCM audio${info.worklet ? ' via AudioWorklet' : ' via ScriptProcessor fallback'}…`,
          );
          this.flushPreRoll();
        },
      });
    } catch (error) {
      this.connecting = false;
      throw error;
    }
  }

  private async startFixtureSession(): Promise<void> {
    try {
      const fixture = await loadWavFixture(this.audioFixtureUrl as string);
      this.createSocket(fixture.sampleRate, fixture.channels, {
        onOpen: () => {
          this.callbacks.onStatusChange?.(`Connected to Deepgram. Streaming E2E audio fixture at ${fixture.sampleRate}Hz…`);
          this.startFixtureStreaming(fixture);
        },
      });
    } catch (error) {
      this.active = false;
      this.callbacks.onActiveChange?.(false);
      this.callbacks.onStatusChange?.('Could not start E2E audio fixture.');
      this.emitError({ code: 'processing-failure', message: SPEECH_ERROR_MESSAGES['processing-failure'], cause: error });
    }
  }

  private createSocket(sampleRate: number, channels: number, handlers: { onOpen: () => void }): void {
    const params = new URLSearchParams({
      model: this.model,
      language: this.language,
      diarize: 'true',
      interim_results: 'true',
      smart_format: 'true',
      punctuate: 'true',
      endpointing: '300',
      vad_events: 'true',
      encoding: 'linear16',
      sample_rate: String(sampleRate),
      channels: String(channels),
    });

    const socket = new WebSocket(`wss://api.deepgram.com/v1/listen?${params.toString()}`, ['token', this.apiKey]);
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket || !this.active) return;
      handlers.onOpen();
      this.startKeepAlive();
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      this.handleMessage(event.data);
    };
    socket.onerror = (event) => {
      if (this.socket !== socket) return;
      this.connecting = false;
      this.active = false;
      this.callbacks.onActiveChange?.(false);
      this.callbacks.onStatusChange?.('Deepgram connection error.');
      this.unsubscribeFromAudio();
      this.emitError({ code: 'connectivity-loss', message: SPEECH_ERROR_MESSAGES['connectivity-loss'], cause: event });
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.connecting = false;
      this.clearKeepAlive();
      this.clearFixtureTimer();
      this.flushAudioStats(true);

      if (this.closingForSilence && this.active && !this.manuallyStopped) {
        this.closingForSilence = false;
        this.pausedForSilence = true;
        this.socket = null;
        this.callbacks.onStatusChange?.('Paused Deepgram after sustained silence. Waiting for speech…');
        return;
      }

      this.socket = null;
      if (!this.manuallyStopped) {
        this.unsubscribeFromAudio();
        this.active = false;
        this.callbacks.onActiveChange?.(false);
        const reason = event.reason ? ` (${event.code}: ${event.reason})` : ` (${event.code})`;
        this.callbacks.onStatusChange?.(`Deepgram connection closed unexpectedly${reason}.`);
        this.emitError({ code: 'connectivity-loss', message: `${SPEECH_ERROR_MESSAGES['connectivity-loss']} Deepgram close code: ${event.code}.`, cause: event });
      }
    };
  }

  private handleInputLevel(level: number): void {
    if (!this.active || !this.silenceGate.enabled) return;

    const now = Date.now();
    if (level >= this.silenceGate.speechThreshold) {
      this.lastSpeechAt = now;
      if (!this.socket || this.socket.readyState === WebSocket.CLOSED) {
        this.callbacks.onStatusChange?.('Speech detected; connecting to Deepgram…');
        void this.connectAudioSource();
      }
      return;
    }

    if (!this.lastSpeechAt || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    const silentForMs = now - this.lastSpeechAt;
    const connectedForMs = now - this.connectedAt;
    if (silentForMs >= this.silenceGate.silenceTimeoutMs && connectedForMs >= this.silenceGate.minConnectionMs) {
      this.pauseDeepgramForSilence();
    }
  }

  private pauseDeepgramForSilence(): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.closingForSilence = true;
    this.callbacks.onStatusChange?.('Sustained silence detected. Pausing Deepgram stream…');
    this.socket.send(JSON.stringify({ type: 'CloseStream' }));
    this.socket.close();
  }

  private handlePcm(pcm: ArrayBuffer): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.sendPcm(pcm);
      return;
    }

    this.bufferPreRoll(pcm);
  }

  private bufferPreRoll(pcm: ArrayBuffer): void {
    if (!this.preRollMaxBytes) return;

    const copy = pcm.slice(0);
    this.preRollChunks.push(copy);
    this.preRollBytes += copy.byteLength;

    while (this.preRollBytes > this.preRollMaxBytes && this.preRollChunks.length) {
      const removed = this.preRollChunks.shift();
      this.preRollBytes -= removed?.byteLength ?? 0;
    }
  }

  private flushPreRoll(): void {
    if (!this.preRollChunks.length) return;

    const chunks = this.preRollChunks;
    this.preRollChunks = [];
    this.preRollBytes = 0;
    chunks.forEach((chunk) => this.sendPcm(chunk));
  }

  private clearPreRoll(): void {
    this.preRollChunks = [];
    this.preRollBytes = 0;
  }

  private sendPcm(pcm: ArrayBuffer): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;

    this.socket.send(pcm);
    this.noteAudioSent(pcm.byteLength);

    if (!this.sentFirstAudioChunk) {
      this.sentFirstAudioChunk = true;
      this.callbacks.onStatusChange?.('Audio is streaming to Deepgram. Waiting for transcript…');
    }
  }

  private startFixtureStreaming(fixture: WavFixture): void {
    this.clearFixtureTimer();
    const chunkBytes = Math.max(fixture.blockAlign, Math.floor(fixture.byteRate / 10 / fixture.blockAlign) * fixture.blockAlign);
    let offset = 0;

    const sendNextChunk = () => {
      if (this.socket?.readyState !== WebSocket.OPEN || offset >= fixture.data.byteLength) {
        this.clearFixtureTimer();
        if (this.socket?.readyState === WebSocket.OPEN) {
          this.socket.send(JSON.stringify({ type: 'CloseStream' }));
        }
        return;
      }

      const chunk = fixture.data.slice(offset, Math.min(offset + chunkBytes, fixture.data.byteLength));
      offset += chunk.byteLength;
      this.socket.send(chunk);
      this.noteAudioSent(chunk.byteLength);

      if (!this.sentFirstAudioChunk) {
        this.sentFirstAudioChunk = true;
        this.callbacks.onStatusChange?.('Audio fixture is streaming to Deepgram. Waiting for transcript…');
      }
    };

    sendNextChunk();
    this.fixtureTimer = window.setInterval(sendNextChunk, 100);
  }

  private handleMessage(data: unknown): void {
    if (typeof data !== 'string') return;

    let message: DeepgramMessage;
    try {
      message = JSON.parse(data) as DeepgramMessage;
    } catch {
      return;
    }

    if (message.type === 'Metadata') {
      this.callbacks.onStatusChange?.('Deepgram stream is ready. Speak clearly near the microphone.');
      return;
    }

    if (message.type === 'SpeechStarted') {
      this.callbacks.onStatusChange?.('Speech detected. Transcribing…');
      return;
    }

    if (message.type === 'Error') {
      this.callbacks.onStatusChange?.('Deepgram returned an error.');
      this.emitError({
        code: 'processing-failure',
        message: message.description || message.reason || message.error || SPEECH_ERROR_MESSAGES['processing-failure'],
        cause: message,
      });
      return;
    }

    if (message.type && message.type !== 'Results') return;

    const alternative = message.channel?.alternatives?.[0];
    const text = alternative?.transcript?.trim();
    if (!text) return;

    this.callbacks.onStatusChange?.(message.is_final || message.speech_final ? 'Final transcript received.' : 'Live transcript received.');
    const speakerSegments = this.getSpeakerSegments(alternative?.words ?? [], text);
    speakerSegments.forEach((segment) => {
      if (message.is_final || message.speech_final) {
        this.callbacks.onFinalText?.(segment.text, segment.speakerLabel);
      } else {
        this.callbacks.onInterimText?.(segment.text, segment.speakerLabel);
      }
    });
  }

  private getSpeakerSegments(words: DeepgramWord[], fallbackText: string): Array<{ text: string; speakerLabel: string }> {
    if (!words.length) return [{ text: fallbackText, speakerLabel: 'Uncertain speaker' }];

    const segments: Array<{ speaker?: number; words: string[] }> = [];
    words.forEach((word) => {
      const text = word.punctuated_word ?? word.word;
      if (!text) return;

      const current = segments.at(-1);
      if (!current || current.speaker !== word.speaker) {
        segments.push({ speaker: word.speaker, words: [text] });
        return;
      }
      current.words.push(text);
    });

    return segments
      .map((segment) => ({
        text: segment.words.join(' ').trim(),
        speakerLabel: typeof segment.speaker === 'number' ? `Person ${segment.speaker + 1}` : 'Uncertain speaker',
      }))
      .filter((segment) => segment.text.length > 0);
  }

  private noteAudioSent(byteLength: number): void {
    this.audioChunksSent += 1;
    this.audioBytesSent += byteLength;
    this.flushAudioStats(false);
  }

  private flushAudioStats(force: boolean): void {
    if (!this.audioChunksSent) return;
    if (this.audioChunksSent === this.lastAudioStatsChunks && this.audioBytesSent === this.lastAudioStatsBytes) return;

    const now = Date.now();
    if (!force && now - this.lastAudioStatsEmitMs < this.audioStatsIntervalMs) {
      return;
    }

    this.lastAudioStatsEmitMs = now;
    this.lastAudioStatsChunks = this.audioChunksSent;
    this.lastAudioStatsBytes = this.audioBytesSent;
    this.callbacks.onAudioSend?.({ chunks: this.audioChunksSent, bytes: this.audioBytesSent });
  }

  private startKeepAlive(): void {
    this.clearKeepAlive();
    this.keepAliveTimer = window.setInterval(() => {
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ type: 'KeepAlive' }));
      }
    }, KEEPALIVE_INTERVAL_MS);
  }

  private clearKeepAlive(): void {
    if (this.keepAliveTimer !== null) {
      window.clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  private clearFixtureTimer(): void {
    if (this.fixtureTimer !== null) {
      window.clearInterval(this.fixtureTimer);
      this.fixtureTimer = null;
    }
  }

  private unsubscribeFromAudio(): void {
    this.unsubscribePcm?.();
    this.unsubscribePcm = null;
    this.unsubscribeLevel?.();
    this.unsubscribeLevel = null;
  }

  private emitError(error: SpeechErrorState): void {
    this.callbacks.onError?.(error);
  }
}

async function loadWavFixture(url: string): Promise<WavFixture> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not load E2E audio fixture: ${response.status}`);
  }

  const buffer = await response.arrayBuffer();
  const view = new DataView(buffer);
  if (ascii(buffer, 0, 4) !== 'RIFF' || ascii(buffer, 8, 12) !== 'WAVE') {
    throw new Error('E2E audio fixture must be a RIFF/WAVE file.');
  }

  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let byteRate = 0;
  let blockAlign = 0;
  let bitsPerSample = 0;
  let data: ArrayBuffer | null = null;

  while (offset + 8 <= buffer.byteLength) {
    const id = ascii(buffer, offset, offset + 4);
    const size = view.getUint32(offset + 4, true);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + size;

    if (id === 'fmt ') {
      const audioFormat = view.getUint16(chunkStart, true);
      channels = view.getUint16(chunkStart + 2, true);
      sampleRate = view.getUint32(chunkStart + 4, true);
      byteRate = view.getUint32(chunkStart + 8, true);
      blockAlign = view.getUint16(chunkStart + 12, true);
      bitsPerSample = view.getUint16(chunkStart + 14, true);
      if (audioFormat !== 1 || bitsPerSample !== 16) {
        throw new Error('E2E audio fixture must be 16-bit PCM WAV.');
      }
    }

    if (id === 'data') {
      data = buffer.slice(chunkStart, chunkEnd);
      break;
    }

    offset = chunkEnd + (size % 2);
  }

  if (!data || !sampleRate || !channels || !byteRate || !blockAlign) {
    throw new Error('Could not parse E2E WAV fixture.');
  }

  return { sampleRate, channels, byteRate, blockAlign, data };
}

function ascii(buffer: ArrayBuffer, start: number, end: number): string {
  return String.fromCharCode(...new Uint8Array(buffer.slice(start, end)));
}
