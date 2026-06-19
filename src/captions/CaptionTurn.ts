export type SpeakerKind = 'self' | 'participant' | 'uncertain';

export interface CaptionTurn {
  id: string;
  speakerLabel: 'You' | 'Person 1' | 'Person 2' | 'Person 3' | 'Uncertain speaker';
  speakerKind: SpeakerKind;
  text: string;
  isInterim: boolean;
  confidence: number;
  createdAt: Date;
}

export interface CaptionTurnInput {
  id?: string;
  speakerId?: string;
  isSelf?: boolean;
  text: string;
  isInterim?: boolean;
  confidence?: number;
  createdAt?: Date;
}

export const LOW_CONFIDENCE_SPEAKER_THRESHOLD = 0.55;

const PERSON_LABELS = ['Person 1', 'Person 2', 'Person 3'] as const;

export function createCaptionTurn(
  input: CaptionTurnInput,
  speakerLabels: ReadonlyMap<string, CaptionTurn['speakerLabel']>,
): CaptionTurn {
  const confidence = input.confidence ?? 1;
  const isUncertain = confidence < LOW_CONFIDENCE_SPEAKER_THRESHOLD;
  const speakerLabel = isUncertain
    ? 'Uncertain speaker'
    : input.isSelf
      ? 'You'
      : input.speakerId
        ? (speakerLabels.get(input.speakerId) ?? 'Person 1')
        : 'Person 1';

  return {
    id: input.id ?? makeTurnId(),
    speakerLabel,
    speakerKind: isUncertain ? 'uncertain' : input.isSelf ? 'self' : 'participant',
    text: input.text,
    isInterim: input.isInterim ?? false,
    confidence,
    createdAt: input.createdAt ?? new Date(),
  };
}

export function assignStableSpeakerLabel(
  speakerId: string,
  existingLabels: ReadonlyMap<string, CaptionTurn['speakerLabel']>,
): CaptionTurn['speakerLabel'] {
  const existing = existingLabels.get(speakerId);
  if (existing) return existing;

  const used = new Set(existingLabels.values());
  return PERSON_LABELS.find((label) => !used.has(label)) ?? PERSON_LABELS[PERSON_LABELS.length - 1];
}

function makeTurnId(): string {
  return `caption-turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
