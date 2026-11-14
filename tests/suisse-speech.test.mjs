import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../src/services/tts/SuisseSpeechTTSProvider.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } }).outputText;
const { SuisseSpeechTTSProvider, SUISSE_SPEECH_DIALECTS, SUISSE_SPEECH_DIALECT_OPTIONS, resolveSuisseSpeechDialect, firstAudibleSample } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

class MockSocket {
  static instances = [];
  messages = [];
  closed = false;
  constructor(url) { this.url = String(url); MockSocket.instances.push(this); }
  send(text) { this.messages.push(JSON.parse(text)); }
  close() { this.closed = true; }
  open() { this.onopen?.(); }
  receive(frame) { this.onmessage?.({ data: frame instanceof ArrayBuffer ? frame : JSON.stringify(frame) }); }
  ready(rate = 24000) { this.receive({ type: 'session.ready', encoding: 'pcm16', sample_rate_hz: rate }); }
}

class MockAudioContext {
  static instances = [];
  state = 'running';
  currentTime = 10;
  destination = {};
  sources = [];
  constructor(options) { this.options = options; MockAudioContext.instances.push(this); }
  resume() { this.state = 'running'; return Promise.resolve(); }
  close() { this.state = 'closed'; return Promise.resolve(); }
  createBuffer(channels, samples, sampleRate) {
    assert.equal(channels, 1);
    const data = new Float32Array(samples);
    return { data, sampleRate, duration: samples / sampleRate, getChannelData: () => data };
  }
  createBufferSource() {
    const source = {
      connect() {}, disconnect() {},
      start(time) { this.startTime = time; },
      stop() { this.stopped = true; },
      end() { this.onended?.(); }
    };
    this.sources.push(source);
    return source;
  }
}

const originals = { WebSocket: globalThis.WebSocket, AudioContext: globalThis.AudioContext, window: globalThis.window };
let provider;
afterEach(() => {
  provider?.dispose();
  Object.assign(globalThis, originals);
  MockSocket.instances = [];
  MockAudioContext.instances = [];
});

function setup(dialect = 'Basel', settings = {}) {
  Object.assign(globalThis, { WebSocket: MockSocket, AudioContext: MockAudioContext, window: { location: { href: 'https://localhost:5173/' } } });
  provider = new SuisseSpeechTTSProvider();
  const errors = [];
  let completed = 0;
  let started = 0;
  const options = { dialect, voice: 'anna', ...settings, onError: error => errors.push(error.message), onComplete: () => completed++, onPlaybackStart: () => started++ };
  provider.start(options);
  const socket = MockSocket.instances.at(-1);
  const audio = MockAudioContext.instances.at(-1);
  return { socket, audio, errors, options, get completed() { return completed; }, get started() { return started; } };
}

test('buffers LLM tokens until ready, flushes the final fragment, uses the same-origin authenticated proxy', () => {
  const { socket } = setup();
  assert.equal(socket.url, 'wss://localhost:5173/api/suisse-speech/tts/stream');
  provider.appendText('Grüe');
  provider.appendText('zi.');
  provider.finish();
  socket.open();
  assert.deepEqual(socket.messages, [{ type: 'session.start', model: 'swift', voice: 'anna', language: 'de-CH', dialect: 'basel', speed: 1, format: 'pcm16', sample_rate_hz: 24000, transport: 'binary' }]);
  socket.ready();
  assert.deepEqual(socket.messages.slice(1), [{ type: 'text.append', text: 'Grüe' }, { type: 'text.append', text: 'zi.' }, { type: 'text.flush' }, { type: 'session.end' }]);
  provider.finish();
  provider.appendText('ignored');
  assert.equal(socket.messages.length, 5);
});

