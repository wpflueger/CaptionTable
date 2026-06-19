# CaptionTable

CaptionTable provides a small browser speech-recognition layer for live captioning.

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
