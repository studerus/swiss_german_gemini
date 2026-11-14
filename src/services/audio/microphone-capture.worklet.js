// The same PCM samples feed recognition and its latency clock. No audio is stored.
class MicrophoneCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Int16Array(320);
    this.index = 0;
    this.phase = 0;
    this.sum = 0;
    this.count = 0;
    this.packetStart = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    for (let i = 0; i < input.length; i++) {
      this.sum += input[i];
      this.count++;
      this.phase += 16000;
      if (this.phase < sampleRate) continue;
      if (!this.index) this.packetStart = (currentFrame + i - this.count + 1) / sampleRate;
      const value = Math.max(-1, Math.min(1, this.sum / this.count));
      this.buffer[this.index++] = Math.round(value * (value < 0 ? 32768 : 32767));
      this.phase -= sampleRate;
      this.sum = 0;
      this.count = 0;
      if (this.index === this.buffer.length) {
        this.port.postMessage({ pcm: this.buffer.buffer, audioTime: this.packetStart }, [this.buffer.buffer]);
        this.buffer = new Int16Array(320);
        this.index = 0;
      }
    }
    return true;
  }
}
registerProcessor('microphone-capture', MicrophoneCaptureProcessor);
