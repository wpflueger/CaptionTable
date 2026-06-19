import {
  MAX_ENROLLMENT_SECONDS,
  VoiceEnrollment,
  repeatVoiceEnrollment,
} from '../voice';

export type OnboardingStepId = 'language' | 'microphone' | 'text-size' | 'voice-setup';
export type TextSize = 'small' | 'medium' | 'large' | 'extra-large';

export interface OnboardingState {
  language?: string;
  microphonePermission: PermissionState | 'prompt';
  textSize: TextSize;
  voiceEnrollment?: VoiceEnrollment;
  voiceSetupSkipped: boolean;
  completedStepIds: OnboardingStepId[];
}

export const ONBOARDING_STEPS: ReadonlyArray<{ id: OnboardingStepId; title: string; skippable?: boolean }> = [
  { id: 'language', title: 'Choose your language' },
  { id: 'microphone', title: 'Allow microphone access' },
  { id: 'text-size', title: 'Choose text size' },
  { id: 'voice-setup', title: 'Set up your voice', skippable: true },
];

export const DEFAULT_ONBOARDING_STATE: OnboardingState = {
  microphonePermission: 'prompt',
  textSize: 'medium',
  voiceSetupSkipped: false,
  completedStepIds: [],
};

export function completeLanguageStep(state: OnboardingState, language: string): OnboardingState {
  return completeStep({ ...state, language }, 'language');
}

export function completeMicrophoneStep(
  state: OnboardingState,
  microphonePermission: PermissionState | 'prompt',
): OnboardingState {
  return completeStep({ ...state, microphonePermission }, 'microphone');
}

export function completeTextSizeStep(state: OnboardingState, textSize: TextSize): OnboardingState {
  return completeStep({ ...state, textSize }, 'text-size');
}

export function skipVoiceSetup(state: OnboardingState): OnboardingState {
  return completeStep({ ...state, voiceSetupSkipped: true, voiceEnrollment: undefined }, 'voice-setup');
}

export function completeVoiceSetup(
  state: OnboardingState,
  samples: Float32Array[],
  durationSeconds: number,
  storage: Storage = localStorage,
): OnboardingState {
  const enrollment = repeatVoiceEnrollment(samples, Math.min(durationSeconds, MAX_ENROLLMENT_SECONDS), storage);
  return completeStep({ ...state, voiceEnrollment: enrollment, voiceSetupSkipped: false }, 'voice-setup');
}

function completeStep(state: OnboardingState, stepId: OnboardingStepId): OnboardingState {
  return {
    ...state,
    completedStepIds: state.completedStepIds.includes(stepId)
      ? state.completedStepIds
      : [...state.completedStepIds, stepId],
  };
}
