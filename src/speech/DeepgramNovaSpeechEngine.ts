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

const DEFAULT_MODEL = 'nova-3';
const DEFAULT_TIMESLICE_MS = 250;
const KEEPALIVE_INTERVAL_MS = 8000;

export class DeepgramNovaSpeechEngine implements SpeechEngine {
  private callbacks: SpeechEngineCallbacks = {};
  private language: string;
  private readonly apiKey: string;
  private readonly model: string;
  private active = false;
  private manuallyStopped = false;
  private stream: MediaStream | null = null;
  private providedStream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private socket: WebSocket | null = null;
  private keepAliveTimer: number | null = null;
  private recorderWatchdogTimer: number | null = null;
  private sentFirstAudioChunk = false;
  private audioChunksSent = 0;
  private audioBytesSent = 0;
  private usingFallbackRecorderStream = false;

  constructor(options: DeepgramNovaSpeechEngineOptions) {
    this.apiKey = options.apiKey;
    this.language = options.language ?? 'en-US';
    this.model = options.model ?? DEFAULT_MODEL;
    this.providedStream = options.mediaStream ?? null;
  }

  start(): void {
    if (this.active) {
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      this.emitError({ code: 'transcription-unavailable', message: SPEECH_ERROR_MESSAGES['transcription-unavailable'] });
      this.callbacks.onAvailabilityChange?.({
        available: false,
        message: SPEECH_ERROR_MESSAGES['transcription-unavailable'],
      });
      return;
    }

    this.manuallyStopped = false;
    this.sentFirstAudioChunk = false;
    this.audioChunksSent = 0;
    this.audioBytesSent = 0;
    this.callbacks.onAvailabilityChange?.({ available: true });
    this.callbacks.onStatusChange?.('Connecting to Deepgram Nova…');

    void this.open();
  }

