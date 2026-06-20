export interface AudioPipelineInfo {
  sampleRate: number;
  channels: number;
  worklet: boolean;
}

export type AudioLevelListener = (level: number) => void;
export type PcmAudioListener = (pcm: ArrayBuffer) => void;

export interface AudioPipeline {
  readonly info: AudioPipelineInfo | null;
  start(): Promise<AudioPipelineInfo>;
  stop(): Promise<void>;
  subscribeLevel(listener: AudioLevelListener): () => void;
  subscribePcm(listener: PcmAudioListener): () => void;
}

type BrowserAudioWindow = Window & {
  webkitAudioContext?: typeof AudioContext;
};

type WorkletMessage =
  | { type: 'pcm'; pcm: ArrayBuffer }
  | { type: 'level'; level: number };

export interface BrowserAudioPipelineOptions {
  mediaStream?: MediaStream;
  ownsMediaStream?: boolean;
  pcmBufferSize?: number;
  levelIntervalMs?: number;
  forceScriptProcessor?: boolean;
  workletUrl?: string;
}

const DEFAULT_PCM_BUFFER_SIZE = 4096;
const DEFAULT_LEVEL_INTERVAL_MS = 100;

export class BrowserAudioPipeline implements AudioPipeline {
  private readonly providedStream: MediaStream | null;
  private readonly ownsProvidedStream: boolean;
  private readonly pcmBufferSize: number;
  private readonly levelIntervalMs: number;
  private readonly forceScriptProcessor: boolean;
  private readonly workletUrl: string;

  private stream: MediaStream | null = null;
  private streamOwned = false;
  private audioContext: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private processorNode: ScriptProcessorNode | null = null;
  private silenceNode: GainNode | null = null;
  private startedInfo: AudioPipelineInfo | null = null;
  private readonly levelListeners = new Set<AudioLevelListener>();
  private readonly pcmListeners = new Set<PcmAudioListener>();
  private lastLevelEmitMs = Number.NEGATIVE_INFINITY;

  constructor(options: BrowserAudioPipelineOptions = {}) {
    this.providedStream = options.mediaStream ?? null;
    this.ownsProvidedStream = options.ownsMediaStream ?? false;
    this.pcmBufferSize = options.pcmBufferSize ?? DEFAULT_PCM_BUFFER_SIZE;
    this.levelIntervalMs = options.levelIntervalMs ?? DEFAULT_LEVEL_INTERVAL_MS;
    this.forceScriptProcessor = options.forceScriptProcessor ?? false;
    this.workletUrl = options.workletUrl ?? new URL('./pcmWorklet.js', import.meta.url).toString();
  }

  get info(): AudioPipelineInfo | null {
    return this.startedInfo;
  }

  async start(): Promise<AudioPipelineInfo> {
    if (this.startedInfo) return this.startedInfo;

    if (!navigator.mediaDevices?.getUserMedia && !this.providedStream) {
      throw new Error('Microphone capture is not available in this browser.');
    }

    const AudioContextCtor = window.AudioContext || (window as BrowserAudioWindow).webkitAudioContext;
    if (!AudioContextCtor) {
      throw new Error('Web Audio is not available in this browser.');
    }

    this.stream = this.providedStream ?? await navigator.mediaDevices.getUserMedia({ audio: true });
    this.streamOwned = this.providedStream ? this.ownsProvidedStream : true;
    this.audioContext = new AudioContextCtor();
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }

