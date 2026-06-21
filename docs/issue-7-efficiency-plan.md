# Issue #7 Efficiency Remediation Plan

GitHub issue: [#7 Efficiency review: reduce Deepgram streaming cost, audio CPU, and UI render churn](https://github.com/wpflueger/CaptionTable/issues/7)

## Goal

Make CaptionTable viable for long-running, set-and-forget conversations by reducing unnecessary Deepgram traffic, browser audio CPU, battery usage, and React render churn while preserving the proven Deepgram diarization behavior.

## Non-goals

- Do not reintroduce manual speaker picking.
- Do not reintroduce browser Web Speech fallback.
- Do not remove the real Deepgram UI E2E proof.
- Do not weaken automatic speaker diarization requirements.
- Do not ship long-lived provider credentials as a production solution.

## Current problems to address

1. Audio diagnostics emit on every PCM chunk and cause frequent React updates.
2. Mic meter and Deepgram streaming use separate Web Audio graphs.
3. The app streams raw PCM continuously, including silence.
4. Stream ownership is unclear between `App` and `DeepgramNovaSpeechEngine`.
5. `ScriptProcessorNode` is deprecated and runs audio work on the main thread.
6. Transcript rendering is unbounded and can become expensive over long sessions.
7. The dev-only E2E fixture path lives in the main app component.

## Implementation status

This PR implements the issue #7 plan end-to-end:

- [x] Baseline E2E metrics remain reported by `npm run test:e2e:deepgram-ui`.
- [x] Audio diagnostics are throttled and final stats flush on close/stop.
- [x] Caption-only subscribers are split from diagnostics/session-state subscribers.
- [x] Media stream/audio source ownership is explicit.
- [x] Mic meter and Deepgram sender share a single `AudioPipeline`.
- [x] Local VAD/silence gating waits for speech, pauses Deepgram after sustained silence, and reconnects on resumed speech.
- [x] `AudioWorkletNode` is the primary live microphone processing path, with `ScriptProcessorNode` kept only as a fallback.
- [x] Transcript rendering is windowed to the latest 500 turns while retaining full session transcript state.
- [x] Dev-only E2E fixture query parsing moved out of `App.tsx` into `src/appConfig.ts`.
- [x] `npm test`, `npm run build`, `npm run test:deepgram:ami`, and `npm run test:e2e:deepgram-ui` pass after implementation.

## Guiding principles

- Preserve current passing behavior before optimizing.
- Ship changes in small PRs, each with tests.
- Keep `npm test`, `npm run build`, `npm run test:deepgram:ami`, and `npm run test:e2e:deepgram-ui` green after each phase.
- Prefer measurable improvements over speculative rewrites.
- Optimize the hot path first: audio callback -> Deepgram send -> React state updates.

## Phase 0 — Baseline metrics and guardrails

### Tasks

- Add lightweight counters for:
  - audio chunks sent per second
  - bytes sent per second
  - diagnostics state updates per second
  - transcript card count
- Add a scripted benchmark mode using the existing AMI E2E fixture.
- Record baseline output in docs or test snapshots.

### Acceptance criteria

- `npm run test:e2e:deepgram-ui` reports audio chunks, KB sent, transcript card count, and detected speaker count.
- Baseline numbers are documented before optimization work begins.
- No functional behavior changes.

## Phase 1 — Throttle diagnostics and reduce render churn

### Root cause

`DeepgramNovaSpeechEngine` calls `onAudioSend` for every PCM chunk. `CaptionSession` updates state and emits on every call, forcing the React app to rerender for diagnostics only.

### Tasks

- Keep internal chunk/byte counters in the engine.
- Throttle `onAudioSend` notifications to at most once every 500ms, configurable.
- Optionally throttle status messages that are derived from chunk counts.
- Add unit tests using fake timers to verify throttling.
- Ensure final stats flush on stop/close.

### Acceptance criteria

- Audio-send UI updates occur no more than 2 times per second in tests.
- Transcript rendering tests continue to pass.
- E2E still proves audio reaches Deepgram and transcript renders.

### Expected impact

- Major reduction in React rerenders.
- No change to Deepgram behavior.
- Low implementation risk.

## Phase 2 — Split diagnostics state from transcript state

### Root cause

`CaptionSessionState` currently combines high-frequency diagnostics and transcript data. Any diagnostics update notifies the same listener that renders transcript UI.

### Tasks

- Split session state into separate subscriptions:
  - transcript/caption state
  - connection/status/audio stats state
- Or introduce selectors so subscribers only receive relevant state changes.
- Update `App` to render diagnostics and transcript independently.
- Add tests that diagnostics changes do not rerender transcript cards.

### Acceptance criteria

- Audio stats updates do not remap transcript card list.
- Unit test verifies transcript component render count is unchanged during diagnostics-only updates.
- UI behavior remains unchanged.

## Phase 3 — Clarify stream ownership and cleanup

### Root cause

`App` creates a microphone stream for the meter and passes it to `DeepgramNovaSpeechEngine`. Both layers can stop tracks.

### Tasks

- Introduce explicit stream ownership semantics:
  - `setMediaStream(stream, { ownsStream: false })`, or
  - move all media acquisition into a single audio pipeline object.
- Ensure only the owner stops tracks.
- Add tests for cleanup behavior.
- Update docs with ownership model.

### Acceptance criteria

- No double-stopping assumptions.
- Tests prove externally provided streams are not stopped by the engine unless ownership is explicitly transferred.
- Stop still closes Deepgram WebSocket and audio nodes.

## Phase 4 — Single audio pipeline for meter and sender

### Root cause

The current app creates one `AudioContext` for the meter and another for Deepgram PCM streaming.

### Target design

Create a shared `AudioPipeline` abstraction:

```ts
interface AudioPipeline {
  start(): Promise<void>;
  stop(): Promise<void>;
  subscribeLevel(listener: (level: number) => void): () => void;
  subscribePcm(listener: (pcm: ArrayBuffer) => void): () => void;
}
```

### Tasks

- Create `src/audio/AudioPipeline.ts`.
- Use one `MediaStream` and one `AudioContext`.
- Feed both:
  - mic level diagnostics
  - Deepgram PCM sender
- Remove duplicate analyser/source setup from `App` and `DeepgramNovaSpeechEngine`.
- Add unit tests with fake audio pipeline.

### Acceptance criteria

- One `getUserMedia` call per session.
- One `AudioContext` per session.
- Mic meter continues working.
- Deepgram E2E continues passing.

### Expected impact

- Lower CPU usage.
- Cleaner lifecycle.
- Easier VAD implementation.

## Phase 5 — Add local VAD/silence gating to reduce Deepgram usage

### Root cause

The app sends audio continuously after Start, including silence.

### Proposed behavior

- Keep local mic monitoring active while the session is active.
- Open Deepgram when speech is detected.
- Keep Deepgram open through normal pauses.
- Close Deepgram after sustained silence, e.g. 60 seconds.
- Reopen Deepgram on resumed speech.

### Open product question

Deepgram speaker numbering can reset across reconnects. We need to decide whether that is acceptable after a long idle period, or whether the UI should mark a new segment/session.

### Tasks

- Add configurable VAD thresholds:
  - speech start threshold
  - silence timeout
  - minimum open duration
- Add state messages:
  - `Waiting for speech`
  - `Speech detected; connecting to Deepgram`
  - `Paused Deepgram after silence`
- Preserve transcript across reconnects.
- Add tests for:
  - silence does not open Deepgram
  - speech opens Deepgram
  - sustained silence closes Deepgram
  - resumed speech reconnects
- Add E2E fixture test with speech/silence/speech pattern.

### Acceptance criteria

- Deepgram is not connected indefinitely during long silence.
- Speech after idle resumes transcription.
- E2E passes.
- Behavior is documented.

## Phase 6 — Replace `ScriptProcessorNode` with `AudioWorkletNode`

### Root cause

`ScriptProcessorNode` is deprecated and runs audio processing on the main thread.

### Tasks

- Add an AudioWorklet processor for PCM conversion/downsampling/chunking.
- Use message passing from worklet to main thread for encoded chunks.
- Keep `ScriptProcessorNode` only as a documented fallback if necessary.
- Add browser capability detection.
- Add tests around processor message protocol.

### Acceptance criteria

- Primary path uses `AudioWorkletNode`.
- No deprecation warning in Chrome for normal path.
- E2E passes.

## Phase 7 — Transcript virtualization/windowing

### Root cause

The transcript list renders every caption card on every transcript update.

### Tasks

- Introduce a transcript list component.
- Use simple windowing or `react-window`.
- Keep full transcript data available for export/copy.
- Add a long-session test with 1,000+ turns.

### Acceptance criteria

- UI remains responsive with 1,000+ transcript turns.
- Transcript auto-scroll still works.
- E2E and unit tests pass.

## Phase 8 — Move E2E fixture wiring out of main app path

### Root cause

The dev-only `?e2eAudio=` fixture wiring is guarded by `import.meta.env.DEV`, but it still lives in `App.tsx`.

### Tasks

- Move fixture configuration into a dedicated test harness module or dev-only wrapper.
- Keep production app component free of test-fixture concepts.
- Ensure `npm run test:e2e:deepgram-ui` still passes.

### Acceptance criteria

- `App.tsx` no longer parses `e2eAudio` directly.
- E2E remains deterministic.
- Production bundle is unaffected.

## Implemented PR breakdown

The original recommended breakdown was collapsed into this PR at the user's request to keep implementing until all items were complete:

1. **Done:** Baseline metrics + diagnostics throttling.
2. **Done:** Split diagnostics vs transcript subscriptions.
3. **Done:** Stream ownership cleanup.
4. **Done:** Shared audio pipeline.
5. **Done:** Silence/VAD gating.
6. **Done:** AudioWorklet migration with fallback.
7. **Done:** Transcript rendering window.
8. **Done:** Move E2E fixture wiring out of main app.

## Required test matrix for each implementation PR

Run these before merge:

```bash
npm test
npm run build
npm run test:deepgram:ami
npm run test:e2e:deepgram-ui
```

For phases that alter live audio behavior, also perform a manual Chrome mic smoke test and capture:

- Deepgram status
- mic level
- audio chunks/KB
- at least one transcript turn
- at least two speakers when using multi-speaker fixture

## Remaining risks / known tradeoffs

- VAD reconnects may reset Deepgram speaker numbering after long idle periods.
- The app may clip the first word after a long idle pause if speech begins before the Deepgram reconnect is ready.
- `ScriptProcessorNode` remains as an explicit fallback for browsers where `AudioWorkletNode` setup fails.
- Physical microphone behavior still depends on browser/OS/hardware permissions and selected input device.

## Success definition

Issue #7 can be closed when:

- [x] diagnostics updates are throttled
- [x] duplicate audio graph is removed
- [x] stream ownership is explicit
- [x] long silence no longer keeps Deepgram streaming indefinitely
- [x] audio processing no longer relies primarily on deprecated `ScriptProcessorNode`
- [x] transcript rendering scales to long sessions
- [x] real Deepgram UI E2E still passes
