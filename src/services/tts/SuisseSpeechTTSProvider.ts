export const SUISSE_SPEECH_VOICES = [
  'anna', 'vera', 'lea', 'nora', 'mia', 'elin',
  'stefan', 'reto', 'lukas', 'jonas', 'andrin', 'felix'
] as const;

export const SUISSE_SPEECH_DIALECTS: Record<string, string> = {
  Aargau: 'aargau', Bern: 'bern', Basel: 'basel',
  Graubünden: 'graubuenden', Luzern: 'luzern',
  'St. Gallen': 'stgallen', Valais: 'wallis', Zürich: 'zurich'
};

// https://suisse-speech.ch/docs/text-to-speech/#34-languages-and-dialects
export const SUISSE_SPEECH_DIALECT_OPTIONS = [
  { id: 'standard', name: 'Schweizerdeutsch (überregional)', verified: true },
  { id: 'zurich', name: 'Zürichdeutsch', verified: true },
  { id: 'bern', name: 'Berndeutsch', verified: true },
  { id: 'basel', name: 'Baseldeutsch', verified: true },
  { id: 'luzern', name: 'Luzernerdeutsch / Zentralschweiz', verified: true },
  { id: 'stgallen', name: 'St. Gallerdeutsch', verified: false },
  { id: 'thurgau', name: 'Thurgauerdeutsch', verified: false },
  { id: 'schaffhausen', name: 'Schaffhauserdeutsch', verified: false },
  { id: 'appenzell', name: 'Appenzellerdeutsch', verified: false },
  { id: 'glarus', name: 'Glarnerdeutsch', verified: false },
  { id: 'graubuenden', name: 'Graubündnerdeutsch', verified: false },
  { id: 'aargau', name: 'Aargauerdeutsch', verified: false },
  { id: 'solothurn', name: 'Solothurnerdeutsch', verified: false },
  { id: 'oberland', name: 'Berner Oberland', verified: false },
  { id: 'freiburg', name: 'Freiburgerdeutsch', verified: false },
  { id: 'wallis', name: 'Walliserdeutsch', verified: false },
  { id: 'zug', name: 'Zugerdeutsch', verified: false },
  { id: 'schwyz', name: 'Schwyzerdeutsch', verified: false },
  { id: 'uri', name: 'Urnerdeutsch', verified: false },
  { id: 'hochdeutsch', name: 'Schweizer Hochdeutsch', verified: false }
] as const;

export function resolveSuisseSpeechDialect(dialect: string): string {
  return SUISSE_SPEECH_DIALECTS[dialect] ??
    (SUISSE_SPEECH_DIALECT_OPTIONS.some(option => option.id === dialect) ? dialect : 'standard');
}

interface StreamOptions {
  dialect: string;
  voice: string;
  speed?: number;
  style?: string;
  onError: (error: Error) => void;
  onTiming?: (step: 'ttsOpen' | 'ttsReady' | 'ttsText' | 'firstAudio', at: number) => void;
  onPlaybackStart?: (at: number, method: 'output-clock' | 'estimated') => void;
  onComplete?: (hadAudibleSamples: boolean) => void;
}

/** Ignore leading silence; -50 dBFS over a 5 ms window is an audible-onset estimate. */
export function firstAudibleSample(samples: Float32Array, sampleRate: number): number | undefined {
  const window = Math.max(1, Math.round(sampleRate * 0.005));
  const threshold = 0.003162;
  for (let start = 0; start < samples.length; start += window) {
    const end = Math.min(samples.length, start + window);
    let energy = 0;
    for (let i = start; i < end; i++) energy += samples[i] * samples[i];
    if (Math.sqrt(energy / (end - start)) < threshold) continue;
    for (let i = start; i < end; i++) if (Math.abs(samples[i]) >= threshold) return i;
  }
}

/** A response streams over one socket; PCM frames play before synthesis finishes. */
export class SuisseSpeechTTSProvider {
  private socket: WebSocket | null = null;
  private context: AudioContext | null = null;
  private sources = new Set<AudioBufferSourceNode>();
  private options: StreamOptions | null = null;
  private pendingText: string[] = [];
  private ready = false;
  private ending = false;
  private completed = false;
  private startedPlayback = false;
  private playbackReported = false;
  private playbackAudioTime?: number;
  private playbackTimer: ReturnType<typeof setTimeout> | undefined;
  private receivedAudio = false;
  private sentText = false;
  private nextPlaybackTime = 0;
  private sampleRate = 24000;
  private trailingByte: number | null = null;
  private timeout: ReturnType<typeof setTimeout> | undefined;

