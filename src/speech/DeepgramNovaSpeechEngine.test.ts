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
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported = vi.fn(() => true);
  state = 'inactive';
  mimeType: string;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onstart: (() => void) | null = null;
  onstop: (() => void) | null = null;

  constructor(public stream: MediaStream, public options?: MediaRecorderOptions) {
    this.mimeType = options?.mimeType ?? 'audio/webm;codecs=opus';
    FakeMediaRecorder.instances.push(this);
  }

  start(): void {
    this.state = 'recording';
    this.onstart?.();
  }

  stop(): void {
    this.state = 'inactive';
    this.onstop?.();
  }

  emitData(size = 12): void {
    this.ondataavailable?.({ data: new Blob([new Uint8Array(size)], { type: this.mimeType }) });
  }
}

describe('DeepgramNovaSpeechEngine', () => {
  const originalWebSocket = globalThis.WebSocket;
  const originalMediaRecorder = globalThis.MediaRecorder;
  const originalMediaDevices = navigator.mediaDevices;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    FakeMediaRecorder.instances = [];
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

  it('recovers when the initial browser recorder produces zero audio chunks', async () => {
    const initialStop = vi.fn();
    const fallbackStop = vi.fn();
    const initialStream = { getTracks: () => [{ stop: initialStop }] } as unknown as MediaStream;
    const fallbackStream = { getTracks: () => [{ stop: fallbackStop }] } as unknown as MediaStream;
    const getUserMedia = vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockResolvedValue(fallbackStream);
    const statuses: string[] = [];
    const audioStats: Array<{ chunks: number; bytes: number }> = [];
    const engine = new DeepgramNovaSpeechEngine({ apiKey: 'test-key', mediaStream: initialStream });
    engine.setCallbacks({
      onStatusChange: (message) => statuses.push(message),
      onAudioSend: (stats) => audioStats.push(stats),
    });

    engine.start();
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];
    socket.onopen?.();

    expect(FakeMediaRecorder.instances).toHaveLength(1);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(audioStats).toEqual([]);

    await vi.advanceTimersByTimeAsync(3000);
    await vi.waitFor(() => expect(FakeMediaRecorder.instances).toHaveLength(2));

    expect(statuses).toContain('No audio chunks from browser recorder yet. Restarting recorder with a fresh microphone stream…');
    expect(getUserMedia).toHaveBeenCalledTimes(1);

    FakeMediaRecorder.instances[1].emitData(256);

    expect(socket.sent.some((payload) => payload instanceof Blob)).toBe(true);
    expect(audioStats.at(-1)).toEqual({ chunks: 1, bytes: 256 });
    expect(statuses).toContain('Audio is streaming to Deepgram. Waiting for transcript…');
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
