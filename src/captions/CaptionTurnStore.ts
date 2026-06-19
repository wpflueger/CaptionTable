import {
  CaptionTurn,
  CaptionTurnInput,
  assignStableSpeakerLabel,
  createCaptionTurn,
} from './CaptionTurn';

export interface CaptionTurnStoreSnapshot {
  finalizedTurns: CaptionTurn[];
  activeTurn: CaptionTurn | null;
}

export interface CaptionTurnStoreOptions {
  maxFinalizedTurns?: number;
}

type Listener = (snapshot: CaptionTurnStoreSnapshot) => void;

export class CaptionTurnStore {
  private readonly maxFinalizedTurns: number;
  private readonly speakerLabels = new Map<string, CaptionTurn['speakerLabel']>();
  private readonly finalizedTurns: CaptionTurn[] = [];
  private listeners = new Set<Listener>();
  private activeTurn: CaptionTurn | null = null;

  constructor(options: CaptionTurnStoreOptions = {}) {
    this.maxFinalizedTurns = options.maxFinalizedTurns ?? 50;
  }

  getSnapshot(): CaptionTurnStoreSnapshot {
    return {
      finalizedTurns: [...this.finalizedTurns],
      activeTurn: this.activeTurn,
    };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  upsertInterimTurn(input: CaptionTurnInput): CaptionTurn {
    const turn = this.createTurn({ ...input, isInterim: true });
    this.activeTurn = turn;
    this.emit();
    return turn;
  }

  finalizeTurn(input?: CaptionTurnInput): CaptionTurn | null {
    const source = input ? this.createTurn({ ...input, isInterim: false }) : this.activeTurn;
    if (!source) return null;

    const finalized = { ...source, isInterim: false };
    this.activeTurn = null;
    this.finalizedTurns.push(finalized);

    while (this.finalizedTurns.length > this.maxFinalizedTurns) {
      this.finalizedTurns.shift();
    }

    this.emit();
    return finalized;
  }

  stop(): void {
    this.activeTurn = null;
    this.finalizedTurns.length = 0;
    this.speakerLabels.clear();
    this.emit();
  }

  private createTurn(input: CaptionTurnInput): CaptionTurn {
    if (input.speakerId && !input.isSelf) {
      this.speakerLabels.set(input.speakerId, assignStableSpeakerLabel(input.speakerId, this.speakerLabels));
    }

    return createCaptionTurn(input, this.speakerLabels);
  }

  private emit(): void {
    const snapshot = this.getSnapshot();
    this.listeners.forEach((listener) => listener(snapshot));
  }
}
