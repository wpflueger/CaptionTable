# CaptionTable

CaptionTable is a responsive web app for a **set-and-forget Conversation Captioner** experience.

The current app is **Deepgram Nova only** for transcription and automatic speaker diarization. It does not include a manual speaker picker and does not include a browser Web Speech fallback in the main app.

## Current behavior

- Captures microphone audio in the browser with a single shared Web Audio pipeline.
- Uses `AudioWorkletNode` for PCM conversion/chunking when available, with a `ScriptProcessorNode` fallback for incompatible browsers.
- Keeps local mic-level monitoring active while the session is running.
- Opens the Deepgram Nova WebSocket when local speech is detected.
- Closes the Deepgram stream after sustained silence and reconnects when speech resumes.
- Requests automatic speaker diarization with `diarize=true`.
- Displays the current live caption in a large high-visibility panel.
- Displays a full speaker-labeled transcript while rendering only the latest transcript window for long-session performance.
- Labels speakers as Deepgram returns them, e.g. `Person 1`, `Person 2`.
- Disables Start if `VITE_DEEPGRAM_API_KEY` is missing.

## Requirements

- Node/npm
- Chrome recommended for local development
- Deepgram API key
- Internet access to Deepgram WebSocket/API endpoints

## Local development

```bash
npm install
cp .env.example .env.local
```

Edit `.env.local`:

```bash
VITE_DEEPGRAM_API_KEY=your_deepgram_key_here
```

Start the dev server:

```bash
npm run dev
```

Open the Vite URL, usually:

```text
http://localhost:5173
```

If you change `.env.local`, restart `npm run dev`. Vite reads env variables at startup.

## Production-style local build

```bash
npm run build
npm run preview
```

## App architecture

### Main UI

- `src/App.tsx`
  - Start screen
  - Deepgram readiness state
  - active caption screen
  - memoized Deepgram diagnostics
  - windowed full speaker transcript panel
  - microphone status
- `src/appConfig.ts`
  - environment-derived app config
  - dev-only E2E audio fixture query parsing

### Audio/speech/session layer

- `src/audio/AudioPipeline.ts`
  - single shared browser microphone pipeline
  - one `MediaStream` and one `AudioContext` per active mic session
  - mic-level subscriptions for UI/lifecycle/VAD
  - PCM subscriptions for Deepgram streaming
  - `AudioWorkletNode` primary processing path with `ScriptProcessorNode` fallback
- `src/audio/pcmWorklet.js`
  - AudioWorklet processor for level metering and 16-bit PCM chunking
- `src/speech/DeepgramNovaSpeechEngine.ts`
  - Deepgram Nova WebSocket connection
  - `diarize=true`
  - shared audio pipeline PCM streaming path
  - local VAD/silence gating for Deepgram connect/pause/reconnect
  - dev-only E2E WAV fixture streaming path
  - Deepgram result parsing
  - speaker turn splitting by consecutive Deepgram `word.speaker` values
- `src/speech/CaptionSession.ts`
  - active/inactive state
  - interim/final caption state
  - transcript state
  - status and audio send stats
- `src/speech/SpeechEngine.ts`
  - engine interface and callback contract
- `src/session/sessionLifecycle.ts`
  - wake lock
  - visibility/online/offline lifecycle guidance
  - low-volume/silence guidance

## Deepgram diarization behavior

Deepgram returns speaker numbers per word. The app converts those to labels:

```text
speaker: 0 -> Person 1
speaker: 1 -> Person 2
speaker: 2 -> Person 3
```

If a single Deepgram result contains multiple consecutive speaker segments, the app splits it into separate transcript turns. Example:

```text
speaker 0: "hello there"
speaker 1: "yes exactly"
```

becomes two transcript cards:

```text
Person 1: hello there
Person 2: yes exactly
```

This is diarization, not identity recognition. The app can distinguish speakers as `Person N`, but it does not know real names like “Alice” or “William”.

## Diagnostics in the UI

During an active session, the app shows:

- Deepgram status
- mic level percentage
- audio chunks sent
- audio KB sent

Useful states:

| UI status | Meaning |
|---|---|
| `Waiting for speech before connecting to Deepgram…` | local mic pipeline is active; Deepgram is not connected yet |
| `Speech detected; connecting to Deepgram…` | local VAD detected speech and is opening the WebSocket |
| `Connected to Deepgram...` | WebSocket opened successfully |
| `Audio is streaming to Deepgram...` | Audio bytes are being sent |
| `Paused Deepgram after sustained silence...` | local mic stays active, but Deepgram has been closed to avoid streaming silence |
| `Live transcript received.` | Deepgram sent interim transcript text |
| `Final transcript received.` | Deepgram sent finalized transcript text |
| `Audio sent: 0 chunks / 0 KB` | local speech has not triggered Deepgram audio streaming yet, or the browser audio path is not producing audio |

## Troubleshooting

### Start button is disabled

`VITE_DEEPGRAM_API_KEY` is missing or Vite was started before `.env.local` was updated.

Fix:

```bash
# ensure .env.local contains the key
npm run dev
```

Restart the dev server after editing `.env.local`.

### You see stale UI or old picker controls

The old static demo and browser fallback have been removed from the repo. If you still see a picker, Chrome is serving cached code.

Run this in the browser console on `localhost`:

```js
navigator.serviceWorker.getRegistrations().then(rs => rs.forEach(r => r.unregister()));
caches.keys().then(keys => keys.forEach(key => caches.delete(key)));
localStorage.clear();
sessionStorage.clear();
location.reload();
```

Then hard refresh.

### Mic permission is granted but no captions appear

Check the diagnostics:

- If status says `Waiting for speech before connecting to Deepgram…`, the local mic pipeline is active but local VAD has not detected speech above threshold yet.
- If status says `Paused Deepgram after sustained silence...`, speak again to reconnect Deepgram.
- If `Audio sent` is increasing, the browser is sending audio to Deepgram.
- If `Audio sent` remains `0` even while speaking, the browser may not be producing enough audio level for VAD or PCM streaming.
- If `Audio sent` increases but no transcript appears, Deepgram may not be detecting speech or may be returning an error.

Also check:

- Chrome microphone selected in browser settings
- macOS privacy permission for Chrome microphone
- input volume
- correct physical microphone
- VPN/proxy/firewall blocking Deepgram WebSocket traffic

## Testing

Fast tests:

```bash
npm test
```

Production build check:

```bash
npm run build
```

Real Deepgram prerecorded AMI diarization check:

```bash
npm run test:deepgram:ami
```

Real UI + Deepgram E2E proof:

```bash
npm run test:e2e:deepgram-ui
```

See [`docs/testing.md`](docs/testing.md) for details on the test suite and what each test proves.

## Security note

`VITE_DEEPGRAM_API_KEY` is exposed to browser JavaScript. This is acceptable only for local development/testing with a disposable or rotated key.

For production, do **not** ship a long-lived Deepgram key in the browser. Use one of:

- backend proxy
- short-lived token endpoint
- server-generated temporary credentials

## Removed functionality

The following legacy/fallback paths have been removed:

- manual speaker picker
- browser Web Speech fallback engine
- static accessibility demo page
- static demo JavaScript/CSS

The main app is now Deepgram Nova automatic diarization only.
