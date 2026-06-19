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
}

type DeepgramWord = {
  word?: string;
  punctuated_word?: string;
  speaker?: number;
};

type DeepgramMessage = {
  type?: string;
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
  private recorder: MediaRecorder | null = null;
  private socket: WebSocket | null = null;
  private keepAliveTimer: number | null = null;

  constructor(options: DeepgramNovaSpeechEngineOptions) {
    this.apiKey = options.apiKey;
    this.language = options.language ?? 'en-US';
    this.model = options.model ?? DEFAULT_MODEL;
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
    this.callbacks.onAvailabilityChange?.({ available: true });

    void this.open();
  }

  stop(): void {
    this.manuallyStopped = true;
    this.active = false;
    this.callbacks.onActiveChange?.(false);
    this.clearKeepAlive();

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

  setCallbacks(callbacks: SpeechEngineCallbacks): void {
    this.callbacks = callbacks;
    this.callbacks.onAvailabilityChange?.({ available: true });
  }

  isActive(): boolean {
    return this.active;
  }

  private async open(): Promise<void> {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = this.pickMimeType();
      const params = new URLSearchParams({
        model: this.model,
        language: this.language,
        diarize: 'true',
        interim_results: 'true',
        smart_format: 'true',
        punctuate: 'true',
        endpointing: '300',
      });

      this.socket = new WebSocket(`wss://api.deepgram.com/v1/listen?${params.toString()}`, ['token', this.apiKey]);
      this.socket.onopen = () => {
        if (!this.stream || !this.socket) {
          return;
        }

        this.active = true;
        this.callbacks.onActiveChange?.(true);
        this.recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
        this.recorder.ondataavailable = (event) => {
          if (event.data.size > 0 && this.socket?.readyState === WebSocket.OPEN) {
            this.socket.send(event.data);
          }
        };
        this.recorder.onerror = (event) => {
          this.emitError({ code: 'processing-failure', message: SPEECH_ERROR_MESSAGES['processing-failure'], cause: event });
        };
        this.recorder.start(DEFAULT_TIMESLICE_MS);
        this.startKeepAlive();
      };
      this.socket.onmessage = (event) => this.handleMessage(event.data);
      this.socket.onerror = (event) => {
        this.active = false;
        this.callbacks.onActiveChange?.(false);
        this.emitError({ code: 'connectivity-loss', message: SPEECH_ERROR_MESSAGES['connectivity-loss'], cause: event });
      };
      this.socket.onclose = () => {
        this.active = false;
        this.callbacks.onActiveChange?.(false);
        this.clearKeepAlive();
        if (!this.manuallyStopped) {
          this.emitError({ code: 'connectivity-loss', message: SPEECH_ERROR_MESSAGES['connectivity-loss'] });
        }
      };
    } catch (error) {
      this.active = false;
      this.callbacks.onActiveChange?.(false);
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
    if (message.type && message.type !== 'Results') {
      return;
    }

    const alternative = message.channel?.alternatives?.[0];
    const text = alternative?.transcript?.trim();
    if (!text) {
      return;
    }

    const speakerLabel = this.getSpeakerLabel(alternative?.words ?? []);
    if (message.is_final || message.speech_final) {
      this.callbacks.onFinalText?.(text, speakerLabel);
    } else {
      this.callbacks.onInterimText?.(text, speakerLabel);
    }
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

  private emitError(error: SpeechErrorState): void {
    this.callbacks.onError?.(error);
  }
}
