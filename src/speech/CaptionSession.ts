import { SpeechEngine, SpeechErrorState } from './SpeechEngine';

export interface CaptionLine {
  id: number;
  text: string;
  finalized: boolean;
  speakerLabel?: string;
}

export interface CaptionSessionState {
  active: boolean;
  captions: CaptionLine[];
  error: SpeechErrorState | null;
  available: boolean;
  availabilityMessage: string | null;
}

export type CaptionSessionListener = (state: CaptionSessionState) => void;

export class CaptionSession {
  private readonly engine: SpeechEngine;
  private readonly listeners = new Set<CaptionSessionListener>();
  private finalizedCaptions: CaptionLine[] = [];
  private interimCaption: CaptionLine | null = null;
  private nextCaptionId = 1;
  private state: CaptionSessionState = {
    active: false,
    captions: [],
    error: null,
    available: true,
    availabilityMessage: null,
  };

  constructor(engine: SpeechEngine) {
    this.engine = engine;
    this.engine.setCallbacks({
      onInterimText: (text, speakerLabel) => this.setInterimText(text, speakerLabel),
      onFinalText: (text, speakerLabel) => this.addFinalText(text, speakerLabel),
      onError: (error) => this.setError(error),
      onAvailabilityChange: (availability) => {
        this.state = {
          ...this.state,
          available: availability.available,
          availabilityMessage: availability.message ?? null,
          error: availability.available ? null : this.state.error,
        };
        this.emit();
      },
      onActiveChange: (active) => {
        this.state = { ...this.state, active, error: active ? null : this.state.error };
        this.emit();
      },
    });
  }

  start(): void {
    this.clearSessionState();
    this.engine.start();
    this.state = { ...this.state, active: this.engine.isActive(), error: this.engine.isActive() ? null : this.state.error };
    this.emit();
  }

  stop(): void {
    this.engine.stop();
    this.clearSessionState();
    this.emit();
  }

  setLanguage(language: string): void {
    this.engine.setLanguage(language);
  }

  subscribe(listener: CaptionSessionListener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  getState(): CaptionSessionState {
    return {
      ...this.state,
      captions: [...this.state.captions],
    };
  }

  private setInterimText(text: string, speakerLabel?: string): void {
    if (!this.state.active) {
      return;
    }

    this.interimCaption = text
      ? { id: this.interimCaption?.id ?? this.nextCaptionId++, text, finalized: false, speakerLabel }
      : null;
    this.publishCaptions();
  }

  private addFinalText(text: string, speakerLabel?: string): void {
    if (!this.state.active || !text) {
      return;
    }

    const id = this.interimCaption?.id ?? this.nextCaptionId++;
    this.finalizedCaptions = [...this.finalizedCaptions, { id, text, finalized: true, speakerLabel: speakerLabel ?? this.interimCaption?.speakerLabel }];
    this.interimCaption = null;
    this.publishCaptions();
  }

  private setError(error: SpeechErrorState): void {
    this.state = { ...this.state, error };
    this.emit();
  }

  private publishCaptions(): void {
    this.state = {
      ...this.state,
      captions: this.interimCaption
        ? [...this.finalizedCaptions, this.interimCaption]
        : [...this.finalizedCaptions],
    };
    this.emit();
  }

  private clearSessionState(): void {
    this.finalizedCaptions = [];
    this.interimCaption = null;
    this.nextCaptionId = 1;
    this.state = {
      ...this.state,
      active: false,
      captions: [],
      error: null,
    };
  }

  private emit(): void {
    const state = this.getState();
    this.listeners.forEach((listener) => listener(state));
  }
}
