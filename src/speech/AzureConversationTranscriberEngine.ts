import * as SpeechSDK from 'microsoft-cognitiveservices-speech-sdk';
import {
  SPEECH_ERROR_MESSAGES,
  SpeechEngine,
  SpeechEngineCallbacks,
  SpeechErrorState,
} from './SpeechEngine';

export interface AzureConversationTranscriberOptions {
  speechKey: string;
  region: string;
  language?: string;
}

export class AzureConversationTranscriberEngine implements SpeechEngine {
  private callbacks: SpeechEngineCallbacks = {};
  private transcriber: SpeechSDK.ConversationTranscriber | null = null;
  private speechConfig: SpeechSDK.SpeechConfig;
  private language: string;
  private active = false;
  private readonly speakerNames = new Map<string, string>();

  constructor(options: AzureConversationTranscriberOptions) {
    this.language = options.language ?? 'en-US';
    this.speechConfig = SpeechSDK.SpeechConfig.fromSubscription(options.speechKey, options.region);
    this.speechConfig.speechRecognitionLanguage = this.language;
    this.callbacks.onAvailabilityChange?.({ available: true });
  }

  start(): void {
    if (this.active) {
      return;
    }

    try {
      const audioConfig = SpeechSDK.AudioConfig.fromDefaultMicrophoneInput();
      this.transcriber = new SpeechSDK.ConversationTranscriber(this.speechConfig, audioConfig);
      this.transcriber.transcribing = (_sender, event) => {
        const text = event.result.text?.trim();
        if (text) {
          this.callbacks.onInterimText?.(text, this.toSpeakerLabel(event.result.speakerId));
        }
      };
      this.transcriber.transcribed = (_sender, event) => {
        const text = event.result.text?.trim();
        if (text) {
          this.callbacks.onFinalText?.(text, this.toSpeakerLabel(event.result.speakerId));
        }
      };
      this.transcriber.canceled = (_sender, event) => {
        this.active = false;
        this.emitError({
          code: event.errorCode === SpeechSDK.CancellationErrorCode.ConnectionFailure ? 'connectivity-loss' : 'processing-failure',
          message: event.errorDetails || SPEECH_ERROR_MESSAGES['processing-failure'],
          cause: event,
        });
      };
      this.transcriber.sessionStopped = () => {
        this.active = false;
      };
      this.transcriber.startTranscribingAsync(
        () => {
          this.active = true;
          this.callbacks.onAvailabilityChange?.({ available: true });
        },
        (error) => {
          this.active = false;
          this.emitError({ code: 'processing-failure', message: String(error), cause: error });
        },
      );
    } catch (error) {
      this.active = false;
      this.emitError({ code: 'processing-failure', message: SPEECH_ERROR_MESSAGES['processing-failure'], cause: error });
    }
  }

  stop(): void {
    const transcriber = this.transcriber;
    this.transcriber = null;
    this.active = false;
    if (!transcriber) {
      return;
    }

    transcriber.stopTranscribingAsync(
      () => transcriber.close(),
      () => transcriber.close(),
    );
  }

  setLanguage(language: string): void {
    this.language = language;
    this.speechConfig.speechRecognitionLanguage = language;
  }

  setCallbacks(callbacks: SpeechEngineCallbacks): void {
    this.callbacks = callbacks;
    this.callbacks.onAvailabilityChange?.({ available: true });
  }

  isActive(): boolean {
    return this.active;
  }

  private toSpeakerLabel(speakerId?: string): string | undefined {
    if (!speakerId || speakerId === 'Unknown') {
      return 'Uncertain speaker';
    }

    const existing = this.speakerNames.get(speakerId);
    if (existing) {
      return existing;
    }

    const label = `Person ${this.speakerNames.size + 1}`;
    this.speakerNames.set(speakerId, label);
    return label;
  }

  private emitError(error: SpeechErrorState): void {
    this.callbacks.onError?.(error);
  }
}
