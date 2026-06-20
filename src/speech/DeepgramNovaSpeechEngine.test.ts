import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioPipeline, AudioPipelineInfo, AudioLevelListener, PcmAudioListener } from '../audio/AudioPipeline';
import { DeepgramNovaSpeechEngine } from './DeepgramNovaSpeechEngine';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  static CLOSED = 3;
  readyState = FakeWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  sent: unknown[] = [];

  constructor(public url: string, public protocols: string[]) {
    FakeWebSocket.instances.push(this);
  }

  send(payload: unknown): void {
    this.sent.push(payload);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1000, reason: '' });
  }

  emitMessage(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

class FakeScriptProcessorNode {
  static instances: FakeScriptProcessorNode[] = [];
  onaudioprocess: ((event: { inputBuffer: { getChannelData: (channel: number) => Float32Array } }) => void) | null = null;
  connect = vi.fn();
  disconnect = vi.fn();

  constructor() {
    FakeScriptProcessorNode.instances.push(this);
  }

  emitAudio(samples = new Float32Array([0, 0.25, -0.25, 1, -1])): void {
    this.onaudioprocess?.({ inputBuffer: { getChannelData: () => samples } });
  }
}

class FakeAudioContext {
  sampleRate = 16000;
  state: AudioContextState = 'running';
  destination = {} as AudioDestinationNode;
  resume = vi.fn(async () => undefined);
  close = vi.fn(async () => undefined);
  createMediaStreamSource = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }));
  createScriptProcessor = vi.fn(() => new FakeScriptProcessorNode());
  createGain = vi.fn(() => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }));
}

class FakeAudioPipeline implements AudioPipeline {
  info: AudioPipelineInfo | null = { sampleRate: 16000, channels: 1, worklet: true };
  start = vi.fn(async () => this.info as AudioPipelineInfo);
  stop = vi.fn(async () => undefined);
  private levelListeners = new Set<AudioLevelListener>();
  private pcmListeners = new Set<PcmAudioListener>();

  subscribeLevel(listener: AudioLevelListener): () => void {
    this.levelListeners.add(listener);
    return () => this.levelListeners.delete(listener);
  }

  subscribePcm(listener: PcmAudioListener): () => void {
    this.pcmListeners.add(listener);
    return () => this.pcmListeners.delete(listener);
  }

  emitLevel(level: number): void {
    this.levelListeners.forEach((listener) => listener(level));
  }

  emitPcm(byteLength = 8): void {
    this.pcmListeners.forEach((listener) => listener(new ArrayBuffer(byteLength)));
  }
}

