# CaptionTable

CaptionTable provides local-first captioning helpers.

## Onboarding and voice enrollment

The onboarding flow is intentionally short and contains four steps: language selection, microphone permission, text-size selection, and optional voice setup. Voice setup can be skipped, repeated, or deleted later from settings UI actions wired to the voice helpers.

Voice enrollment is capped at 60 seconds. Derived voice representations are designed to stay in browser-local storage by default, and can be moved to IndexedDB by passing a compatible local persistence layer. Speaker labeling uses a conservative confidence threshold before labeling a turn as `You`; otherwise, the turn is labeled `Uncertain speaker` rather than another known participant.