  // Call from a click/key handler to unlock browser audio before microphone replies.
  async unlockAudio(): Promise<void> {
    if (!this.context || this.context.state === 'closed') {
      this.context = new AudioContext({ latencyHint: 'interactive' });
    }
    if (this.context.state === 'suspended') await this.context.resume();
  }

  start(options: StreamOptions): void {
    this.stop();
    this.options = options;
    const url = new URL('/api/suisse-speech/tts/stream', window.location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    try {
      const socket = new WebSocket(url);
      this.socket = socket;
      socket.binaryType = 'arraybuffer';
      void this.unlockAudio().catch(() => {
        if (this.socket === socket) this.fail('Die Audiowiedergabe konnte nicht gestartet werden.');
      });
      this.resetTimeout();
      socket.onopen = () => {
        if (this.socket !== socket) return;
        options.onTiming?.('ttsOpen', performance.now());
        socket.send(JSON.stringify({
          type: 'session.start', model: 'swift', voice: options.voice,
          language: 'de-CH', dialect: resolveSuisseSpeechDialect(options.dialect),
          speed: options.speed ?? 1, style: options.style?.trim() || undefined,
          format: 'pcm16', sample_rate_hz: 24000, transport: 'binary'
        }));
      };
      socket.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
        if (this.socket !== socket) return;
        this.resetTimeout();
        try {
          if (event.data instanceof ArrayBuffer) {
            this.reportFirstAudio();
            this.playPCM(new Uint8Array(event.data));
            return;
          }
          const frame = JSON.parse(event.data);
          switch (frame.type) {
            case 'session.ready':
              if (frame.encoding !== 'pcm16' || !Number.isInteger(frame.sample_rate_hz) ||
                  frame.sample_rate_hz < 8000 || frame.sample_rate_hz > 48000) {
                throw new Error('Suisse Speech hat ein unerwartetes Audioformat geliefert.');
              }
              this.sampleRate = frame.sample_rate_hz;
              this.ready = true;
              options.onTiming?.('ttsReady', performance.now());
              for (const text of this.pendingText) this.sendText(text);
              this.pendingText = [];
              if (this.ending) this.endSession();
              break;
            case 'audio.chunk': {
              this.reportFirstAudio();
              // Also accept the documented JSON transport if the server uses it.
              const bytes = Uint8Array.from(atob(frame.data), character => character.charCodeAt(0));
              this.playPCM(bytes);
              break;
            }
            case 'session.complete':
              if (this.trailingByte !== null) throw new Error('Der Audiostream ist unvollständig.');
              this.completed = true;
              clearTimeout(this.timeout);
              socket.close(1000);
              this.notifyComplete();
              break;
            case 'error': {
              const error = frame.error ?? frame;
              this.fail(`Suisse Speech: ${error.message ?? 'Sprachausgabe fehlgeschlagen.'}${error.code ? ` (${error.code})` : ''}`);
              break;
            }
          }
        } catch (error) {
          this.fail(error instanceof Error ? error.message : 'Ungültige Antwort von Suisse Speech.');
        }
      };
      socket.onerror = () => {
        if (this.socket === socket) {
          this.fail('Suisse Speech ist nicht erreichbar. Bitte API-Schlüssel und Verbindung prüfen.');
        }
      };
      socket.onclose = () => {
        if (this.socket !== socket) return;
        if (!this.completed) this.fail('Die Verbindung zu Suisse Speech wurde vorzeitig beendet.');
      };
    } catch (error) {
      this.fail(error instanceof Error ? error.message : 'Suisse Speech konnte nicht gestartet werden.');
    }
  }

  appendText(text: string): void {
    if (!this.socket || this.ending || !text) return;
    if (this.ready) this.sendText(text);
    else this.pendingText.push(text);
  }

  finish(): void {
    if (!this.socket || this.ending) return;
    this.ending = true;
    if (this.ready) this.endSession();
  }

  stop(): void {
    clearTimeout(this.timeout);
    clearTimeout(this.playbackTimer);
    const socket = this.socket;
    this.socket = null; // Ignore events from a cancelled response.
    socket?.close();
    for (const source of this.sources) {
      source.onended = null;
      source.stop();
      source.disconnect();
    }
    this.sources.clear();
    this.options = null;
    this.pendingText = [];
    this.ready = false;
    this.ending = false;
    this.completed = false;
    this.startedPlayback = false;
    this.playbackReported = false;
    this.playbackAudioTime = undefined;
    this.receivedAudio = false;
    this.sentText = false;
    this.nextPlaybackTime = 0;
    this.trailingByte = null;
  }