  stop(): void {
    this.manuallyStopped = true;
    this.active = false;
    this.callbacks.onActiveChange?.(false);
    this.clearKeepAlive();
    this.clearRecorderWatchdog();

    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.stop();
    }
    this.recorder = null;

    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;

    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'CloseStream' }));
    }
    this.socket?.close();
    this.socket = null;
  }

  setLanguage(language: string): void {
    this.language = language;
  }

  setMediaStream(stream: MediaStream | null): void {
    this.providedStream = stream;
  }

  setCallbacks(callbacks: SpeechEngineCallbacks): void {
    this.callbacks = callbacks;
    this.callbacks.onAvailabilityChange?.({ available: true });
  }

  isActive(): boolean {
    return this.active;
  }

  private async open(): Promise<void> {
    try {
      this.usingFallbackRecorderStream = false;
      this.stream = this.providedStream ?? await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = this.pickMimeType();
      const params = new URLSearchParams({
        model: this.model,
        language: this.language,
        diarize: 'true',
        interim_results: 'true',
        smart_format: 'true',
        punctuate: 'true',
        endpointing: '300',
        vad_events: 'true',
      });

      this.socket = new WebSocket(`wss://api.deepgram.com/v1/listen?${params.toString()}`, ['token', this.apiKey]);
      this.socket.onopen = () => {
        if (!this.stream || !this.socket) {
          return;
        }

        this.active = true;
        this.callbacks.onActiveChange?.(true);
        this.callbacks.onStatusChange?.('Connected to Deepgram. Starting browser audio recorder…');
        this.startRecorder(this.stream, mimeType);
        this.startKeepAlive();
      };
      this.socket.onmessage = (event) => this.handleMessage(event.data);
      this.socket.onerror = (event) => {
        this.active = false;
        this.callbacks.onActiveChange?.(false);
        this.callbacks.onStatusChange?.('Deepgram connection error.');
        this.emitError({ code: 'connectivity-loss', message: SPEECH_ERROR_MESSAGES['connectivity-loss'], cause: event });
      };
      this.socket.onclose = () => {
        this.active = false;
        this.callbacks.onActiveChange?.(false);
        this.clearKeepAlive();
        this.clearRecorderWatchdog();
        if (!this.manuallyStopped) {
          this.callbacks.onStatusChange?.('Deepgram connection closed unexpectedly.');
          this.emitError({ code: 'connectivity-loss', message: SPEECH_ERROR_MESSAGES['connectivity-loss'] });
        }
      };
    } catch (error) {
      this.active = false;
      this.callbacks.onActiveChange?.(false);
      this.callbacks.onStatusChange?.('Could not start microphone capture.');
      this.emitError({ code: 'microphone-permission', message: SPEECH_ERROR_MESSAGES['microphone-permission'], cause: error });
    }
  }

  private startRecorder(stream: MediaStream, mimeType: string | undefined): void {
    this.clearRecorderWatchdog();

    try {
      this.recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    } catch (error) {
      this.callbacks.onStatusChange?.('Browser MediaRecorder failed to start for the microphone stream.');
      this.emitError({ code: 'processing-failure', message: 'Browser MediaRecorder failed to start for the microphone stream.', cause: error });
      return;
    }

    this.recorder.ondataavailable = (event) => {
      if (event.data.size > 0 && this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(event.data);
        this.audioChunksSent += 1;
        this.audioBytesSent += event.data.size;
        this.callbacks.onAudioSend?.({ chunks: this.audioChunksSent, bytes: this.audioBytesSent });
        if (!this.sentFirstAudioChunk) {
          this.sentFirstAudioChunk = true;
          this.clearRecorderWatchdog();
          this.callbacks.onStatusChange?.('Audio is streaming to Deepgram. Waiting for transcript…');
        } else if (this.audioChunksSent % 20 === 0) {
          this.callbacks.onStatusChange?.(`Audio is streaming to Deepgram (${this.audioChunksSent} chunks, ${Math.round(this.audioBytesSent / 1024)} KB). Waiting for transcript…`);
        }
      }
    };
    this.recorder.onerror = (event) => {
      this.callbacks.onStatusChange?.('Browser MediaRecorder reported an error.');
      this.emitError({ code: 'processing-failure', message: SPEECH_ERROR_MESSAGES['processing-failure'], cause: event });
    };
    this.recorder.onstart = () => {
      this.callbacks.onStatusChange?.(`Browser audio recorder started (${this.recorder?.mimeType || mimeType || 'default audio format'}). Waiting for audio chunks…`);
    };
    this.recorder.onstop = () => {
      if (!this.manuallyStopped && this.active) {
        this.callbacks.onStatusChange?.('Browser audio recorder stopped unexpectedly.');
      }
    };

    this.recorder.start(DEFAULT_TIMESLICE_MS);
    this.startRecorderWatchdog(mimeType);
  }

  private startRecorderWatchdog(mimeType: string | undefined): void {
    this.clearRecorderWatchdog();
    this.recorderWatchdogTimer = window.setTimeout(() => {
      this.recorderWatchdogTimer = null;
      if (this.audioChunksSent > 0 || this.manuallyStopped || !this.active) {
        return;
      }

      this.callbacks.onStatusChange?.('No audio chunks from browser recorder yet. Restarting recorder with a fresh microphone stream…');
      void this.restartRecorderWithFreshStream(mimeType);
    }, 3000);
  }

  private async restartRecorderWithFreshStream(mimeType: string | undefined): Promise<void> {
    if (this.usingFallbackRecorderStream || !navigator.mediaDevices?.getUserMedia) {
      this.callbacks.onStatusChange?.('Browser recorder still has not produced audio chunks. Check Chrome microphone input and reload.');
      return;
    }

    this.usingFallbackRecorderStream = true;
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.stop();
    }

    try {
      const fallbackStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.stream = fallbackStream;
      this.callbacks.onStatusChange?.('Restarted browser recorder with a fresh microphone stream. Waiting for audio chunks…');
      this.startRecorder(fallbackStream, mimeType);
    } catch (error) {
      this.callbacks.onStatusChange?.('Could not restart microphone recorder.');
      this.emitError({ code: 'microphone-permission', message: SPEECH_ERROR_MESSAGES['microphone-permission'], cause: error });
    }
  }

  private handleMessage(data: unknown): void {
    if (typeof data !== 'string') {
      return;
    }

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

    if (message.type && message.type !== 'Results') {
      return;
    }

    const alternative = message.channel?.alternatives?.[0];
    const text = alternative?.transcript?.trim();
    if (!text) {
      return;
    }

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
    if (!words.length) {
      return [{ text: fallbackText, speakerLabel: 'Uncertain speaker' }];
    }

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

    return segments.map((segment) => ({
      text: segment.words.join(' ').trim(),
      speakerLabel: typeof segment.speaker === 'number' ? `Person ${segment.speaker + 1}` : 'Uncertain speaker',
    })).filter((segment) => segment.text.length > 0);
  }

  private getSpeakerLabel(words: DeepgramWord[]): string {
    const speakerCounts = new Map<number, number>();
    words.forEach((word) => {
      if (typeof word.speaker === 'number') {
        speakerCounts.set(word.speaker, (speakerCounts.get(word.speaker) ?? 0) + 1);
      }
    });

    let bestSpeaker: number | null = null;
    let bestCount = 0;
    speakerCounts.forEach((count, speaker) => {
      if (count > bestCount) {
        bestSpeaker = speaker;
        bestCount = count;
      }
    });

    return bestSpeaker === null ? 'Uncertain speaker' : `Person ${bestSpeaker + 1}`;
  }

  private pickMimeType(): string | undefined {
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
    return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate));
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

  private clearRecorderWatchdog(): void {
    if (this.recorderWatchdogTimer !== null) {
      window.clearTimeout(this.recorderWatchdogTimer);
      this.recorderWatchdogTimer = null;
    }
  }

  private emitError(error: SpeechErrorState): void {
    this.callbacks.onError?.(error);
  }
}
