import { CapturedAudioClock } from '../latency';

export class MicrophoneCapture {
  readonly clock = new CapturedAudioClock();
  private context?: AudioContext;
  private stream?: MediaStream;
  private source?: MediaStreamAudioSourceNode;
  private processor?: AudioWorkletNode;
  private stopped = false;

  constructor(private readonly onPCM: (buffer: ArrayBuffer, at: number) => void) {}

  async start(): Promise<void> {
    try {
      this.context = new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' });
      if (this.context.sampleRate < 16000) throw new Error('Die Mikrofon-Abtastrate wird nicht unterstützt.');
      await this.context.resume();
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
      if (this.stopped) { this.stop(); return; }
      await this.context.audioWorklet.addModule(new URL('./microphone-capture.worklet.js', import.meta.url));
      if (this.stopped) return;
      this.processor = new AudioWorkletNode(this.context, 'microphone-capture', { channelCount: 1, channelCountMode: 'explicit' });
      this.processor.port.onmessage = ({ data }: MessageEvent<{ pcm: ArrayBuffer; audioTime: number }>) => {
        if (this.stopped || !this.context) return;
        const packetAt = performance.now() + (data.audioTime - this.context.currentTime) * 1000;
        this.clock.add(data.pcm.byteLength / 2, packetAt);
        this.onPCM(data.pcm, packetAt);
      };
      this.source = this.context.createMediaStreamSource(this.stream);
      this.source.connect(this.processor);
      // The worklet outputs silence; connecting it keeps capture active in browsers.
      this.processor.connect(this.context.destination);
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  stop(): void {
    this.stopped = true;
    this.source?.disconnect();
    this.processor?.disconnect();
    if (this.processor) { this.processor.port.onmessage = null; this.processor.port.close(); }
    this.stream?.getTracks().forEach(track => track.stop());
    if (this.context?.state !== 'closed') void this.context?.close().catch(() => undefined);
  }
}
