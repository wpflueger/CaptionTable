# CaptionTable

CaptionTable is an installable responsive web application for a **Conversation Captioner** experience. It uses **Deepgram Nova** for live transcription and automatic speaker diarization, then displays a full scrollable transcript of who said what.

## Development

```bash
npm install
cp .env.example .env.local
# Fill in VITE_DEEPGRAM_API_KEY
npm run dev
```

Open the local Vite URL, usually `http://localhost:5173`.

## Production build

```bash
npm run build
npm run preview
```

## Automatic speaker identification

Automatic speaker identification is Deepgram-only in the main app:

```bash
VITE_DEEPGRAM_API_KEY=...
```

When `VITE_DEEPGRAM_API_KEY` is present, the app uses Deepgram Nova live transcription with `diarize=true`. Caption cards and the full transcript show automatic speaker labels such as `Person 1`, `Person 2`, etc.

If the key is missing, Start is disabled. There is no manual speaker picker and no browser speech fallback path in the main app.

Do not ship long-lived provider API keys in a public browser app. The `VITE_DEEPGRAM_API_KEY` setup is intended for local development; production should use a short-lived token endpoint or backend proxy.

## AMI diarization integration check

Run an opt-in real Deepgram diarization check against the public AMI Meeting Corpus:

```bash
npm run test:deepgram:ami
```

The script downloads `ES2002a.Mix-Headset.wav`, creates a 90-second clip starting at 180 seconds in `.cache/test-audio/`, sends it to Deepgram Nova with `diarize=true`, and fails unless Deepgram returns a non-empty transcript with at least two detected speakers. Override with `AMI_CLIP_OFFSET_SECONDS=...` and `AMI_CLIP_SECONDS=...` for other segments.

## Tests

```bash
npm test
npm run build
```
