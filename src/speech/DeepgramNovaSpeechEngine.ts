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
}

export interface MediaStreamOptions {
  ownsStream?: boolean;
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

type BrowserAudioWindow = Window & {
  webkitAudioContext?: typeof AudioContext;
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

export class DeepgramNovaSpeechEngine implements SpeechEngine {
  private callbacks: SpeechEngineCallbacks = {};
  private language: string;
  private readonly apiKey: string;
  private readonly model: string;
  private active = false;
  private manuallyStopped = false;
  private stream: MediaStream | null = null;
  private providedStream: MediaStream | null = null;
  private providedStreamOwned = false;
  private activeStreamOwned = false;
  private socket: WebSocket | null = null;
  private keepAliveTimer: number | null = null;
  private fixtureTimer: number | null = null;
  private audioContext: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private processorNode: ScriptProcessorNode | null = null;
  private silenceNode: GainNode | null = null;
  private readonly audioFixtureUrl?: string;
  private readonly audioStatsIntervalMs: number;
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
    this.audioFixtureUrl = options.audioFixtureUrl;
    this.audioStatsIntervalMs = options.audioStatsIntervalMs ?? DEFAULT_AUDIO_STATS_INTERVAL_MS;
  }

  start(): void {
    if (this.active) return;

    if (!navigator.mediaDevices?.getUserMedia) {
      this.emitError({ code: 'transcription-unavailable', message: SPEECH_ERROR_MESSAGES['transcription-unavailable'] });
      this.callbacks.onAvailabilityChange?.({ available: false, message: SPEECH_ERROR_MESSAGES['transcription-unavailable'] });
      return;
    }

    const AudioContextCtor = window.AudioContext || (window as BrowserAudioWindow).webkitAudioContext;
    if (!AudioContextCtor) {
      this.emitError({ code: 'transcription-unavailable', message: 'Web Audio is not available in this browser.' });
      this.callbacks.onAvailabilityChange?.({ available: false, message: 'Web Audio is not available in this browser.' });
      return;
    }

    this.manuallyStopped = false;
    this.sentFirstAudioChunk = false;
    this.audioChunksSent = 0;
    this.audioBytesSent = 0;
    this.lastAudioStatsEmitMs = Number.NEGATIVE_INFINITY;
    this.lastAudioStatsChunks = 0;
    this.lastAudioStatsBytes = 0;
    this.callbacks.onAvailabilityChange?.({ available: true });
    this.callbacks.onStatusChange?.('Connecting to Deepgram Nova…');

    void this.open(AudioContextCtor);
  }

  stop(): void {
    this.manuallyStopped = true;
    this.active = false;
    this.callbacks.onActiveChange?.(false);
    this.clearKeepAlive();
    this.clearFixtureTimer();
    this.flushAudioStats(true);
    this.stopPcmStreaming();

    if (this.activeStreamOwned) {
      this.stream?.getTracks().forEach((track) => track.stop());
    }
    this.stream = null;
    this.activeStreamOwned = false;

    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'CloseStream' }));
    }
    this.socket?.close();
    this.socket = null;
  }

  setMediaStream(stream: MediaStream | null, options: MediaStreamOptions = {}): void {
    this.providedStream = stream;
    this.providedStreamOwned = options.ownsStream ?? false;
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

  private async open(AudioContextCtor: typeof AudioContext): Promise<void> {
    try {
      const fixture = this.audioFixtureUrl ? await loadWavFixture(this.audioFixtureUrl) : null;
      if (!fixture) {
        if (this.providedStream) {
          this.stream = this.providedStream;
          this.activeStreamOwned = this.providedStreamOwned;
        } else {
          this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          this.activeStreamOwned = true;
        }
        this.audioContext = new AudioContextCtor();
        if (this.audioContext.state === 'suspended') {
          await this.audioContext.resume();
        }
      }

      const sampleRate = fixture?.sampleRate ?? Math.round(this.audioContext?.sampleRate ?? 48000);
      const channels = fixture?.channels ?? 1;
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

      this.socket = new WebSocket(`wss://api.deepgram.com/v1/listen?${params.toString()}`, ['token', this.apiKey]);
      this.socket.onopen = () => {
        if (!this.socket) return;
        this.active = true;
        this.callbacks.onActiveChange?.(true);
        if (fixture) {
          this.callbacks.onStatusChange?.(`Connected to Deepgram. Streaming E2E audio fixture at ${fixture.sampleRate}Hz…`);
          this.startFixtureStreaming(fixture);
        } else if (this.stream && this.audioContext) {
          this.callbacks.onStatusChange?.(`Connected to Deepgram. Streaming ${Math.round(this.audioContext.sampleRate)}Hz PCM audio…`);
          this.startPcmStreaming(this.stream, this.audioContext);
        }
        this.startKeepAlive();
      };
      this.socket.onmessage = (event) => this.handleMessage(event.data);
      this.socket.onerror = (event) => {
        this.active = false;
        this.callbacks.onActiveChange?.(false);
        this.callbacks.onStatusChange?.('Deepgram connection error.');
        this.emitError({ code: 'connectivity-loss', message: SPEECH_ERROR_MESSAGES['connectivity-loss'], cause: event });
      };
      this.socket.onclose = (event) => {
        this.active = false;
        this.callbacks.onActiveChange?.(false);
        this.clearKeepAlive();
        this.clearFixtureTimer();
        this.flushAudioStats(true);
        this.stopPcmStreaming();
        if (!this.manuallyStopped) {
          const reason = event.reason ? ` (${event.code}: ${event.reason})` : ` (${event.code})`;
          this.callbacks.onStatusChange?.(`Deepgram connection closed unexpectedly${reason}.`);
          this.emitError({ code: 'connectivity-loss', message: `${SPEECH_ERROR_MESSAGES['connectivity-loss']} Deepgram close code: ${event.code}.`, cause: event });
        }
      };
    } catch (error) {
      this.active = false;
      this.callbacks.onActiveChange?.(false);
      this.callbacks.onStatusChange?.('Could not start microphone capture or Web Audio.');
      this.emitError({ code: 'microphone-permission', message: SPEECH_ERROR_MESSAGES['microphone-permission'], cause: error });
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

  private startPcmStreaming(stream: MediaStream, audioContext: AudioContext): void {
    this.stopPcmStreaming(false);
    this.sourceNode = audioContext.createMediaStreamSource(stream);
    this.processorNode = audioContext.createScriptProcessor(PCM_BUFFER_SIZE, 1, 1);
    this.silenceNode = audioContext.createGain();
    this.silenceNode.gain.value = 0;

    this.processorNode.onaudioprocess = (event) => {
      if (this.socket?.readyState !== WebSocket.OPEN) return;
      const samples = event.inputBuffer.getChannelData(0);
      const pcm = float32ToLinear16(samples);
      this.socket.send(pcm);
      this.noteAudioSent(pcm.byteLength);

      if (!this.sentFirstAudioChunk) {
        this.sentFirstAudioChunk = true;
        this.callbacks.onStatusChange?.('Audio is streaming to Deepgram. Waiting for transcript…');
      } else if (this.audioChunksSent % 50 === 0) {
        this.callbacks.onStatusChange?.(`Audio is streaming to Deepgram (${this.audioChunksSent} chunks, ${Math.round(this.audioBytesSent / 1024)} KB). Waiting for transcript…`);
      }
    };

    this.sourceNode.connect(this.processorNode);
    this.processorNode.connect(this.silenceNode);
    this.silenceNode.connect(audioContext.destination);
  }

  private stopPcmStreaming(closeContext = true): void {
    this.processorNode?.disconnect();
    this.sourceNode?.disconnect();
    this.silenceNode?.disconnect();
    this.processorNode = null;
    this.sourceNode = null;
    this.silenceNode = null;

    if (closeContext && this.audioContext) {
      void this.audioContext.close();
      this.audioContext = null;
    }
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

function float32ToLinear16(samples: Float32Array): ArrayBuffer {
  const output = new ArrayBuffer(samples.length * 2);
  const view = new DataView(output);
  samples.forEach((sample, index) => {
    const clamped = Math.max(-1, Math.min(1, sample));
    const value = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    view.setInt16(index * 2, value, true);
  });
  return output;
}