test('serializes speech speed and style at session start and omits an empty style', () => {
  const state = setup('Basel', { speed: 1.15, style: '  warm und deutlich  ' });
  state.socket.open();
  assert.equal(state.socket.messages[0].speed, 1.15);
  assert.equal(state.socket.messages[0].style, 'warm und deutlich');
  assert.equal(state.socket.messages[0].sample_rate_hz, 24000, 'tempo is applied by synthesis, preserving the PCM format');
  provider.start({ ...state.options, speed: 0.5, style: '   ' });
  const next = MockSocket.instances.at(-1);
  next.open();
  assert.equal(next.messages[0].speed, 0.5);
  assert.equal('style' in next.messages[0], false);
});

test('plays the first binary PCM frame before completion and schedules contiguous audio at the negotiated rate', async () => {
  const state = setup();
  state.socket.open();
  state.socket.ready(16000);
  state.socket.receive(new Uint8Array([0, 128, 255, 127]).buffer);
  assert.equal(state.started, 0, 'scheduling is not yet audible playback');
  assert.equal(state.completed, 0);
  const first = state.audio.sources[0];
  assert.deepEqual(Array.from(first.buffer.data), [-1, 32767 / 32768]);
  assert.equal(first.buffer.sampleRate, 16000);
  assert.equal(first.startTime, 10.025);
  state.audio.currentTime = 10.03;
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(state.started, 1);
  state.audio.currentTime = 10;
  state.socket.receive(new Uint8Array([0, 0]).buffer);
  assert.equal(state.audio.sources[1].startTime, first.startTime + first.buffer.duration);
  state.socket.receive({ type: 'session.complete' });
  assert.equal(state.completed, 0);
  for (const source of state.audio.sources) source.end();
  assert.equal(state.completed, 1);
  assert.deepEqual(state.errors, []);
});

test('ignores leading silence and reports the first audible sample using the output-device clock', async () => {
  const state = setup();
  let timing;
  provider.start({ ...state.options, onPlaybackStart: (at, method) => { timing = { at, method }; } });
  const socket = MockSocket.instances.at(-1);
  socket.open(); socket.ready();
  socket.receive(new Int16Array(480).buffer); // 20 ms silence.
  const samples = new Int16Array(480);
  samples.fill(5000, 240); // Another 10 ms before the first sound.
  socket.receive(samples.buffer);
  assert.equal(timing, undefined);
  const timestamp = { contextTime: 10.1, performanceTime: performance.now() };
  state.audio.currentTime = 10.1;
  state.audio.getOutputTimestamp = () => timestamp;
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(timing.method, 'output-clock');
  assert(Math.abs(timing.at - (timestamp.performanceTime + (10.055 - 10.1) * 1000)) < 0.01);
});

test('all-silent audio completes without fabricating an audible playback timestamp', () => {
  const state = setup();
  state.socket.open(); state.socket.ready();
  state.socket.receive(new Int16Array(480).buffer);
  state.socket.receive({ type: 'session.complete' });
  state.audio.sources[0].end();
  assert.equal(state.started, 0);
  assert.equal(state.completed, 1);
});

test('cancellation before scheduled playback prevents a latency sample', async () => {
  const state = setup();
  state.socket.open(); state.socket.ready();
  state.socket.receive(new Int16Array([10000, 10000]).buffer);
  provider.stop();
  state.audio.currentTime = 20;
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(state.started, 0);
});

test('fallback playback timing waits for reported device latency and a running audio context', async () => {
  const state = setup();
  state.audio.baseLatency = 0.02;
  state.audio.outputLatency = 0.03;
  state.socket.open(); state.socket.ready();
  state.socket.receive(new Int16Array([10000, 10000]).buffer);
  state.audio.currentTime = 10.04; // Scheduled sample reached, device output has not.
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(state.started, 0);
  state.audio.currentTime = 10.09;
  state.audio.state = 'suspended';
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(state.started, 0);
  state.audio.state = 'running';
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(state.started, 1);
});

test('audible-onset detector ignores silence and low-level noise', () => {
  assert.equal(firstAudibleSample(new Float32Array([0, 0.0001, -0.0001]), 24000), undefined);
  assert.equal(firstAudibleSample(new Float32Array([0, 0, 0.1, -0.1]), 24000), 2);
});