  dispose(): void {
    this.stop();
    void this.context?.close().catch(() => undefined);
    this.context = null;
  }

  private sendText(text: string): void {
    this.socket?.send(JSON.stringify({ type: 'text.append', text }));
    if (!this.sentText) {
      this.sentText = true;
      this.options?.onTiming?.('ttsText', performance.now());
    }
  }

  private reportFirstAudio(): void {
    if (this.receivedAudio) return;
    this.receivedAudio = true;
    this.options?.onTiming?.('firstAudio', performance.now());
  }

  private endSession(): void {
    this.socket?.send(JSON.stringify({ type: 'text.flush' }));
    this.socket?.send(JSON.stringify({ type: 'session.end' }));
  }

  private playPCM(bytes: Uint8Array): void {
    if (!this.context || !this.ready || this.completed) throw new Error('Unerwartetes Audiopaket.');
    // Preserve a split 16-bit sample across WebSocket message boundaries.
    if (this.trailingByte !== null) {
      const joined = new Uint8Array(bytes.length + 1);
      joined[0] = this.trailingByte;
      joined.set(bytes, 1);
      bytes = joined;
    }
    this.trailingByte = bytes.length % 2 ? bytes[bytes.length - 1] : null;
    const samples = Math.floor(bytes.length / 2);
    if (!samples) return;
    const buffer = this.context.createBuffer(1, samples, this.sampleRate);
    const channel = buffer.getChannelData(0);
    const view = new DataView(bytes.buffer, bytes.byteOffset, samples * 2);
    for (let i = 0; i < samples; i++) channel[i] = view.getInt16(i * 2, true) / 32768;
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    this.sources.add(source);
    source.onended = () => {
      source.disconnect();
      this.sources.delete(source);
      this.notifyComplete();
    };
    // A 25 ms lead absorbs scheduling jitter without buffering the whole sentence.
    const startAt = Math.max(this.context.currentTime + 0.025, this.nextPlaybackTime);
    source.start(startAt);
    this.nextPlaybackTime = startAt + buffer.duration;
    if (!this.startedPlayback) {
      const audibleSample = firstAudibleSample(channel, this.sampleRate);
      if (audibleSample !== undefined) {
        this.startedPlayback = true;
        this.playbackAudioTime = startAt + audibleSample / this.sampleRate;
        this.checkPlayback();
      }
    }
  }

  private checkPlayback = (): void => {
    const context = this.context;
    if (!context || !this.options || this.playbackAudioTime === undefined || this.playbackReported) return;
    const now = performance.now();
    const timestamp = context.getOutputTimestamp?.();
    const hasOutputClock = timestamp?.contextTime !== undefined && timestamp.contextTime > 0 &&
      timestamp.performanceTime !== undefined && timestamp.performanceTime > 0;
    const outputDelay = (context.baseLatency || 0) + (context.outputLatency || 0);
    const at = hasOutputClock
      ? timestamp.performanceTime! + (this.playbackAudioTime - timestamp.contextTime!) * 1000
      : now + (this.playbackAudioTime + outputDelay - context.currentTime) * 1000;
    const reached = hasOutputClock ? timestamp.contextTime! >= this.playbackAudioTime :
      context.currentTime >= this.playbackAudioTime + outputDelay;
    if (context.state !== 'running' || !reached || at > now) {
      this.playbackTimer = setTimeout(this.checkPlayback, 10);
      return;
    }
    this.playbackReported = true;
    this.options.onPlaybackStart?.(at, hasOutputClock ? 'output-clock' : 'estimated');
    this.notifyComplete();
  };

  private resetTimeout(): void {
    clearTimeout(this.timeout);
    this.timeout = setTimeout(() => this.fail('Suisse Speech antwortet nicht mehr.'), 30000);
  }

  private notifyComplete(): void {
    if (!this.completed || this.sources.size) return;
    if (this.startedPlayback && !this.playbackReported) return;
    const options = this.options;
    this.options = null;
    options?.onComplete?.(this.startedPlayback);
  }

  private fail(message: string): void {
    const options = this.options;
    this.stop();
    options?.onError(new Error(message));
  }
}
