import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/services/latency.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } }).outputText;
const { LatencyTracker, LATENCY_METRICS, durationFor, averageFor, speechEndFromTicks, CapturedAudioClock } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const options = { text: 'Hallo', source: 'voice', model: 'test', provider: 'groq', tts: 'suisse', dialect: 'basel', audioEnabled: true };

test('main latency includes silence endpointing/STT delay, LLM, TTS and audible playback', () => {
  let records;
  const tracker = new LatencyTracker(value => { records = value; });
  const id = tracker.begin(options, 1505, { speechEnd: 1000, transcript: 1500 });
  tracker.mark(id, 'request', 1510);
  tracker.mark(id, 'firstToken', 1710);
  tracker.mark(id, 'ttsText', 1720);
  tracker.mark(id, 'firstAudio', 2000);
  tracker.mark(id, 'playback', 2100, 'output-clock');
  assert.equal(durationFor(records[0], LATENCY_METRICS[0]), 1100);
  assert.equal(durationFor(records[0], LATENCY_METRICS.find(metric => metric.id === 'stt')), 500);
  assert.equal(durationFor(records[0], LATENCY_METRICS.find(metric => metric.id === 'ttft')), 200);
  assert.equal(records[0].outputTiming, 'output-clock');
  assert.equal(records[0].status, 'measured');
  tracker.mark(id, 'playback', 99999);
  assert.equal(records[0].steps.playback, 2100, 'only the first onset counts');
});

test('averages use per-metric sample counts, exclude canceled/errors and never mix typing into speech pauses', () => {
  let records;
  const tracker = new LatencyTracker(value => { records = value; });
  const first = tracker.begin(options, 100, { speechEnd: 0, transcript: 100 });
  tracker.mark(first, 'playback', 1000);
  const second = tracker.begin(options, 1500, { speechEnd: 1000, transcript: 1500 });
  tracker.mark(second, 'playback', 3000);
  const typed = tracker.begin({ ...options, source: 'text' }, 5000);
  tracker.mark(typed, 'playback', 9000);
  const failed = tracker.begin(options, 10000, { speechEnd: 9500, transcript: 10000 });
  tracker.mark(failed, 'playback', 12000);
  tracker.fail(failed);
  const canceled = tracker.begin(options, 13000, { speechEnd: 12000, transcript: 13000 });
  tracker.cancelActive();
  tracker.mark(canceled, 'playback', 99999);
  assert.deepEqual(averageFor(records, LATENCY_METRICS[0]), { value: 1500, count: 2 });
  assert.equal(averageFor(records, LATENCY_METRICS[1]).count, 3);
  assert.equal(durationFor(records[2], LATENCY_METRICS[0]), undefined);
});

test('reset ignores callbacks from prior responses and IDs remain unique', () => {
  let records;
  const tracker = new LatencyTracker(value => { records = value; });
  const old = tracker.begin(options, 100);
  tracker.reset();
  const next = tracker.begin(options, 200);
  tracker.mark(old, 'playback', 999);
  assert.notEqual(old, next);
  assert.equal(records.length, 1);
  assert.equal(records[0].steps.playback, undefined);
});

test('audio-off and all-silent replies do not invent primary latency values', () => {
  let records;
  const tracker = new LatencyTracker(value => { records = value; });
  const off = tracker.begin({ ...options, audioEnabled: false }, 10);
  tracker.endText(off);
  const silent = tracker.begin(options, 20);
  tracker.silent(silent);
  assert.equal(records[0].status, 'text-only');
  assert.equal(records[1].status, 'silent');
  assert.deepEqual(averageFor(records, LATENCY_METRICS[0]), { value: undefined, count: 0 });
});

test('Azure ticks map to the capture clock; invalid/missing timestamps stay unavailable', () => {
  assert.equal(speechEndFromTicks(1000, 20000000, 5000000, 4000), 3500);
  assert.equal(speechEndFromTicks(undefined, 20000000, 5000000, 4000), undefined);
  assert.equal(speechEndFromTicks(1000, 20000000, 5000000, 2000), undefined);
  assert.equal(speechEndFromTicks(1000, NaN, 5000000, 4000), undefined);
  assert.equal(speechEndFromTicks(1000, 0, 0, 4000), undefined);
});

test('negative phase intervals are omitted rather than clamped to misleading zero', () => {
  const record = { ...options, id: 1, status: 'pending', steps: { request: 100, firstToken: 50 } };
  assert.equal(durationFor(record, LATENCY_METRICS.find(metric => metric.id === 'ttft')), undefined);
});

test('speech end follows its own capture packet across clock pauses without accumulating drift', () => {
  const clock = new CapturedAudioClock();
  clock.add(320, 1000);
  clock.add(320, 1020);
  clock.add(320, 5000); // Audio context was suspended for several seconds.
  assert.equal(clock.speechEnd(0, 400000, 6000), 1040, 'end at a packet boundary belongs to the preceding packet');
  assert.equal(clock.speechEnd(400000, 100000, 6000), 5010);
  assert.equal(clock.speechEnd(1000000, 100000, 6000), undefined, 'unknown sample positions remain unavailable');
});

for (const rate of [16000, 48000]) {
  test(`microphone worklet emits continuous 16 kHz PCM and capture timestamps at ${rate} Hz`, () => {
    const packets = [];
    let Processor;
    const context = vm.createContext({
      AudioWorkletProcessor: class { port = { postMessage: packet => packets.push(packet) }; },
      registerProcessor(_name, constructor) { Processor = constructor; },
      currentFrame: 0, sampleRate: rate, Int16Array
    });
    vm.runInContext(readFileSync(new URL('../src/services/audio/microphone-capture.worklet.js', import.meta.url), 'utf8'), context);
    const processor = new Processor();
    const totalFrames = rate * 0.04;
    for (let frame = 0; frame < totalFrames; frame += 128) {
      context.currentFrame = frame;
      processor.process([[new Float32Array(Math.min(128, totalFrames - frame)).fill(0.5)]]);
    }
    assert.equal(packets.length, 2);
    assert.equal(packets[0].audioTime, 0);
    assert(Math.abs(packets[1].audioTime - 0.02) < 1 / rate);
    for (const packet of packets) {
      assert.equal(packet.pcm.byteLength, 640);
      for (const sample of new Int16Array(packet.pcm)) assert.equal(sample, 16384);
    }
  });
}
