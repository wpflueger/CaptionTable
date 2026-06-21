import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserAudioPipeline } from './AudioPipeline';

class FakeAudioWorkletNode {
  static instances: FakeAudioWorkletNode[] = [];
  port = { onmessage: null as ((event: MessageEvent) => void) | null };
  connect = vi.fn();
  disconnect = vi.fn();

  constructor() {
    FakeAudioWorkletNode.instances.push(this);
  }

  emit(data: unknown): void {
    this.port.onmessage?.({ data } as MessageEvent);
  }
}

class FakeAudioContextWithWorklet {
  sampleRate = 16000;
  state: AudioContextState = 'running';
  destination = {} as AudioDestinationNode;
  resume = vi.fn(async () => undefined);
  close = vi.fn(async () => undefined);
  audioWorklet = { addModule: vi.fn(async () => undefined) };
  createMediaStreamSource = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }));
  createGain = vi.fn(() => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }));
  createScriptProcessor = vi.fn();
}

class FailingAudioContext extends FakeAudioContextWithWorklet {
  createMediaStreamSource = vi.fn(() => {
    throw new Error('source failed');
  });
}

describe('BrowserAudioPipeline', () => {
  const originalMediaDevices = navigator.mediaDevices;

  beforeEach(() => {
    FakeAudioWorkletNode.instances = [];
    vi.stubGlobal('AudioContext', FakeAudioContextWithWorklet);
    vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: originalMediaDevices });
  });

  it('uses AudioWorkletNode and forwards PCM/level messages', async () => {
    const stop = vi.fn();
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop }] })) },
    });
    const pipeline = new BrowserAudioPipeline();
    const levels: number[] = [];
    const pcms: ArrayBuffer[] = [];
    pipeline.subscribeLevel((level) => levels.push(level));
    pipeline.subscribePcm((pcm) => pcms.push(pcm));

    const info = await pipeline.start();
    expect(info).toEqual({ sampleRate: 16000, channels: 1, worklet: true });
    expect(FakeAudioWorkletNode.instances).toHaveLength(1);

    const pcm = new ArrayBuffer(8);
    FakeAudioWorkletNode.instances[0].emit({ type: 'level', level: 0.5 });
    FakeAudioWorkletNode.instances[0].emit({ type: 'pcm', pcm });

    expect(levels).toEqual([0.5]);
    expect(pcms).toEqual([pcm]);

    await pipeline.stop();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('cleans up owned stream after partial start failure', async () => {
    const stop = vi.fn();
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop }] })) },
    });
    vi.stubGlobal('AudioContext', FailingAudioContext);

    const pipeline = new BrowserAudioPipeline();
    await expect(pipeline.start()).rejects.toThrow('source failed');
    expect(stop).toHaveBeenCalledTimes(1);
    expect(pipeline.info).toBeNull();
  });
});
