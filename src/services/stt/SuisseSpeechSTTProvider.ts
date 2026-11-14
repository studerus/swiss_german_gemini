import type { VoiceInputTiming } from '../latency';

interface StreamOptions {
  silenceTimeoutMs: number;
  onPartial: (text: string) => void;
  onFinal: (text: string, timing: VoiceInputTiming) => void;
  onError: (error: Error) => void;
}

/** One PCM16/16 kHz socket per microphone session, with one commit per user turn.
 * https://suisse-speech.ch/docs/speech-to-text/#voice-bots-finalize-at-once
 */
export class SuisseSpeechSTTProvider {
  private socket: WebSocket | null = null;
  private options?: StreamOptions;
  private ready = false;
  private resolveStart?: () => void;
  private rejectStart?: (error: Error) => void;
  private timeout?: ReturnType<typeof setTimeout>;
  private commitTimeout?: ReturnType<typeof setTimeout>;
  private finals: string[] = [];
  private partial = '';
  private lastAudioEnd = 0;
  private lastActivity = 0;
  private speechEnd?: number;
  private voicedMs = 0;
  private active = false;
  private pendingCommit?: { speechEnd?: number };
  private queuedCommit?: { speechEnd?: number };
  private noiseFloor = 0.0005;

  start(options: StreamOptions): Promise<void> {
    this.stop();
    this.options = options;
    return new Promise<void>((resolve, reject) => {
      this.resolveStart = resolve;
      this.rejectStart = reject;
      try {
        const url = new URL('/api/suisse-speech/stt/stream', window.location.href);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        const socket = new WebSocket(url);
        this.socket = socket;
        socket.onopen = () => {
          if (this.socket !== socket) return;
          socket.send(JSON.stringify({
            type: 'config', lang: 'de-CH', finalize_mode: 'immediate',
            finalize_ack: true, status_interval_ms: 5000
          }));
        };
        socket.onmessage = event => {
          if (this.socket !== socket) return;
          try {
            this.receive(JSON.parse(event.data));
          } catch (error) {
            this.fail(error instanceof Error ? error : new Error('Ungültige Antwort der Spracherkennung.'));
          }
        };
        socket.onerror = () => {
          if (this.socket === socket) this.fail(new Error('Suisse Speech ist nicht erreichbar. Bitte API-Schlüssel und Verbindung prüfen.'));
        };
        socket.onclose = () => {
          if (this.socket === socket) this.fail(new Error('Die Verbindung zur Suisse-Speech-Spracherkennung wurde beendet.'));
        };
        this.resetTimeout(10000);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error('Die Spracherkennung konnte nicht gestartet werden.'));
      }
    });
  }

  /** Called at microphone pace, after session.ready; at is the first sample's time. */
  appendAudio(pcm: ArrayBuffer, at: number): void {
    const socket = this.socket;
    if (!socket || !this.ready) return;
    if (socket.bufferedAmount > 64000) {
      this.fail(new Error('Die Verbindung zur Spracherkennung ist zu langsam. Bitte Mikrofon neu starten.'));
      return;
    }
    try {
      socket.send(pcm);
      this.detectPause(pcm, at);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error('Mikrofonaudio konnte nicht gesendet werden.'));
    }
  }

  stop(): void {
    clearTimeout(this.timeout);
    clearTimeout(this.commitTimeout);
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      if (this.ready && socket.readyState === WebSocket.OPEN) {
        try { socket.send(JSON.stringify({ type: 'audio.end' })); } catch { /* Already disconnected. */ }
      }
      socket.close();
    }
    this.rejectStart?.(new Error('Mikrofonstart abgebrochen.'));
    this.resolveStart = this.rejectStart = undefined;
    this.options = undefined;
    this.ready = false;
    this.finals = [];
    this.partial = '';
    this.lastAudioEnd = this.lastActivity = this.voicedMs = 0;
    this.speechEnd = undefined;
    this.active = false;
    this.pendingCommit = this.queuedCommit = undefined;
    this.noiseFloor = 0.0005;
  }

  private receive(frame: Record<string, unknown>): void {
    this.resetTimeout(this.ready ? 20000 : 10000);
    switch (frame.type) {
      case 'session.ready':
        if (frame.finalize_ack !== true || frame.finalize_mode !== 'immediate') {
          throw new Error('Suisse Speech unterstützt die angeforderte Redebeitrag-Erkennung nicht.');
        }
        this.ready = true;
        this.resetTimeout(20000);
        this.resolveStart?.();
        this.resolveStart = this.rejectStart = undefined;
        break;
      case 'transcript.partial':
        if (typeof frame.text !== 'string') throw new Error('Ungültiger Transkriptions-Zwischenstand.');
        this.noteText(frame.text);
        this.partial = frame.text;
        this.reportDraft();
        break;
      case 'transcript.final':
        if (typeof frame.text !== 'string') throw new Error('Ungültige finale Transkription.');
        this.noteText(frame.text);
        if (frame.text.trim()) this.finals.push(frame.text.trim());
        this.partial = '';
        this.reportDraft();
        break;
      case 'finalize.done': {
        if (!this.pendingCommit) break;
        clearTimeout(this.commitTimeout);
        const text = this.finals.join(' ');
        const timing: VoiceInputTiming = {
          speechEnd: this.pendingCommit.speechEnd, transcript: performance.now(),
          provider: 'suisse', speechEndMethod: 'vad'
        };
        this.finals = [];
        this.partial = '';
        this.pendingCommit = undefined;
        this.options?.onPartial('');
        if (text) this.options?.onFinal(text, timing);
        const queued = this.queuedCommit;
        this.queuedCommit = undefined;
        if (queued) this.commit(queued);
        break;
      }
      case 'session.status':
        if (frame.stalled === true) throw new Error('Die Suisse-Speech-Spracherkennung hängt. Bitte Mikrofon neu starten.');
        break;
      case 'error': {
        const detail = (frame.error && typeof frame.error === 'object' ? frame.error : frame) as Record<string, unknown>;
        throw new Error(`Suisse Speech: ${detail.message ?? 'Spracherkennung fehlgeschlagen.'}${detail.code ? ` (${detail.code})` : ''}`);
      }
      case 'session.complete':
        throw new Error('Die Suisse-Speech-Spracherkennung hat die Sitzung beendet. Bitte Mikrofon neu starten.');
    }
  }

  private reportDraft(): void {
    this.options?.onPartial([...this.finals, this.partial].filter(Boolean).join(' '));
  }

  private noteText(text: string): void {
    // Quiet speech can still be recognized below the local energy threshold.
    // In that case use text activity to commit, but leave speechEnd unmeasured.
    if (text.trim() && text !== this.partial && this.speechEnd === undefined && !this.pendingCommit) {
      this.active = true;
      this.speechEnd = undefined;
      this.lastActivity = this.lastAudioEnd;
    }
  }

  private detectPause(pcm: ArrayBuffer, at: number): void {
    const samples = new Int16Array(pcm);
    if (!samples.length || !Number.isFinite(at)) return;
    const duration = samples.length / 16;
    this.lastAudioEnd = at + duration;
    let energy = 0;
    for (const sample of samples) energy += (sample / 32768) ** 2;
    const rms = Math.sqrt(energy / samples.length);
    const threshold = Math.max(0.003162, this.noiseFloor * 3);
    if (rms >= threshold) {
      this.voicedMs += duration;
      if (this.voicedMs >= 60 || this.active) {
        this.active = true;
        this.speechEnd = this.lastAudioEnd;
        this.lastActivity = this.lastAudioEnd;
      }
    } else {
      this.voicedMs = 0;
      if (!this.active) this.noiseFloor = this.noiseFloor * 0.98 + rms * 0.02;
      if (this.active && this.lastAudioEnd - this.lastActivity >= this.options!.silenceTimeoutMs) {
        this.active = false;
        this.commit({ speechEnd: this.speechEnd });
        this.speechEnd = undefined;
      }
    }
  }

  private commit(turn: { speechEnd?: number }): void {
    if (this.pendingCommit) {
      this.queuedCommit = turn;
      return;
    }
    this.pendingCommit = turn;
    this.socket?.send(JSON.stringify({ type: 'finalize' }));
    this.commitTimeout = setTimeout(() => this.fail(new Error('Suisse Speech bestätigt den Redebeitrag nicht. Bitte Mikrofon neu starten.')), 10000);
  }

  private resetTimeout(ms: number): void {
    clearTimeout(this.timeout);
    this.timeout = setTimeout(() => this.fail(new Error('Die Suisse-Speech-Spracherkennung antwortet nicht mehr.')), ms);
  }

  private fail(error: Error): void {
    const onError = this.options?.onError;
    this.rejectStart?.(error);
    this.rejectStart = undefined;
    this.stop();
    onError?.(error);
  }
}
