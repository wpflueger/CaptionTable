# CaptionTable

CaptionTable is an installable responsive web application for a **Conversation Captioner** experience. It provides start and active-caption screens optimized for phone, tablet, and laptop layouts without login, ads, subscription prompts, account controls, usage meters, or API-key controls.

## Development

```bash
npm install
npm run dev
```

## Production build

```bash
npm run build
```

## Speech recognition layer

The implementation lives in `src/speech/`:

- `SpeechEngine.ts` defines the engine contract, callbacks, availability reporting, and plain-language error states.
- `BrowserSpeechEngine.ts` adapts the browser `SpeechRecognition` / `webkitSpeechRecognition` APIs when they are available.
- `CaptionSession.ts` keeps transcript data in memory for the active session, exposes interim captions, replaces interim captions with finalized captions using the same caption id, and clears all caption/session state on Stop.
- `captionStyles.css` contains basic caption styles with a stable line height to avoid layout jumps between interim and finalized captions.

### Basic usage

```ts
import { BrowserSpeechEngine, CaptionSession } from './src/speech';

const session = new CaptionSession(new BrowserSpeechEngine('en-US'));

const unsubscribe = session.subscribe((state) => {
  renderCaptions(state.captions);
  renderError(state.error?.message ?? null);
});

startButton.addEventListener('click', () => session.start());
stopButton.addEventListener('click', () => session.stop());
languageSelect.addEventListener('change', (event) => {
  session.setLanguage((event.target as HTMLSelectElement).value);
});
```

Calling `session.stop()` immediately stops the underlying speech engine and clears in-memory transcript state.
