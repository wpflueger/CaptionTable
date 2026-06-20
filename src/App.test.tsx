import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  deepgramKey: 'test-key',
  callbacks: undefined as import('./speech').SpeechEngineCallbacks | undefined,
  active: false,
}));

vi.mock('./speech', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./speech')>();

  class MockDeepgramNovaSpeechEngine implements actual.SpeechEngine {
    constructor() {}
    start(): void {
      hoisted.active = true;
      hoisted.callbacks?.onActiveChange?.(true);
    }
    stop(): void {
      hoisted.active = false;
      hoisted.callbacks?.onActiveChange?.(false);
    }
    setLanguage(): void {}
    setMediaStream = vi.fn();
    setAudioSource = vi.fn();
    setCallbacks(callbacks: actual.SpeechEngineCallbacks): void {
      hoisted.callbacks = callbacks;
      callbacks.onAvailabilityChange?.({ available: true });
    }
    isActive(): boolean {
      return hoisted.active;
    }
  }

  return {
    ...actual,
    DeepgramNovaSpeechEngine: MockDeepgramNovaSpeechEngine,
  };
});

vi.mock('./session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./session')>();
  class MockSessionLifecycle {
    constructor(private options: actual.SessionLifecycleOptions = {}) {}
    async start(): Promise<void> {
      this.options.onStateChange?.('active');
      this.options.onWakeLockChange?.(true);
    }
    async stop(): Promise<void> {
      this.options.onWakeLockChange?.(false);
      this.options.onStateChange?.('stopped');
      this.options.onGuidance?.('Captions stopped.');
    }
    reportInputVolume(): void {}
  }
  return { ...actual, SessionLifecycle: MockSessionLifecycle };
});

function installBrowserFakes() {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })),
    },
  });

  class FakeAudioContext {
    sampleRate = 16000;
    state: AudioContextState = 'running';
    destination = {} as AudioDestinationNode;
    resume = vi.fn(async () => undefined);
    createMediaStreamSource() {
      return { connect: vi.fn(), disconnect: vi.fn() };
    }
    createGain() {
      return { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
    }
    createScriptProcessor() {
      return { onaudioprocess: null, connect: vi.fn(), disconnect: vi.fn() };
    }
    close = vi.fn(async () => undefined);
  }

  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
}

describe('App', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    hoisted.deepgramKey = 'test-key';
    hoisted.callbacks = undefined;
    hoisted.active = false;
    installBrowserFakes();
  });

  it('shows Deepgram automatic speaker identification and no manual picker', async () => {
    vi.stubEnv('VITE_DEEPGRAM_API_KEY', 'test-key');
    const { App } = await import('./App');
    render(<App />);

    expect(screen.getByText('Conversation Captioner')).toBeInTheDocument();
    expect(screen.getByText('Automatic with Deepgram Nova')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start Captions' })).toBeEnabled();
  });

  it('disables start when Deepgram API key is absent', async () => {
    vi.stubEnv('VITE_DEEPGRAM_API_KEY', '');
    const { App } = await import('./App');
    render(<App />);

    expect(screen.getByText('Deepgram key missing')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start Captions' })).toBeDisabled();
  });

  it('renders active captions and a full scrollable speaker transcript from automatic labels', async () => {
    vi.stubEnv('VITE_DEEPGRAM_API_KEY', 'test-key');
    const { App } = await import('./App');
    render(<App />);

    await userEvent.click(screen.getByRole('button', { name: 'Start Captions' }));
    expect(await screen.findByText('Full speaker transcript')).toBeInTheDocument();
    expect(screen.queryByText('Recent finalized captions')).not.toBeInTheDocument();

    act(() => {
      hoisted.callbacks?.onInterimText?.('hello from speaker one', 'Person 1');
    });
    expect(await screen.findAllByText('Person 1')).toHaveLength(2);
    expect(screen.getAllByText('hello from speaker one')).toHaveLength(2);

    act(() => {
      hoisted.callbacks?.onFinalText?.('hello from speaker one', 'Person 1');
      hoisted.callbacks?.onFinalText?.('answer from speaker two', 'Person 2');
    });

    await waitFor(() => expect(screen.getAllByText('answer from speaker two')).toHaveLength(2));
    expect(screen.getAllByText('Person 2')).toHaveLength(2);
  });

  it('windows long transcript rendering to the latest 500 turns', async () => {
    vi.stubEnv('VITE_DEEPGRAM_API_KEY', 'test-key');
    const { App } = await import('./App');
    render(<App />);

    await userEvent.click(screen.getByRole('button', { name: 'Start Captions' }));
    expect(await screen.findByText('Full speaker transcript')).toBeInTheDocument();

    act(() => {
      for (let index = 1; index <= 550; index += 1) {
        hoisted.callbacks?.onFinalText?.(`caption ${index}`, 'Person 1');
      }
    });

    expect(await screen.findByText('Showing latest 500 of 550 transcript turns.')).toBeInTheDocument();
    expect(screen.queryByText('caption 1')).not.toBeInTheDocument();
    expect(screen.getAllByText('caption 550')).toHaveLength(2);
  });
});
