export type LatencyStep = 'speechEnd' | 'transcript' | 'send' | 'request' | 'firstToken' | 'llmEnd' |
  'ttsConnect' | 'ttsOpen' | 'ttsReady' | 'ttsText' | 'firstAudio' | 'playback' |
  'translationStart' | 'translationEnd';
export type OutputTiming = 'output-clock' | 'estimated' | 'media-event';
export interface VoiceInputTiming {
  speechEnd?: number;
  transcript: number;
  provider?: 'azure' | 'suisse';
  speechEndMethod?: 'recognizer' | 'vad';
}
export interface LatencyRecord {
  id: number;
  text: string;
  source: 'voice' | 'text';
  model: string;
  reasoningLevel?: string;
  stt?: 'azure' | 'suisse';
  speechEndMethod?: VoiceInputTiming['speechEndMethod'];
  provider: string;
  tts: string;
  dialect: string;
  audioEnabled: boolean;
  status: 'pending' | 'measured' | 'cancelled' | 'error' | 'text-only' | 'silent';
  steps: Partial<Record<LatencyStep, number>>;
  outputTiming?: OutputTiming;
}

export const LATENCY_METRICS = [
  { id: 'voiceTotal', label: 'Sprachende → Antwortton', from: 'speechEnd', to: 'playback', voiceOnly: true },
  { id: 'sendAudio', label: 'Senden → Antwortton', from: 'send', to: 'playback' },
  { id: 'stt', label: 'Sprachende → finale Transkription', from: 'speechEnd', to: 'transcript', voiceOnly: true },
  { id: 'dispatch', label: 'Transkription → LLM-Anfrage', from: 'transcript', to: 'request', voiceOnly: true },
  { id: 'ttft', label: 'LLM-Anfrage → erstes Textstück', from: 'request', to: 'firstToken' },
  { id: 'textTts', label: 'Erstes Textstück → TTS-Text gesendet', from: 'firstToken', to: 'ttsText' },
  { id: 'translation', label: 'Dialektübersetzung (erster Satz)', from: 'translationStart', to: 'translationEnd' },
  { id: 'tts', label: 'TTS-Text gesendet → erstes Audio', from: 'ttsText', to: 'firstAudio' },
  { id: 'playback', label: 'Erstes Audio → Antwortton', from: 'firstAudio', to: 'playback' },
  { id: 'connection', label: 'TTS-Verbindung → bereit (parallel)', from: 'ttsConnect', to: 'ttsReady' },
  { id: 'llm', label: 'LLM-Anfrage → Text vollständig (parallel)', from: 'request', to: 'llmEnd' }
] as const;

export type LatencyMetric = typeof LATENCY_METRICS[number];

export function durationFor(record: LatencyRecord, metric: LatencyMetric): number | undefined {
  if ('voiceOnly' in metric && metric.voiceOnly && record.source !== 'voice') return;
  const from = record.steps[metric.from];
  const to = record.steps[metric.to];
  if (from === undefined || to === undefined || !Number.isFinite(to - from) || to < from) return;
  return to - from;
}

export function averageFor(records: LatencyRecord[], metric: LatencyMetric): { value?: number; count: number } {
  const values = records.filter(record => record.status !== 'cancelled' && record.status !== 'error')
    .map(record => durationFor(record, metric)).filter((value): value is number => value !== undefined);
  return { value: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined, count: values.length };
}

/** Monotonic IDs prevent late callbacks from contaminating new/reset measurements. */
export class LatencyTracker {
  private records: LatencyRecord[] = [];
  private nextId = 0;
  private activeId?: number;
  constructor(private readonly onChange: (records: LatencyRecord[]) => void) {}

  begin(options: Omit<LatencyRecord, 'id' | 'status' | 'steps'>, at: number, input?: VoiceInputTiming): number {
    this.cancelActive();
    const id = ++this.nextId;
    this.activeId = id;
    this.records = [...this.records, { ...options, stt: input?.provider, speechEndMethod: input?.speechEndMethod, id, status: 'pending', steps: {
      send: at, ...(input ? { transcript: input.transcript, speechEnd: input.speechEnd } : {})
    } }];
    this.onChange(this.records);
    return id;
  }

  mark(id: number, step: LatencyStep, at = performance.now(), outputTiming?: OutputTiming): void {
    const record = this.records.find(item => item.id === id);
    if (!record || record.steps[step] !== undefined || !Number.isFinite(at) ||
        record.status === 'cancelled' || record.status === 'error') return;
    this.update(id, { ...record, steps: { ...record.steps, [step]: at },
      ...(step === 'playback' ? { status: 'measured' as const, outputTiming } : {}) });
  }

  endText(id: number): void {
    this.mark(id, 'llmEnd');
    const record = this.records.find(item => item.id === id);
    if (record && !record.audioEnabled && record.status === 'pending') this.update(id, { ...record, status: 'text-only' });
  }

  fail(id: number): void {
    const record = this.records.find(item => item.id === id);
    if (record && record.status !== 'cancelled') this.update(id, { ...record, status: 'error' });
  }

  silent(id: number): void {
    const record = this.records.find(item => item.id === id);
    if (record?.status === 'pending') this.update(id, { ...record, status: 'silent' });
  }

  cancelActive(): void {
    const record = this.records.find(item => item.id === this.activeId);
    if (record?.status === 'pending') this.update(record.id, { ...record, status: 'cancelled' });
    this.activeId = undefined;
  }

  reset(): void { this.records = []; this.activeId = undefined; this.onChange(this.records); }

  private update(id: number, replacement: LatencyRecord): void {
    this.records = this.records.map(record => record.id === id ? replacement : record);
    this.onChange(this.records);
  }
}

/** Azure timestamps are 100 ns ticks; duration excludes leading/trailing silence. */
export function speechEndFromTicks(firstSampleAt: number | undefined, offset: number, duration: number, receivedAt: number): number | undefined {
  if (firstSampleAt === undefined || !Number.isFinite(offset) || !Number.isFinite(duration) || offset < 0 || duration <= 0) return;
  const end = firstSampleAt + (offset + duration) / 10000;
  if (Number.isFinite(end) && end >= firstSampleAt && end <= receivedAt) return end;
}

/** Map recent sample positions independently, so clock drift/suspension cannot accumulate. */
export class CapturedAudioClock {
  private samples = 0;
  private packets: Array<{ start: number; count: number; at: number }> = [];

  add(sampleCount: number, at: number): void {
    this.packets.push({ start: this.samples, count: sampleCount, at });
    this.samples += sampleCount;
    if (this.packets.length > 6000) this.packets.shift(); // Two minutes at 20 ms/packet.
  }

  speechEnd(offset: number, duration: number, receivedAt: number): number | undefined {
    if (!Number.isFinite(offset) || !Number.isFinite(duration) || offset < 0 || duration <= 0) return;
    const endSample = (offset + duration) * 16000 / 10000000;
    for (let i = this.packets.length - 1; i >= 0; i--) {
      const packet = this.packets[i];
      if (endSample > packet.start && endSample <= packet.start + packet.count) {
        return speechEndFromTicks(packet.at - packet.start / 16, offset, duration, receivedAt);
      }
    }
  }
}
