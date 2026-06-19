import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeepgramNovaSpeechEngine } from './DeepgramNovaSpeechEngine';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  readyState = FakeWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: (() => void) | null = null;
  sent: unknown[] = [];

  constructor(public url: string, public protocols: string[]) {
    FakeWebSocket.instances.push(this);
  }

  send(payload: unknown): void {
    this.sent.push(payload);
  }

  close(): void {
    this.onclose?.();
  }

  emitMessage(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

class FakeMediaRecorder {
  static isTypeSupported = vi.fn(() => true);
  state = 'inactive';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(public stream: MediaStream, public options?: MediaRecorderOptions) {}

  start(): void {
    this.state = 'recording';
  }

  stop(): void {
    this.state = 'inactive';
  }
}

describe('DeepgramNovaSpeechEngine', () => {
  const originalWebSocket = globalThis.WebSocket;
  const originalMediaRecorder = globalThis.MediaRecorder;
  const originalMediaDevices = navigator.mediaDevices;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', Object.assign(FakeWebSocket, { OPEN: FakeWebSocket.OPEN }));
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })),
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: originalMediaDevices });
    globalThis.WebSocket = originalWebSocket;
    globalThis.MediaRecorder = originalMediaRecorder;
  });

  it('connects to Deepgram Nova with diarization enabled', async () => {
    const engine = new DeepgramNovaSpeechEngine({ apiKey: 'test-key', language: 'en-US', model: 'nova-3' });
    engine.setCallbacks({});

    engine.start();
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    const socket = FakeWebSocket.instances[0];
    expect(socket.url).toContain('model=nova-3');
    expect(socket.url).toContain('diarize=true');
    expect(socket.url).toContain('interim_results=true');
    expect(socket.protocols).toEqual(['token', 'test-key']);
  });

  it('emits automatic speaker labels and splits multi-speaker results into separate transcript turns', async () => {
    const finals: Array<{ text: string; speaker?: string }> = [];
    const interims: Array<{ text: string; speaker?: string }> = [];
    const activeStates: boolean[] = [];
    const engine = new DeepgramNovaSpeechEngine({ apiKey: 'test-key' });
    engine.setCallbacks({
      onFinalText: (text, speaker) => finals.push({ text, speaker }),
      onInterimText: (text, speaker) => interims.push({ text, speaker }),
      onActiveChange: (active) => activeStates.push(active),
    });

    engine.start();
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];
    socket.onopen?.();

    expect(activeStates).toContain(true);

    socket.emitMessage({
      type: 'Results',
      is_final: false,
      channel: {
        alternatives: [{ transcript: 'hello', words: [{ word: 'hello', speaker: 0 }] }],
      },
    });
    expect(interims).toEqual([{ text: 'hello', speaker: 'Person 1' }]);

    socket.emitMessage({
      type: 'Results',
      is_final: true,
      channel: {
        alternatives: [
          {
            transcript: 'that is right',
            words: [
              { word: 'that', speaker: 1 },
              { word: 'is', speaker: 1 },
              { word: 'right', speaker: 0 },
            ],
          },
        ],
      },
    });
    expect(finals).toEqual([
      { text: 'that is', speaker: 'Person 2' },
      { text: 'right', speaker: 'Person 1' },
    ]);
  });

  it('uses a provided shared media stream instead of opening a second microphone stream', async () => {
    const stop = vi.fn();
    const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream;
    const getUserMedia = vi.spyOn(navigator.mediaDevices, 'getUserMedia');
    const engine = new DeepgramNovaSpeechEngine({ apiKey: 'test-key', mediaStream: stream });

    engine.start();
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    FakeWebSocket.instances[0].onopen?.();

    expect(getUserMedia).not.toHaveBeenCalled();
    engine.stop();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('cleans up recorder, socket, keepalive, and active state on stop', async () => {
    const activeStates: boolean[] = [];
    const engine = new DeepgramNovaSpeechEngine({ apiKey: 'test-key' });
    engine.setCallbacks({ onActiveChange: (active) => activeStates.push(active) });

    engine.start();
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];
    socket.onopen?.();

    vi.advanceTimersByTime(8000);
    expect(socket.sent.some((payload) => typeof payload === 'string' && payload.includes('KeepAlive'))).toBe(true);

    engine.stop();
    expect(activeStates).toContain(false);
    expect(socket.sent.some((payload) => typeof payload === 'string' && payload.includes('CloseStream'))).toBe(true);
  });
});
