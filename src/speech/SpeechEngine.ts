export type SpeechErrorCode =
  | 'microphone-permission'
  | 'transcription-unavailable'
  | 'connectivity-loss'
  | 'processing-failure';

export interface SpeechErrorState {
  code: SpeechErrorCode;
  message: string;
  cause?: unknown;
}

export interface SpeechAvailability {
  available: boolean;
  message?: string;
}

export interface SpeechEngineCallbacks {
  onInterimText?: (text: string) => void;
  onFinalText?: (text: string) => void;
  onError?: (error: SpeechErrorState) => void;
  onAvailabilityChange?: (availability: SpeechAvailability) => void;
}

export interface SpeechEngine {
  start(): void;
  stop(): void;
  setLanguage(language: string): void;
  setCallbacks(callbacks: SpeechEngineCallbacks): void;
  isActive(): boolean;
}

export const SPEECH_ERROR_MESSAGES: Record<SpeechErrorCode, string> = {
  'microphone-permission': 'Microphone access was blocked. Allow microphone permission and try again.',
  'transcription-unavailable': 'Speech transcription is not available in this browser.',
  'connectivity-loss': 'Speech transcription lost its network connection. Check your connection and try again.',
  'processing-failure': 'Speech transcription could not process the audio. Please try again.',
};