describe('DeepgramNovaSpeechEngine', () => {
  const originalWebSocket = globalThis.WebSocket;
  const originalMediaDevices = navigator.mediaDevices;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    FakeScriptProcessorNode.instances = [];
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', Object.assign(FakeWebSocket, { OPEN: FakeWebSocket.OPEN, CLOSED: FakeWebSocket.CLOSED }));
    vi.stubGlobal('AudioContext', FakeAudioContext);
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
  });

  it('connects to Deepgram Nova with diarization and PCM streaming enabled', async () => {
    const engine = new DeepgramNovaSpeechEngine({ apiKey: 'test-key', language: 'en-US', model: 'nova-3' });
    engine.setCallbacks({});

    engine.start();
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    const socket = FakeWebSocket.instances[0];
    expect(socket.url).toContain('model=nova-3');
    expect(socket.url).toContain('diarize=true');
    expect(socket.url).toContain('interim_results=true');
    expect(socket.url).toContain('encoding=linear16');
    expect(socket.url).toContain('sample_rate=16000');
    expect(socket.protocols).toEqual(['token', 'test-key']);
  });

  it('sends PCM audio from Web Audio to Deepgram and reports audio stats', async () => {
    const audioStats: Array<{ chunks: number; bytes: number }> = [];
    const statuses: string[] = [];
    const engine = new DeepgramNovaSpeechEngine({ apiKey: 'test-key' });
    engine.setCallbacks({
      onAudioSend: (stats) => audioStats.push(stats),
      onStatusChange: (message) => statuses.push(message),
    });

    engine.start();
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];
    socket.onopen?.();

    expect(FakeScriptProcessorNode.instances).toHaveLength(1);
    FakeScriptProcessorNode.instances[0].emitAudio(new Float32Array([0, 0.5, -0.5]));

    const binaryPayloads = socket.sent.filter((payload) => payload instanceof ArrayBuffer) as ArrayBuffer[];
    expect(binaryPayloads).toHaveLength(1);
    expect(binaryPayloads[0].byteLength).toBe(6);
    expect(audioStats).toEqual([{ chunks: 1, bytes: 6 }]);
    expect(statuses).toContain('Audio is streaming to Deepgram. Waiting for transcript…');
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

  it('uses a provided shared media stream without taking ownership by default', async () => {
    const stop = vi.fn();
    const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream;
    const getUserMedia = vi.spyOn(navigator.mediaDevices, 'getUserMedia');
    const engine = new DeepgramNovaSpeechEngine({ apiKey: 'test-key', mediaStream: stream });

    engine.start();
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    FakeWebSocket.instances[0].onopen?.();

    expect(getUserMedia).not.toHaveBeenCalled();
    engine.stop();
    expect(stop).not.toHaveBeenCalled();
  });

  it('stops provided streams only when ownership is explicit', async () => {
    const stop = vi.fn();
    const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream;
    const engine = new DeepgramNovaSpeechEngine({ apiKey: 'test-key' });
    engine.setMediaStream(stream, { ownsStream: true });

    engine.start();
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    FakeWebSocket.instances[0].onopen?.();

    engine.stop();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('throttles audio-send diagnostics while keeping internal counters accurate', async () => {
    const audioStats: Array<{ chunks: number; bytes: number }> = [];
    const engine = new DeepgramNovaSpeechEngine({ apiKey: 'test-key', audioStatsIntervalMs: 500 });
    engine.setCallbacks({ onAudioSend: (stats) => audioStats.push(stats) });

    engine.start();
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    FakeWebSocket.instances[0].onopen?.();
    const processor = FakeScriptProcessorNode.instances[0];

    processor.emitAudio(new Float32Array([0, 0.5]));
    processor.emitAudio(new Float32Array([0, 0.5]));
    processor.emitAudio(new Float32Array([0, 0.5]));
    expect(audioStats).toEqual([{ chunks: 1, bytes: 4 }]);

    vi.advanceTimersByTime(499);
    processor.emitAudio(new Float32Array([0, 0.5]));
    expect(audioStats).toEqual([{ chunks: 1, bytes: 4 }]);

    vi.advanceTimersByTime(1);
    processor.emitAudio(new Float32Array([0, 0.5]));
    expect(audioStats).toEqual([
      { chunks: 1, bytes: 4 },
      { chunks: 5, bytes: 20 },
    ]);
  });

  it('sends pre-roll PCM captured before the Deepgram socket opens', async () => {
    const statuses: string[] = [];
    const source = new FakeAudioPipeline();
    const engine = new DeepgramNovaSpeechEngine({
      apiKey: 'test-key',
      audioSource: source,
      silenceGate: { enabled: true, speechThreshold: 0.1, preRollMs: 1000 },
    });
    engine.setCallbacks({ onStatusChange: (status) => statuses.push(status) });

    engine.start();
    await vi.waitFor(() => expect(statuses).toContain('Waiting for speech before connecting to Deepgram…'));
    source.emitPcm(16);
    source.emitPcm(24);

    source.emitLevel(0.2);
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];
    socket.onopen?.();

    const binaryPayloads = socket.sent.filter((payload) => payload instanceof ArrayBuffer) as ArrayBuffer[];
    expect(binaryPayloads.map((payload) => payload.byteLength)).toEqual([16, 24]);
  });

  it('creates only one socket for rapid repeated VAD speech events while connecting', async () => {
    const statuses: string[] = [];
    const source = new FakeAudioPipeline();
    const engine = new DeepgramNovaSpeechEngine({
      apiKey: 'test-key',
      audioSource: source,
      silenceGate: { enabled: true, speechThreshold: 0.1 },
    });
    engine.setCallbacks({ onStatusChange: (status) => statuses.push(status) });

    engine.start();
    await vi.waitFor(() => expect(statuses).toContain('Waiting for speech before connecting to Deepgram…'));
    source.emitLevel(0.2);
    source.emitLevel(0.2);
    source.emitLevel(0.2);

    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
  });

  it('pauses Deepgram during sustained silence and reconnects on resumed speech', async () => {
    const statuses: string[] = [];
    const source = new FakeAudioPipeline();
    const engine = new DeepgramNovaSpeechEngine({
      apiKey: 'test-key',
      audioSource: source,
      silenceGate: { enabled: true, speechThreshold: 0.1, silenceTimeoutMs: 1000, minConnectionMs: 500 },
    });
    engine.setCallbacks({ onStatusChange: (status) => statuses.push(status) });

    engine.start();
    await vi.waitFor(() => expect(statuses).toContain('Waiting for speech before connecting to Deepgram…'));
    expect(FakeWebSocket.instances).toHaveLength(0);

    source.emitLevel(0.2);
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const firstSocket = FakeWebSocket.instances[0];
    firstSocket.onopen?.();
    source.emitPcm(16);
    expect(firstSocket.sent.some((payload) => payload instanceof ArrayBuffer)).toBe(true);

    vi.advanceTimersByTime(1500);
    source.emitLevel(0);
    expect(firstSocket.sent.some((payload) => typeof payload === 'string' && payload.includes('CloseStream'))).toBe(true);
    expect(statuses).toContain('Sustained silence detected. Pausing Deepgram stream…');

    source.emitLevel(0.2);
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
  });

  it('ignores stale socket close events after reconnect', async () => {
    const activeStates: boolean[] = [];
    const source = new FakeAudioPipeline();
    const engine = new DeepgramNovaSpeechEngine({
      apiKey: 'test-key',
      audioSource: source,
      silenceGate: { enabled: true, speechThreshold: 0.1, silenceTimeoutMs: 1000, minConnectionMs: 500 },
    });
    const statuses: string[] = [];
    engine.setCallbacks({
      onActiveChange: (active) => activeStates.push(active),
      onStatusChange: (status) => statuses.push(status),
    });

    engine.start();
    await vi.waitFor(() => expect(statuses).toContain('Waiting for speech before connecting to Deepgram…'));
    source.emitLevel(0.2);
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const firstSocket = FakeWebSocket.instances[0];
    firstSocket.onopen?.();

    vi.advanceTimersByTime(1500);
    source.emitLevel(0);
    source.emitLevel(0.2);
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const secondSocket = FakeWebSocket.instances[1];
    secondSocket.onopen?.();

    firstSocket.onclose?.({ code: 4000, reason: 'stale close' });
    expect(activeStates.at(-1)).toBe(true);
    source.emitPcm(12);
    expect(secondSocket.sent.some((payload) => payload instanceof ArrayBuffer)).toBe(true);
  });

  it('cleans up PCM nodes, socket, keepalive, and active state on stop', async () => {
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
    expect(FakeScriptProcessorNode.instances[0].disconnect).toHaveBeenCalled();
  });
});
