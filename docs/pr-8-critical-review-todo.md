# PR #8 Critical Review TODO

PR: [#8 Complete issue #7 efficiency remediation](https://github.com/wpflueger/CaptionTable/pull/8)

Issue: [#7 Efficiency review: reduce Deepgram streaming cost, audio CPU, and UI render churn](https://github.com/wpflueger/CaptionTable/issues/7)

This file tracks the findings from the post-implementation critical review of PR #8. The PR is directionally correct, but should not be considered complete until the blocking items below are resolved or explicitly deferred with documented rationale.

## Review verdict

**Resolved in follow-up implementation.** The checklist below records the critical-review items and their implemented resolutions.

The PR improves diagnostics throttling, ownership semantics, a shared audio pipeline, AudioWorklet support, local VAD/silence gating, and transcript render-windowing. The follow-up implementation addressed the review gaps with:

- fatal Deepgram failure cleanup of App-owned audio resources
- VAD pre-roll buffering
- explicit transcript history loading for older turns
- no full transcript array clone in `CaptionSession.getState()`
- WebSocket identity guards
- partial audio-pipeline start cleanup
- Deepgram-first Stop ordering
- browser-level AudioWorklet/live audio pipeline proof
- formalized optional audio source methods on `SpeechEngine`
- race-safe VAD connection state
- reconnect speaker-label warning status
- reduced chunk-count status churn

## Blocking items before merge

### 1. Stop app-owned mic/audio pipeline after Deepgram fatal error or unexpected close

- [x] Add cleanup path when `DeepgramNovaSpeechEngine` emits a fatal `onerror` or unexpected `onclose`.
- [x] Ensure App-owned `BrowserAudioPipeline` is stopped when the caption session becomes inactive because of engine failure.
- [x] Ensure wake/session lifecycle is also stopped or moved to an explicit retryable state.
- [x] Prevent UI from returning to the start screen while the microphone remains active invisibly.
- [x] Add tests for Deepgram `onerror` cleanup.
- [x] Add tests for unexpected Deepgram `onclose` cleanup.

Affected files:

- `src/App.tsx`
- `src/speech/DeepgramNovaSpeechEngine.ts`
- `src/speech/CaptionSession.ts`
- `src/App.test.tsx`
- `src/speech/DeepgramNovaSpeechEngine.test.ts`

Root cause:

`App` passes the audio source with `{ ownsSource: false }`, so the engine cannot stop it. On fatal engine failure, the engine only flips active state and emits errors; app-level audio pipeline cleanup is not guaranteed.

---

### 2. Add VAD pre-roll buffering to avoid clipping first words

- [x] Add a bounded local PCM ring buffer, likely 1-2 seconds.
- [x] Buffer PCM while local VAD is waiting for speech and Deepgram is disconnected.
- [x] On Deepgram WebSocket open, send pre-roll before subscribing/sending live PCM.
- [x] Cap memory usage and reset buffer after successful send/stop.
- [x] Add unit test proving PCM captured before WebSocket open is sent after connection.
- [x] Document the behavior and remaining reconnect-latency caveat.

Affected files:

- `src/audio/AudioPipeline.ts`
- `src/speech/DeepgramNovaSpeechEngine.ts`
- `src/speech/DeepgramNovaSpeechEngine.test.ts`
- `README.md`
- `docs/testing.md`

Root cause:

Current VAD behavior waits to open Deepgram until local speech is detected. PCM is subscribed to only after the WebSocket opens, so speech during connection setup is discarded.

---

### 3. Replace hard transcript truncation with real full-history access

- [x] Do not silently hide transcript turns older than the latest 500.
- [x] Implement real virtualization/windowing that preserves access to all turns, or add explicit pagination/load-earlier/export behavior.
- [x] Keep the product promise of a full scrollable speaker-labeled transcript.
- [x] Add tests proving transcript turns older than 500 remain accessible somehow.
- [x] Update docs to reflect the actual long-session behavior.

Affected files:

- `src/App.tsx`
- `src/App.test.tsx`
- `src/styles.css`
- `README.md`
- `docs/testing.md`

Root cause:

Current code does this:

```ts
const renderedCaptions = hiddenCount ? captions.slice(-TRANSCRIPT_RENDER_WINDOW) : captions;
```

That is not virtualization; it removes older transcript cards from the visible UI.

---

### 4. Stop copying full captions on diagnostics-only session updates

- [x] Split `CaptionSessionState` into separate transcript and diagnostics/connection states, or remove `captions` from diagnostics subscribers.
- [x] Ensure audio stat/status emits do not allocate `[...]` copies of the full caption array.
- [x] Add tests that diagnostics-only updates do not clone/copy transcript state.
- [x] Re-check long-session memory churn.

Affected files:

- `src/speech/CaptionSession.ts`
- `src/speech/CaptionSession.test.ts`
- `src/App.tsx`

Root cause:

`CaptionSession.getState()` still returns:

```ts
return {
  ...this.state,
  captions: [...this.state.captions],
};
```

So every diagnostics/status/audio emit can still copy the full transcript array.

---

### 5. Add WebSocket identity guards for stale socket events

- [x] Capture each WebSocket instance in a local variable inside `createSocket()`.
- [x] Guard all handlers with `if (this.socket !== socket) return;` where appropriate.
- [x] Ensure stale `onclose`, `onerror`, and `onmessage` from old sockets cannot affect the current session/socket.
- [x] Add tests for old socket close after reconnect.
- [x] Add tests for old socket error after reconnect.

Affected files:

- `src/speech/DeepgramNovaSpeechEngine.ts`
- `src/speech/DeepgramNovaSpeechEngine.test.ts`

Root cause:

`createSocket()` stores the socket in `this.socket`, and event handlers mutate shared instance state. An old socket event can clear keepalive, unsubscribe PCM, overwrite status, or set active false after a newer socket exists.

---

### 6. Clean up partial `BrowserAudioPipeline.start()` failures

- [x] Wrap `BrowserAudioPipeline.start()` setup in try/catch cleanup.
- [x] If `getUserMedia` or `AudioContext` succeeds but node/worklet setup fails, stop tracks and close context.
- [x] Make cleanup resilient if `stop()` itself throws.
- [x] Add tests for `connectProcessingNode()`/worklet setup failure cleanup.

Affected files:

- `src/audio/AudioPipeline.ts`
- new or existing audio pipeline tests

Root cause:

If setup fails after a stream/context is created, `App` catches the thrown error but the partially initialized pipeline may still own active browser resources.

---

## Major items

### 7. Close Deepgram before stopping local audio on user Stop

- [x] Change `stopCaptions()` order so `captionSession.stop()` closes Deepgram first.
- [x] Stop local `AudioPipeline` after Deepgram close is initiated.
- [x] Keep UI cleanup behavior correct.
- [x] Add test or assertion for intended stop order.

Affected files:

- `src/App.tsx`
- `src/App.test.tsx`

Current order stops local audio first, then closes the caption session/Deepgram. For cost/control, the provider stream should be closed first.

---

### 8. Add browser-level proof for the live mic/AudioWorklet path

- [x] Add an automated browser-level test for `BrowserAudioPipeline` and AudioWorklet message flow.
- [x] Prefer using Chrome fake media device/audio if feasible.
- [x] At minimum, instantiate `BrowserAudioPipeline` in browser automation and prove level/PCM messages flow.
- [x] Keep existing Deepgram fixture E2E, but do not claim it proves live mic/AudioWorklet behavior.

Affected files:

- `scripts/`
- `package.json`
- `docs/testing.md`

Root cause:

Existing UI E2E uses `?e2eAudio=` and bypasses the new live microphone architecture:

- `BrowserAudioPipeline`
- `AudioWorkletNode`
- local VAD
- pause/reconnect behavior

---

### 9. Formalize the speech engine/audio source interface

- [x] Update `SpeechEngine` or introduce a dedicated `DeepgramSpeechEngine` interface for audio source/media stream injection.
- [x] Avoid relying on concrete `DeepgramNovaSpeechEngine` methods from `App` while the rest of the app pretends to use a generic `SpeechEngine` abstraction.
- [x] Update mocks/tests accordingly.

Affected files:

- `src/speech/SpeechEngine.ts`
- `src/speech/DeepgramNovaSpeechEngine.ts`
- `src/App.tsx`
- `src/App.test.tsx`

---

### 10. Make owned audio source cleanup awaitable or race-safe

- [x] Avoid fire-and-forget owned source cleanup in `DeepgramNovaSpeechEngine.stop()`.
- [x] Consider making `SpeechEngine.stop()` async.
- [x] Or add internal stop/restart sequencing to prevent cleanup races.
- [x] Add fast stop/start regression test.

Affected files:

- `src/speech/SpeechEngine.ts`
- `src/speech/DeepgramNovaSpeechEngine.ts`
- `src/speech/CaptionSession.ts`
- tests

Current code uses:

```ts
void this.audioSource.stop();
```

---

### 11. Set `connecting` before awaits in VAD connection path

- [x] Move `this.connecting = true` before `await this.ensureAudioSource()` in `connectAudioSource()`.
- [x] Reset `connecting` in all error/abort paths.
- [x] Add test for rapid repeated level events producing only one WebSocket.

Affected files:

- `src/speech/DeepgramNovaSpeechEngine.ts`
- `src/speech/DeepgramNovaSpeechEngine.test.ts`

Root cause:

Multiple VAD level events can call `connectAudioSource()` before `connecting` is set.

---

## Medium items

### 12. Add direct AudioWorklet coverage

- [x] Add tests around the worklet message protocol.
- [x] Consider a browser-run test because Node/Vitest cannot execute real `AudioWorkletProcessor` directly.
- [x] Validate PCM byte lengths and level messages.

Affected files:

- `src/audio/pcmWorklet.js`
- `src/audio/AudioPipeline.ts`
- tests/scripts

---

### 13. Move VAD constants to named config

- [x] Replace inline constants in `App.tsx` with named config constants.
- [x] Document the defaults.
- [x] Consider exposing dev-only tuning knobs later.

Current constants:

```ts
speechThreshold: 0.025
silenceTimeoutMs: 60_000
minConnectionMs: 10_000
```

---

### 14. Handle speaker-label reset across Deepgram reconnects

- [x] Add a visible or transcript-level segment marker after silence reconnect.
- [x] Document that `Person 1` after reconnect may not map to the same physical person as before reconnect.
- [x] Consider adding an internal segment ID to transcript entries.

Affected files:

- `src/speech/DeepgramNovaSpeechEngine.ts`
- `src/speech/CaptionSession.ts`
- `src/App.tsx`
- docs/tests

---

### 15. Reduce remaining status-message churn

- [x] Revisit chunk-count-derived status messages emitted every 50 chunks.
- [x] Either remove them from production UI or throttle them separately from audio stats.
- [x] Keep diagnostics useful without producing unnecessary session state updates.

Affected file:

- `src/speech/DeepgramNovaSpeechEngine.ts`

---

## Test gaps checklist

- [x] Deepgram `onerror` releases/stops App-owned audio pipeline.
- [x] Unexpected Deepgram `onclose` releases/stops App-owned audio pipeline or enters a safe retry state.
- [x] Stale socket `onclose` cannot affect current socket/session.
- [x] Stale socket `onerror` cannot affect current socket/session.
- [x] `BrowserAudioPipeline.start()` cleans up stream/context after partial setup failure.
- [x] VAD pre-roll sends PCM captured before WebSocket open.
- [x] Older-than-500 transcript turns remain accessible in UI or via explicit history/export path.
- [x] Stop closes Deepgram before local audio teardown.
- [x] Rapid repeated VAD speech-level events produce only one WebSocket while connecting.
- [x] Browser-level AudioWorklet message flow is proven.

## Merge gate proposal

Before merging PR #8, require (now satisfied by the follow-up implementation):

- [x] All blocking items resolved.
- [x] New tests for all blocking lifecycle/race fixes.
- [x] `npm test` passes.
- [x] `npm run build` passes.
- [x] `npm run test:deepgram:ami` passes.
- [x] `npm run test:e2e:deepgram-ui` passes.
- [x] PR description updated to accurately reflect completed vs deferred items.

## Suggested implementation order

1. Socket identity guards and VAD `connecting` race fix.
2. App-owned audio pipeline cleanup on fatal Deepgram failure.
3. Stop-order fix.
4. Partial `BrowserAudioPipeline.start()` cleanup.
5. CaptionSession state split to remove full transcript copies from diagnostics emits.
6. Replace transcript hard truncation with accessible full-history strategy.
7. VAD pre-roll buffering.
8. Browser-level AudioWorklet/live mic proof.
9. Interface cleanup and remaining docs refinements.
