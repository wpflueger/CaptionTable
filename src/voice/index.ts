export type SpeakerLabel = 'You' | 'Uncertain speaker' | string;

export interface VoiceEnrollment {
  id: string;
  createdAt: string;
  durationSeconds: number;
  sampleCount: number;
  representation: number[];
}

export interface VoiceMatchResult {
  label: 'You' | 'Uncertain speaker';
  confidence: number;
}

export const MAX_ENROLLMENT_SECONDS = 60;
export const CONSERVATIVE_YOU_THRESHOLD = 0.86;
export const VOICE_ENROLLMENT_STORAGE_KEY = 'captiontable.voiceEnrollment.v1';

const VECTOR_SIZE = 16;

export function clampEnrollmentSeconds(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return 0;
  }

  return Math.min(seconds, MAX_ENROLLMENT_SECONDS);
}

export function deriveLocalVoiceRepresentation(samples: Float32Array[]): number[] {
  const buckets = new Array<number>(VECTOR_SIZE).fill(0);
  const counts = new Array<number>(VECTOR_SIZE).fill(0);

  samples.forEach((sample) => {
    sample.forEach((value, index) => {
      const bucket = index % VECTOR_SIZE;
      buckets[bucket] += Math.abs(value);
      counts[bucket] += 1;
    });
  });

  const averaged = buckets.map((total, index) => (counts[index] === 0 ? 0 : total / counts[index]));
  const magnitude = Math.hypot(...averaged) || 1;

  return averaged.map((value) => Number((value / magnitude).toFixed(6)));
}

export function createVoiceEnrollment(samples: Float32Array[], durationSeconds: number): VoiceEnrollment {
  const limitedDuration = clampEnrollmentSeconds(durationSeconds);

  return {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    durationSeconds: limitedDuration,
    sampleCount: samples.length,
    representation: deriveLocalVoiceRepresentation(samples),
  };
}

export function saveVoiceEnrollment(enrollment: VoiceEnrollment, storage: Storage = localStorage): void {
  storage.setItem(VOICE_ENROLLMENT_STORAGE_KEY, JSON.stringify(enrollment));
}

export function loadVoiceEnrollment(storage: Storage = localStorage): VoiceEnrollment | null {
  const serialized = storage.getItem(VOICE_ENROLLMENT_STORAGE_KEY);
  return serialized ? (JSON.parse(serialized) as VoiceEnrollment) : null;
}

export function deleteVoiceEnrollment(storage: Storage = localStorage): void {
  storage.removeItem(VOICE_ENROLLMENT_STORAGE_KEY);
}

export function repeatVoiceEnrollment(
  samples: Float32Array[],
  durationSeconds: number,
  storage: Storage = localStorage,
): VoiceEnrollment {
  const enrollment = createVoiceEnrollment(samples, durationSeconds);
  saveVoiceEnrollment(enrollment, storage);
  return enrollment;
}

export function compareVoiceToEnrollment(
  samples: Float32Array[],
  enrollment: VoiceEnrollment | null,
  threshold = CONSERVATIVE_YOU_THRESHOLD,
): VoiceMatchResult {
  if (!enrollment) {
    return { label: 'Uncertain speaker', confidence: 0 };
  }

  const candidate = deriveLocalVoiceRepresentation(samples);
  const dotProduct = candidate.reduce((sum, value, index) => sum + value * (enrollment.representation[index] ?? 0), 0);
  const confidence = Math.max(0, Math.min(1, Number(dotProduct.toFixed(4))));

  return confidence >= threshold
    ? { label: 'You', confidence }
    : { label: 'Uncertain speaker', confidence };
}