test('preserves split PCM16 samples and accepts JSON/base64 frames', () => {
  const state = setup();
  state.socket.open(); state.socket.ready();
  state.socket.receive(new Uint8Array([0]).buffer);
  assert.equal(state.audio.sources.length, 0);
  state.socket.receive({ type: 'audio.chunk', data: Buffer.from([128, 0, 0]).toString('base64') });
  assert.deepEqual(Array.from(state.audio.sources[0].buffer.data), [-1, 0]);
});

test('stop cancels scheduled playback and ignores late audio from a replaced response', () => {
  const state = setup();
  state.socket.open(); state.socket.ready();
  state.socket.receive(new Uint8Array([0, 0]).buffer);
  provider.start(state.options);
  assert.equal(state.socket.closed, true);
  assert.equal(state.audio.sources[0].stopped, true);
  state.socket.receive(new Uint8Array([0, 0]).buffer);
  state.socket.onclose();
  assert.equal(state.audio.sources.length, 1);
  assert.deepEqual(state.errors, []);
});

test('server errors stop playback and reach the UI callback once', () => {
  const state = setup();
  state.socket.open(); state.socket.ready();
  state.socket.receive(new Uint8Array([0, 0]).buffer);
  state.socket.receive({ type: 'error', error: { code: 'tts.capacity', message: 'Capacity exhausted' } });
  state.socket.onclose();
  assert.match(state.errors[0], /Capacity exhausted.*tts.capacity/);
  assert.equal(state.errors.length, 1);
  assert.equal(state.audio.sources[0].stopped, true);
});

test('reports a dropped connection instead of silently succeeding', () => {
  const state = setup();
  state.socket.onclose();
  assert.match(state.errors[0], /vorzeitig/);
});

test('rejects incomplete samples and unexpected formats', () => {
  const state = setup();
  state.socket.open(); state.socket.ready();
  state.socket.receive(new Uint8Array([0]).buffer);
  state.socket.receive({ type: 'session.complete' });
  assert.match(state.errors[0], /unvollständig/);
  provider.start(state.options);
  MockSocket.instances.at(-1).receive({ type: 'session.ready', encoding: 'mp3', sample_rate_hz: 24000 });
  assert.match(state.errors[1], /Audioformat/);
});

test('maps all eight existing app dialects to Suisse Speech dialect identifiers', () => {
  assert.deepEqual(SUISSE_SPEECH_DIALECTS, { Aargau: 'aargau', Bern: 'bern', Basel: 'basel', Graubünden: 'graubuenden', Luzern: 'luzern', 'St. Gallen': 'stgallen', Valais: 'wallis', Zürich: 'zurich' });
});

test('every Suisse Speech selector option reaches the API with its own native dialect identifier', () => {
  const state = setup();
  assert.equal(SUISSE_SPEECH_DIALECT_OPTIONS.length, 20);
  assert.equal(new Set(SUISSE_SPEECH_DIALECT_OPTIONS.map(option => option.id)).size, 20);
  assert.equal(SUISSE_SPEECH_DIALECT_OPTIONS.filter(option => option.verified).length, 5);
  for (const option of SUISSE_SPEECH_DIALECT_OPTIONS) {
    provider.start({ ...state.options, dialect: option.id });
    const socket = MockSocket.instances.at(-1);
    socket.open();
    assert.equal(socket.messages[0].dialect, option.id, option.name);
  }
});

test('normalizes shared dialects when switching providers and falls back only for unknown identifiers', () => {
  for (const [legacy, native] of Object.entries(SUISSE_SPEECH_DIALECTS)) {
    assert.equal(resolveSuisseSpeechDialect(legacy), native);
    assert.equal(resolveSuisseSpeechDialect(native), native);
  }
  assert.equal(resolveSuisseSpeechDialect('standard'), 'standard');
  assert.equal(resolveSuisseSpeechDialect('hochdeutsch'), 'hochdeutsch');
  assert.equal(resolveSuisseSpeechDialect('thurgau'), 'thurgau');
  assert.equal(resolveSuisseSpeechDialect('unknown'), 'standard');
});
