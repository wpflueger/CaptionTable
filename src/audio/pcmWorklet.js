class CaptionTablePcmWorklet extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const processorOptions = options.processorOptions || {};
    this.pcmBufferSize = processorOptions.pcmBufferSize || 4096;
    this.levelIntervalMs = processorOptions.levelIntervalMs || 100;
    this.sampleRate = processorOptions.sampleRate || sampleRate;
    this.samples = new Float32Array(this.pcmBufferSize);
    this.offset = 0;
    this.framesSinceLevel = 0;
    this.framesPerLevel = Math.max(1, Math.round((this.sampleRate * this.levelIntervalMs) / 1000));
    this.levelTotal = 0;
    this.levelCount = 0;
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (output) {
      output.fill(0);
    }

    if (!input) {
      return true;
    }

    for (let index = 0; index < input.length; index += 1) {
      const sample = input[index] || 0;
      this.samples[this.offset] = sample;
      this.offset += 1;

      this.levelTotal += sample * sample;
      this.levelCount += 1;
      this.framesSinceLevel += 1;

      if (this.offset >= this.pcmBufferSize) {
        const pcm = this.float32ToLinear16(this.samples);
        this.port.postMessage({ type: 'pcm', pcm }, [pcm]);
        this.offset = 0;
      }

      if (this.framesSinceLevel >= this.framesPerLevel) {
        const level = Math.sqrt(this.levelTotal / Math.max(1, this.levelCount));
        this.port.postMessage({ type: 'level', level });
        this.framesSinceLevel = 0;
        this.levelTotal = 0;
        this.levelCount = 0;
      }
    }

    return true;
  }

  float32ToLinear16(samples) {
    const output = new ArrayBuffer(samples.length * 2);
    const view = new DataView(output);
    for (let index = 0; index < samples.length; index += 1) {
      const clamped = Math.max(-1, Math.min(1, samples[index] || 0));
      const value = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      view.setInt16(index * 2, value, true);
    }
    return output;
  }
}

registerProcessor('caption-table-pcm-worklet', CaptionTablePcmWorklet);
