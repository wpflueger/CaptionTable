import {
  SPEECH_ERROR_MESSAGES,
  SpeechEngine,
  SpeechEngineCallbacks,
  SpeechErrorCode,
  SpeechErrorState,
} from './SpeechEngine';

interface BrowserSpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onend: ((event: Event) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  abort(): void;
  start(): void;
  stop(): void;
}

type SpeechRecognitionConstructor = new () => BrowserSpeechRecognition;

type BrowserSpeechRecognitionWindow = Window & {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
};

export class BrowserSpeechEngine implements SpeechEngine {
  private callbacks: SpeechEngineCallbacks = {};
  private language: string;
  private recognition: BrowserSpeechRecognition | null = null;
  private active = false;
  private manuallyStopped = false;
  private restartTimer: number | null = null;
  private readonly SpeechRecognitionCtor?: SpeechRecognitionConstructor;

  constructor(language = 'en-US', speechWindow: BrowserSpeechRecognitionWindow = window) {
    this.language = language;
    this.SpeechRecognitionCtor = speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;

    this.callbacks.onAvailabilityChange?.({
      available: Boolean(this.SpeechRecognitionCtor),
      message: this.SpeechRecognitionCtor ? undefined : SPEECH_ERROR_MESSAGES['transcription-unavailable'],
    });
  }

  start(): void {
    if (this.active) {
      return;
    }

    if (!this.SpeechRecognitionCtor) {
      this.emitError('transcription-unavailable');
      this.callbacks.onAvailabilityChange?.({
        available: false,
        message: SPEECH_ERROR_MESSAGES['transcription-unavailable'],
      });
      return;
    }

    this.clearRestartTimer();
    this.manuallyStopped = false;
    this.recognition = new this.SpeechRecognitionCtor();
    this.recognition.lang = this.language;
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.maxAlternatives = 1;
    this.recognition.onresult = this.handleResult;
    this.recognition.onerror = this.handleError;
    this.recognition.onend = this.handleEnd;

    try {
      this.recognition.start();
      this.active = true;
      this.callbacks.onAvailabilityChange?.({ available: true });
    } catch (cause) {
      this.active = false;
      this.emitError('processing-failure', cause);
    }
  }

  stop(): void {
    this.manuallyStopped = true;
    this.active = false;
    this.clearRestartTimer();

    if (!this.recognition) {
      return;
    }

    const recognition = this.recognition;
    this.recognition = null;
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;
    recognition.stop();
    recognition.abort();
  }

  setLanguage(language: string): void {
    this.language = language;
    if (this.recognition) {
      this.recognition.lang = language;
    }
  }

  setCallbacks(callbacks: SpeechEngineCallbacks): void {
    this.callbacks = callbacks;
    this.callbacks.onAvailabilityChange?.({
      available: Boolean(this.SpeechRecognitionCtor),
      message: this.SpeechRecognitionCtor ? undefined : SPEECH_ERROR_MESSAGES['transcription-unavailable'],
    });
  }

  isActive(): boolean {
    return this.active;
  }

  private handleResult = (event: SpeechRecognitionEvent): void => {
    let interimText = '';

    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      const text = result[0]?.transcript ?? '';

      if (result.isFinal) {
        this.callbacks.onFinalText?.(text.trim());
      } else {
        interimText += text;
      }
    }

    this.callbacks.onInterimText?.(interimText.trim());
  };

  private handleError = (event: SpeechRecognitionErrorEvent): void => {
    if (event.error === 'no-speech') {
      return;
    }

    this.manuallyStopped = true;
    this.active = false;
    this.emitError(this.mapError(event.error), event);
  };

  private handleEnd = (): void => {
    this.active = false;
    this.recognition = null;

    if (!this.manuallyStopped) {
      this.restartTimer = window.setTimeout(() => {
        this.restartTimer = null;
        this.start();
      }, 250);
    }
  };

  private mapError(error: string): SpeechErrorCode {
    switch (error) {
      case 'not-allowed':
      case 'service-not-allowed':
        return 'microphone-permission';
      case 'network':
        return 'connectivity-loss';
      case 'language-not-supported':
        return 'transcription-unavailable';
      default:
        return 'processing-failure';
    }
  }

  private clearRestartTimer(): void {
    if (this.restartTimer !== null) {
      window.clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  private emitError(code: SpeechErrorCode, cause?: unknown): void {
    const error: SpeechErrorState = {
      code,
      message: SPEECH_ERROR_MESSAGES[code],
      cause,
    };
    this.callbacks.onError?.(error);
  }
}
