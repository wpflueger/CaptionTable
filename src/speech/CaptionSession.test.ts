import { describe, expect, it } from 'vitest';
import { CaptionSession } from './CaptionSession';
import { SpeechEngine, SpeechEngineCallbacks } from './SpeechEngine';

class FakeSpeechEngine implements SpeechEngine {
  callbacks: SpeechEngineCallbacks = {};
  active = false;

  start(): void {
    this.active = true;
    this.callbacks.onActiveChange?.(true);
  }

  stop(): void {
    this.active = false;
    this.callbacks.onActiveChange?.(false);
  }

  setLanguage(): void {}

  setCallbacks(callbacks: SpeechEngineCallbacks): void {
    this.callbacks = callbacks;
    this.callbacks.onAvailabilityChange?.({ available: true });
  }

  isActive(): boolean {
    return this.active;
  }
}

describe('CaptionSession', () => {
  it('keeps automatic speaker labels on interim and finalized captions', () => {
    const engine = new FakeSpeechEngine();
    const session = new CaptionSession(engine);
    const states = [session.getState()];
    session.subscribe((state) => states.push(state));

    session.start();
    engine.callbacks.onInterimText?.('hello there', 'Person 1');
    expect(session.getState().captions).toEqual([
      { id: 1, text: 'hello there', finalized: false, speakerLabel: 'Person 1' },
    ]);

    engine.callbacks.onFinalText?.('hello there', 'Person 1');
    expect(session.getState().captions).toEqual([
      { id: 1, text: 'hello there', finalized: true, speakerLabel: 'Person 1' },
    ]);

    engine.callbacks.onFinalText?.('reply from someone else', 'Person 2');
    expect(session.getState().captions.at(-1)).toEqual({
      id: 2,
      text: 'reply from someone else',
      finalized: true,
      speakerLabel: 'Person 2',
    });

    expect(states.some((state) => state.active)).toBe(true);
  });

  it('clears transcript state on stop', () => {
    const engine = new FakeSpeechEngine();
    const session = new CaptionSession(engine);

    session.start();
    engine.callbacks.onFinalText?.('stored caption', 'Person 1');
    expect(session.getState().captions).toHaveLength(1);

    session.stop();
    expect(session.getState()).toMatchObject({ active: false, captions: [], error: null });
  });

  it('does not notify caption-only subscribers for diagnostics-only audio stats', () => {
    const engine = new FakeSpeechEngine();
    const session = new CaptionSession(engine);
    const captionUpdates: Array<ReturnType<CaptionSession['getCaptions']>> = [];
    const stateUpdates: Array<ReturnType<CaptionSession['getState']>> = [];

    session.subscribeCaptions((captions) => captionUpdates.push(captions));
    session.subscribe((state) => stateUpdates.push(state));
    session.start();
    engine.callbacks.onAudioSend?.({ chunks: 1, bytes: 1024 });
    engine.callbacks.onAudioSend?.({ chunks: 2, bytes: 2048 });

    expect(captionUpdates).toEqual([[], []]);
    expect(stateUpdates.at(-1)).toMatchObject({ audioChunksSent: 2, audioBytesSent: 2048 });

    engine.callbacks.onFinalText?.('caption text', 'Person 1');
    expect(captionUpdates.at(-1)).toEqual([
      { id: 1, text: 'caption text', finalized: true, speakerLabel: 'Person 1' },
    ]);
  });
});