    this.sourceNode = this.audioContext.createMediaStreamSource(this.stream);
    const usedWorklet = await this.connectProcessingNode();
    this.startedInfo = {
      sampleRate: Math.round(this.audioContext.sampleRate),
      channels: 1,
      worklet: usedWorklet,
    };
    return this.startedInfo;
  }

  async stop(): Promise<void> {
    this.workletNode?.disconnect();
    this.processorNode?.disconnect();
    this.sourceNode?.disconnect();
    this.silenceNode?.disconnect();
    this.workletNode = null;
    this.processorNode = null;
    this.sourceNode = null;
    this.silenceNode = null;

    if (this.streamOwned) {
      this.stream?.getTracks().forEach((track) => track.stop());
    }
    this.stream = null;

    if (this.audioContext) {
      await this.audioContext.close();
      this.audioContext = null;
    }
    this.streamOwned = false;
    this.startedInfo = null;
    this.lastLevelEmitMs = Number.NEGATIVE_INFINITY;
  }

  subscribeLevel(listener: AudioLevelListener): () => void {
    this.levelListeners.add(listener);
    return () => this.levelListeners.delete(listener);
  }

  subscribePcm(listener: PcmAudioListener): () => void {
    this.pcmListeners.add(listener);
    return () => this.pcmListeners.delete(listener);
  }

  private async connectProcessingNode(): Promise<boolean> {
    if (!this.audioContext || !this.sourceNode) {
      throw new Error('Audio pipeline has not been initialized.');
    }

    this.silenceNode = this.audioContext.createGain();
    this.silenceNode.gain.value = 0;

    if (!this.forceScriptProcessor && this.audioContext.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
      try {
        await this.audioContext.audioWorklet.addModule(this.workletUrl);
        this.workletNode = new AudioWorkletNode(this.audioContext, 'caption-table-pcm-worklet', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          channelCount: 1,
          processorOptions: {
            pcmBufferSize: this.pcmBufferSize,
            levelIntervalMs: this.levelIntervalMs,
            sampleRate: this.audioContext.sampleRate,
          },
        });
        this.workletNode.port.onmessage = (event: MessageEvent<WorkletMessage>) => this.handleWorkletMessage(event.data);
        this.sourceNode.connect(this.workletNode);
        this.workletNode.connect(this.silenceNode);
        this.silenceNode.connect(this.audioContext.destination);
        return true;
      } catch (error) {
        console.warn('AudioWorklet setup failed; falling back to ScriptProcessorNode.', error);
        this.workletNode?.disconnect();
        this.workletNode = null;
      }
    }

    this.processorNode = this.audioContext.createScriptProcessor(this.pcmBufferSize, 1, 1);
    this.processorNode.onaudioprocess = (event) => {
      const samples = event.inputBuffer.getChannelData(0);
      this.emitLevelFromSamples(samples);
      this.emitPcm(float32ToLinear16(samples));
    };
    this.sourceNode.connect(this.processorNode);
    this.processorNode.connect(this.silenceNode);
    this.silenceNode.connect(this.audioContext.destination);
    return false;
  }

  private handleWorkletMessage(message: WorkletMessage): void {
    if (message.type === 'pcm') {
      this.emitPcm(message.pcm);
      return;
    }

    if (message.type === 'level') {
      this.emitLevel(message.level);
    }
  }

  private emitPcm(pcm: ArrayBuffer): void {
    this.pcmListeners.forEach((listener) => listener(pcm));
  }

  private emitLevelFromSamples(samples: Float32Array): void {
    const now = Date.now();
    if (now - this.lastLevelEmitMs < this.levelIntervalMs) {
      return;
    }

    let total = 0;
    samples.forEach((sample) => {
      total += sample * sample;
    });
    this.lastLevelEmitMs = now;
    this.emitLevel(Math.sqrt(total / samples.length));
  }

  private emitLevel(level: number): void {
    const normalizedLevel = Math.max(0, Math.min(1, level));
    this.levelListeners.forEach((listener) => listener(normalizedLevel));
  }
}

function float32ToLinear16(samples: Float32Array): ArrayBuffer {
  const output = new ArrayBuffer(samples.length * 2);
  const view = new DataView(output);
  samples.forEach((sample, index) => {
    const clamped = Math.max(-1, Math.min(1, sample));
    const value = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    view.setInt16(index * 2, value, true);
  });
  return output;
}
