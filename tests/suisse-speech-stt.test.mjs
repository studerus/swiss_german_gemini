import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, test } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../src/services/stt/SuisseSpeechSTTProvider.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } }).outputText;
const { SuisseSpeechSTTProvider } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

class MockSocket {
  static OPEN = 1;
  static instances = [];
  readyState = 0;
  bufferedAmount = 0;
  messages = [];
  constructor(url) { this.url = String(url); MockSocket.instances.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  send(data) {
    assert.equal(this.readyState, 1);
    this.messages.push(typeof data === 'string' ? JSON.parse(data) : data);
  }
  receive(frame) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  ready() { this.receive({ type: 'session.ready', finalize_mode: 'immediate', finalize_ack: true }); }
  close() { this.readyState = 3; this.onclose?.(); }
}

const originals = { WebSocket: globalThis.WebSocket, window: globalThis.window };
let provider;
afterEach(() => {
  provider?.stop();
  Object.assign(globalThis, originals);
  MockSocket.instances = [];
});

function setup(silenceTimeoutMs = 500) {
  Object.assign(globalThis, { WebSocket: MockSocket, window: { location: { href: 'https://localhost:5173/' } } });
  provider = new SuisseSpeechSTTProvider();
  const drafts = [], turns = [], errors = [];
  const ready = provider.start({ silenceTimeoutMs,
    onPartial: text => drafts.push(text), onFinal: (text, timing) => turns.push({ text, timing }),
    onError: error => errors.push(error.message) });
  const socket = MockSocket.instances.at(-1);
  let at = 0;
  return { socket, ready, drafts, turns, errors,
    audio(ms, amplitude = 0) {
      for (let elapsed = 0; elapsed < ms; elapsed += 20) {
        const pcm = new Int16Array(320).fill(amplitude);
        provider.appendAudio(pcm.buffer, at);
        at += 20;
      }
    }
  };
}

test('opens an authenticated same-origin streaming path and sends live binary PCM after readiness', async () => {
  const app = setup();
  assert.equal(app.socket.url, 'wss://localhost:5173/api/suisse-speech/stt/stream');
  app.socket.open();
  assert.deepEqual(app.socket.messages, [{ type: 'config', lang: 'de-CH', finalize_mode: 'immediate', finalize_ack: true, status_interval_ms: 5000 }]);
  app.audio(20, 1000);
  assert.equal(app.socket.messages.length, 1);
  app.socket.ready();
  await app.ready;
  app.audio(20, 1000);
  assert(app.socket.messages.at(-1) instanceof ArrayBuffer);
  assert.equal(app.socket.messages.at(-1).byteLength, 640);
  assert.deepEqual(new Int16Array(app.socket.messages.at(-1)), new Int16Array(320).fill(1000));
});

test('displays partial revisions while speaking, aggregates incremental finals and sends one complete turn', async () => {
  const app = setup();
  app.socket.open(); app.socket.ready(); await app.ready;
  app.audio(200, 1500);
  app.socket.receive({ type: 'transcript.partial', text: 'Sali, wie' });
  assert.equal(app.drafts.at(-1), 'Sali, wie');
  assert.equal(app.turns.length, 0, 'partials must never become LLM input');
  app.socket.receive({ type: 'transcript.final', text: 'Sali,' });
  app.socket.receive({ type: 'transcript.partial', text: 'wie geht es dir?' });
  assert.equal(app.drafts.at(-1), 'Sali, wie geht es dir?');
  app.audio(100, 1500);
  app.audio(480);
  assert.equal(app.socket.messages.filter(frame => frame.type === 'finalize').length, 0);
  app.audio(20);
  assert.equal(app.socket.messages.at(-1).type, 'finalize');
  app.socket.receive({ type: 'transcript.final', text: 'wie geht es dir?' });
  assert.equal(app.turns.length, 0, 'individual finals are not turn boundaries');
  app.socket.receive({ type: 'finalize.done', committed: true });
  assert.equal(app.turns.length, 1);
  assert.equal(app.turns[0].text, 'Sali, wie geht es dir?');
  assert.equal(app.turns[0].timing.speechEnd, 300);
  assert.equal(app.turns[0].timing.provider, 'suisse');
  assert.equal(app.turns[0].timing.speechEndMethod, 'vad');
  assert.equal(app.drafts.at(-1), '');
  app.socket.receive({ type: 'finalize.done', committed: true });
  assert.equal(app.turns.length, 1, 'duplicate acknowledgments cannot duplicate input');

  app.audio(100, 1500);
  app.socket.receive({ type: 'transcript.final', text: 'Ja.' });
  app.socket.receive({ type: 'transcript.final', text: 'Ja.' });
  app.audio(500);
  app.socket.receive({ type: 'finalize.done', committed: true });
  assert.equal(app.turns[1].text, 'Ja. Ja.', 'intentional repetitions must remain');
  assert.equal(MockSocket.instances.length, 1, 'keep the connection for subsequent turns');
});

test('respects the configured pause, ignores short noise, and does not answer empty commits', async () => {
  const app = setup(350);
  app.socket.open(); app.socket.ready(); await app.ready;
  app.audio(20, 1500); app.audio(1000);
  assert.equal(app.socket.messages.filter(frame => frame.type === 'finalize').length, 0);
  app.audio(100, 1500); app.audio(340);
  assert.equal(app.socket.messages.filter(frame => frame.type === 'finalize').length, 0);
  app.audio(20);
  assert.equal(app.socket.messages.at(-1).type, 'finalize');
  app.socket.receive({ type: 'finalize.done', committed: false });
  assert.equal(app.turns.length, 0);
});

test('quiet speech uses live text activity without inventing a speech-end timestamp', async () => {
  const app = setup();
  app.socket.open(); app.socket.ready(); await app.ready;
  app.audio(200);
  app.socket.receive({ type: 'transcript.partial', text: 'Leise' });
  app.audio(300);
  app.socket.receive({ type: 'transcript.partial', text: 'Leise gesprochen.' });
  app.audio(480);
  assert.equal(app.socket.messages.filter(frame => frame.type === 'finalize').length, 0);
  app.audio(20);
  app.socket.receive({ type: 'transcript.final', text: 'Leise gesprochen.' });
  app.socket.receive({ type: 'finalize.done', committed: true });
  assert.equal(app.turns[0].text, 'Leise gesprochen.');
  assert.equal(app.turns[0].timing.speechEnd, undefined);
});

test('cancellation discards drafts and late callbacks cannot trigger a response', async () => {
  const app = setup();
  app.socket.open(); app.socket.ready(); await app.ready;
  const lateMessage = app.socket.onmessage;
  app.socket.receive({ type: 'transcript.final', text: 'Abgebrochen.' });
  app.audio(100, 1500); app.audio(500);
  provider.stop();
  assert.equal(app.socket.messages.at(-1).type, 'audio.end');
  lateMessage({ data: JSON.stringify({ type: 'finalize.done', committed: true }) });
  assert.equal(app.turns.length, 0);
  assert.equal(app.errors.length, 0);
  assert.equal(app.socket.readyState, 3);
});

test('rejects incompatible handshakes and releases a startup canceled before readiness', async () => {
  const app = setup();
  app.socket.open();
  app.socket.receive({ type: 'session.ready', finalize_mode: 'pause' });
  await assert.rejects(app.ready, /Redebeitrag/);
  assert.equal(app.errors.length, 1);
  const next = setup();
  provider.stop();
  await assert.rejects(next.ready, /abgebrochen/);
  assert.equal(next.errors.length, 0);
});

test('reports server errors, stalled recognition, backpressure and lost connections once', async () => {
  for (const fail of [
    app => app.socket.receive({ type: 'error', error: { code: 'stt.invalid_request', message: 'Denied' } }),
    app => app.socket.receive({ type: 'session.status', stalled: true }),
    app => { app.socket.bufferedAmount = 64001; app.audio(20); },
    app => app.socket.onclose()
  ]) {
    const app = setup();
    app.socket.open(); app.socket.ready(); await app.ready;
    fail(app);
    assert.equal(app.errors.length, 1);
    assert.equal(app.socket.readyState, 3);
    assert.equal(app.turns.length, 0);
  }
});
