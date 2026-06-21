# Testing CaptionTable

This document describes the current test coverage and the automated end-to-end proof for the Deepgram Nova speaker diarization flow.

## Test commands

```bash
npm test
npm run build
npm run test:deepgram:ami
npm run test:e2e:audio-pipeline
npm run test:e2e:deepgram-ui
```

## Unit tests

Run:

```bash
npm test
```

Current unit tests cover:

### `CaptionSession`

File: `src/speech/CaptionSession.test.ts`

Verifies:

- interim captions are stored
- finalized captions replace/complete interim captions
- speaker labels from the speech engine are preserved
- multiple speakers can appear in the transcript
- transcript state clears on stop
- diagnostics-only audio stats do not notify caption-only subscribers

### `DeepgramNovaSpeechEngine`

File: `src/speech/DeepgramNovaSpeechEngine.test.ts`

Verifies:

- Deepgram URL includes Nova model settings
- `diarize=true` is included
- `interim_results=true` is included
- PCM streaming settings are included:
  - `encoding=linear16`
  - `sample_rate=...`
- token auth protocol is sent
- Web Audio PCM buffers are sent through the WebSocket
- audio send stats increment and are throttled
- Deepgram `speaker` IDs map to `Person N`
- multi-speaker Deepgram word results are split into separate transcript turns
- shared media stream avoids a second `getUserMedia` call
- provided streams are only stopped when ownership is explicit
- local VAD/silence gating waits for speech before connecting Deepgram
- pre-roll PCM captured before WebSocket open is sent after connect
- sustained silence closes Deepgram and resumed speech reconnects
- stale socket close events are ignored after reconnect
- rapid repeated VAD speech events produce only one connecting socket
- stop cleans up PCM nodes, keepalive, socket, and active state

### `App`

File: `src/App.test.tsx`

Verifies:

- Deepgram automatic speaker identification readiness appears
- Start is enabled when `VITE_DEEPGRAM_API_KEY` is present
- Start is disabled when `VITE_DEEPGRAM_API_KEY` is missing
- active caption UI appears after start
- full speaker transcript panel appears
- old `Recent finalized captions` panel does not appear
- automatic speaker labels appear in the active caption and transcript
- long transcript rendering starts with the latest 500 turns
- older transcript turns remain accessible through the Load earlier turns history control
- fatal Deepgram errors stop the App-owned local microphone pipeline

## Build test

Run:

```bash
npm run build
```

This validates TypeScript build references and the Vite production bundle.

## Browser-level AudioPipeline / AudioWorklet check

Run:

```bash
npm run test:e2e:audio-pipeline
```

This launches Chrome with fake media devices, imports the real Vite-served `BrowserAudioPipeline`, starts the live microphone pipeline, and fails unless:

- Chrome uses the `AudioWorkletNode` path
- mic level messages are emitted
- PCM chunks are emitted
- the pipeline stops cleanly

This complements the Deepgram UI fixture E2E, which intentionally bypasses the live microphone path.

## AMI prerecorded Deepgram integration check

Run:

```bash
npm run test:deepgram:ami
```

This is a real Deepgram API check, not a mock.

It:

1. Downloads public AMI Meeting Corpus audio:
   - `ES2002a.Mix-Headset.wav`
2. Creates a WAV clip under `.cache/test-audio/`.
3. Sends the WAV to Deepgram Nova prerecorded API with:
   - `model=nova-3`
   - `diarize=true`
   - `smart_format=true`
   - `punctuate=true`
4. Fails unless Deepgram returns:
   - non-empty transcript
   - at least two detected speakers

Default segment:

```text
offset: 180 seconds
duration: 90 seconds
```

Override:

```bash
AMI_CLIP_OFFSET_SECONDS=540 AMI_CLIP_SECONDS=120 npm run test:deepgram:ami
```

## Real UI + Deepgram E2E proof

Run:

```bash
npm run test:e2e:deepgram-ui
```

This is the strongest automated proof currently in the repo.

It:

1. Downloads/caches public AMI meeting audio.
2. Creates a deterministic WAV fixture.
3. Starts the real Vite app.
4. Launches Chrome via the Chrome DevTools Protocol.
5. Loads the actual CaptionTable UI.
6. Clicks **Start Captions** using real CDP mouse input.
7. Streams the AMI WAV fixture through the same `DeepgramNovaSpeechEngine` WebSocket path used by the app.
8. Waits for the UI transcript to update.
9. Fails unless:
   - the full transcript panel appears
   - the old picker/fallback UI is absent
   - audio chunks are sent to Deepgram
   - transcript cards render in the UI
   - at least two automatic speaker labels appear

The E2E path uses a dev-only query parameter:

```text
?e2eAudio=/__e2e-ami.wav
```

That parameter is only wired in development mode through `src/appConfig.ts` via `import.meta.env.DEV`; the main `App.tsx` component no longer parses the fixture query parameter directly. It is not intended for production.

Example passing result:

```json
{
  "ok": true,
  "finalState": {
    "cardCount": 7,
    "speakers": ["Person 1", "Person 2"],
    "hasTranscriptPanel": true,
    "hasPicker": false,
    "audioChunks": 283,
    "audioKb": 884
  }
}
```

## What is still not fully automated

The automated UI E2E proves:

- app UI loads
- Start works
- app streams audio to real Deepgram
- Deepgram returns diarized transcript
- UI renders speaker-labeled transcript cards

It does **not** prove every physical microphone works on every machine. Physical microphone capture depends on:

- browser permission
- OS microphone privacy settings
- selected input device
- input gain/volume
- hardware behavior
- browser Web Audio behavior

The UI diagnostics exist to troubleshoot physical microphone sessions:

- mic level
- audio chunks sent
- bytes sent
- Deepgram status
- local VAD waiting/paused/connecting state

Physical mic sessions now use local silence gating. Deepgram does not connect until speech crosses the local threshold, uses a short local pre-roll buffer to reduce first-word clipping, closes after sustained silence, and reconnects when speech resumes. This reduces idle streaming but can reset Deepgram speaker numbering across long idle reconnects; the UI status warns when this happens.

## Security note for tests

The Deepgram integration/E2E tests require a real API key from `.env.local`:

```bash
VITE_DEEPGRAM_API_KEY=...
```

Do not commit `.env.local`. The repo ignores `*.local`.
