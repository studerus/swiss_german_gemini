import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import { SpeechConfig, PropertyId } from 'microsoft-cognitiveservices-speech-sdk';

// Exercise the actual app callbacks with deferred state updates, as in React.
const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const callbacks = {};
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'handleSend') callbacks.send = node.initializer;
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'initializeRecognizer') callbacks.initialize = node.initializer;
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'handleSpeechSilenceTimeoutChange') callbacks.silenceTimeout = node.initializer.arguments[0];
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'releaseMicrophone') callbacks.release = node.initializer;
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'stopListening') callbacks.stop = node.initializer;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    const name = node.left.getText(ast);
    for (const event of ['recognizing', 'recognized', 'canceled']) {
      if (name === `newRecognizer.${event}`) callbacks[event] = node.right;
    }
  }
  ts.forEachChild(node, visit);
}
visit(ast);
function bind(node, dependencies) {
  assert(node, 'App callback must exist');
  const compiled = ts.transpileModule(`const callback = ${node.getText(ast)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext }
  }).outputText;
  return new Function(...Object.keys(dependencies), `${compiled}\nreturn callback;`)(...Object.values(dependencies));
}

test('microphone restarts configure Azure with the latest silence setting through stable callbacks', async () => {
  const configs = [];
  const timeoutRef = { current: 500 };
  let displayedTimeout = 500;
  const dependencies = {
    SPEECH_KEY: 'offline-key', SPEECH_REGION: 'switzerlandnorth',
    sttProviderRef: { current: 'azure' },
    setSttError() {}, setIsListening() {}, setRecognitionText() {}, isRecognizingRef: { current: false },
    speechSilenceTimeoutMsRef: timeoutRef,
    setSpeechSilenceTimeoutMs(value) { displayedTimeout = value; },
    microphoneGenerationRef: { current: 0 }, recognizer: { current: null },
    microphoneCaptureRef: {}, microphoneInputRef: {},
    releaseMicrophone() {}, startListening() {},
    MicrophoneCapture: class { async start() {} stop() {} },
    speechsdk: {
      SpeechConfig, PropertyId,
      AudioInputStream: { createPushStream: () => ({ write() {}, close() {} }) },
      AudioStreamFormat: { getWaveFormatPCM: () => ({}) },
      AudioConfig: { fromStreamInput: () => ({}) },
      SpeechRecognizer: class {
        constructor(config) { configs.push(config); }
        stopContinuousRecognitionAsync(done) { done(); }
        close() {}
      }
    },
    console: { error(...args) { assert.fail(args.join(' ')); }, warn() {} }
  };
  const initialize = bind(callbacks.initialize, dependencies);
  const change = bind(callbacks.silenceTimeout, dependencies);
  await initialize();
  assert.equal(configs[0].getProperty(PropertyId.Speech_SegmentationSilenceTimeoutMs), '500');
  for (const timeout of [350, 100, 5000, 500]) {
    change({}, timeout);
    assert.equal(displayedTimeout, timeout);
    await initialize();
    assert.equal(configs.at(-1).getProperty(PropertyId.Speech_SegmentationSilenceTimeoutMs), String(timeout));
    assert.equal(configs.at(-1).speechRecognitionLanguage, 'de-CH');
  }
});

function setup(history, overrides = {}) {
  let committed = [...history];
  let draft = '';
  const updates = [];
  const requests = [];
  const dependencies = {
    input: '', selectedProvider: 'groq', selectedModel: 'test-model', GROQ_API_KEY: 'offline-key',
    selectedReasoningLevel: undefined, REASONING_LABELS: {}, getReasoningProviderOptions: () => undefined,
    GEMINI_API_KEY: '', OPENAI_API_KEY: '',
    messagesRef: { current: committed },
    ttsGenerationRef: { current: 0 }, ttsProviderNameRef: { current: 'suisse' },
    isSpeechEnabledRef: { current: false }, isPlayingAudioRef: { current: false },
    firstSentenceTimeRef: { current: null }, startTimeRef: { current: 0 },
    nextSequenceNumberRef: { current: 0 }, isRecognizingRef: { current: false },
    selectedDialectRef: { current: 'basel' },
    microphoneGenerationRef: { current: 0 }, generation: 0, capture: undefined,
    speechEndFromTicks: () => undefined, sendMessageRef: {},
    latency: { begin: () => 1, mark() {}, endText() {}, fail() {}, silent() {} },
    modelSettings: { systemPrompt: 'Be concise.', maxTokens: 500, temperature: 0.7 },
    suisseSpeech: { stop() {}, appendText() {}, finish() {} },
    setTtsError() {}, setSttError() {}, setInput() {}, setIsLoading() {}, setIsListening() {}, setIsRecognizing() {},
    setRecognitionText(text) { draft = text; },
    setMessages(update) { updates.push(update); },
    stopSpeech() { dependencies.ttsGenerationRef.current++; },
    getModelInstance: () => ({}),
    streamText(options) {
      requests.push(structuredClone(options.messages));
      return { textStream: (async function* () {})() };
    },
    speechsdk: { ResultReason: { RecognizedSpeech: 'recognized' } },
    console: { log() {}, error() {} },
    ...overrides
  };
  dependencies.handleSend = bind(callbacks.send, dependencies);
  dependencies.sendMessageRef.current = dependencies.handleSend;
  dependencies.releaseMicrophone = () => {};
  return {
    dependencies,
    recognizing: bind(callbacks.recognizing, dependencies),
    recognized: bind(callbacks.recognized, dependencies),
    canceled: bind(callbacks.canceled, dependencies),
    requests,
    flush() {
      for (const update of updates.splice(0)) committed = typeof update === 'function' ? update(committed) : update;
      dependencies.messagesRef.current = committed;
    },
    get messages() { return committed; },
    get draft() { return draft; }
  };
}

test('interim microphone results stay out of model history and final input is sent once', async () => {
  const history = [{ text: 'Sali, wie geht es dir?', isUser: true }, { text: 'Mir geht es ausgezeichnet.', isUser: false }];
  const app = setup(history);
  app.recognizing(null, { result: { text: 'Mir geht es' } });
  app.flush();
  app.recognizing(null, { result: { text: 'Mir geht es ausgezeichnet.' } });
  app.flush();
  assert.equal(app.draft, 'Mir geht es ausgezeichnet.');
  assert.deepEqual(app.messages, history);
  await app.recognized(null, { result: { reason: 'recognized', text: 'Mir geht es ausgezeichnet.' } });
  app.flush();
  assert.equal(app.draft, '');
  assert.deepEqual(app.requests, [[
    { role: 'user', content: history[0].text },
    { role: 'assistant', content: history[1].text },
    { role: 'user', content: 'Mir geht es ausgezeichnet.' }
  ]]);
  assert.equal(app.messages.filter(message => message.isUser && message.text === 'Mir geht es ausgezeichnet.').length, 1);
});

test('failed or canceled recognition preserves the last committed user message', async () => {
  const history = [{ text: 'Diese Nachricht muss bleiben.', isUser: true }];
  const app = setup(history);
  app.recognizing(null, { result: { text: 'Entwurf' } });
  await app.recognized(null, { result: { reason: 'no-match', text: '' } });
  app.flush();
  assert.deepEqual(app.messages, history);
  assert.equal(app.draft, '');
  app.recognizing(null, { result: { text: 'Neuer Entwurf' } });
  app.canceled(null, { errorDetails: 'test cancellation' });
  app.flush();
  assert.deepEqual(app.messages, history);
  assert.equal(app.draft, '');
  assert.equal(app.requests.length, 0);
});

test('a final result without interim events preserves history, including intentional repetitions', async () => {
  const history = [{ text: 'Noch einmal.', isUser: true }];
  const app = setup(history);
  await app.recognized(null, { result: { reason: 'recognized', text: 'Noch einmal.' } });
  app.flush();
  assert.deepEqual(app.requests, [[{ role: 'user', content: 'Noch einmal.' }, { role: 'user', content: 'Noch einmal.' }]]);
  assert.equal(app.messages.filter(message => message.isUser).length, 2);
});

test('each spoken answer uses the latest Suisse Speech speed and style settings', async () => {
  const starts = [];
  const app = setup([], {
    isSpeechEnabledRef: { current: true }, suisseVoiceRef: { current: 'andrin' },
    suisseSpeedRef: { current: 1.15 }, suisseStyleRef: { current: 'warm und deutlich' },
    suisseSpeech: { stop() {}, start(options) { starts.push(options); }, appendText() {}, finish() {} }
  });
  await app.dependencies.handleSend('Hallo.');
  assert.equal(starts[0].voice, 'andrin');
  assert.equal(starts[0].speed, 1.15);
  assert.equal(starts[0].style, 'warm und deutlich');
  app.dependencies.suisseSpeedRef.current = 0.9;
  app.dependencies.suisseStyleRef.current = '';
  await app.dependencies.handleSend('Noch einmal.');
  assert.equal(starts[1].speed, 0.9);
  assert.equal(starts[1].style, '');
});

test('Suisse Speech streams microphone PCM without Azure keys, displays drafts and sends one finalized turn', async () => {
  let stream, capture, listening = false, error;
  const timing = { speechEnd: 100, transcript: 600, provider: 'suisse', speechEndMethod: 'vad' };
  let recordedTiming;
  const app = setup([{ text: 'Vorheriger Beitrag.', isUser: true }], {
    SPEECH_KEY: '', SPEECH_REGION: '', sttProviderRef: { current: 'suisse' },
    speechSilenceTimeoutMsRef: { current: 500 },
    suisseRecognizerRef: { current: null }, microphoneCaptureRef: { current: null }, microphoneInputRef: { current: null },
    recognizer: { current: null },
    setIsListening(value) { listening = value; }, setSttError(value) { error = value; },
    SuisseSpeechSTTProvider: class {
      constructor() { stream = this; }
      async start(options) { this.options = options; }
      appendAudio(pcm, at) { this.audio = { pcm, at }; }
      stop() { this.stopped = true; }
    },
    MicrophoneCapture: class {
      constructor(onPCM) { capture = this; this.onPCM = onPCM; }
      async start() { this.started = true; }
      stop() { this.stopped = true; }
    },
    latency: { begin(_options, _at, inputTiming) { recordedTiming = inputTiming; return 1; }, mark() {}, endText() {}, fail() {}, silent() {} }
  });
  const dependencies = app.dependencies;
  dependencies.releaseMicrophone = bind(callbacks.release, dependencies);
  const initialize = bind(callbacks.initialize, dependencies);
  await initialize();
  assert.equal(listening, true);
  assert.equal(error, null);
  assert.equal(capture.started, true);
  assert.equal(stream.options.silenceTimeoutMs, 500);
  const pcm = new ArrayBuffer(640);
  capture.onPCM(pcm, 123);
  assert.deepEqual(stream.audio, { pcm, at: 123 });
  stream.options.onPartial('Sali');
  app.flush();
  assert.equal(app.draft, 'Sali');
  assert.equal(app.requests.length, 0);
  stream.options.onFinal('Sali, Hans.', timing);
  await Promise.resolve();
  app.flush();
  assert.deepEqual(app.requests, [[{ role: 'user', content: 'Vorheriger Beitrag.' }, { role: 'user', content: 'Sali, Hans.' }]]);
  assert.equal(app.draft, '');
  assert.deepEqual(recordedTiming, timing);

  const lateFinal = stream.options.onFinal;
  bind(callbacks.stop, dependencies)();
  assert.equal(stream.stopped, true);
  assert.equal(capture.stopped, true);
  assert.equal(listening, false);
  lateFinal('Darf nicht gesendet werden.', timing);
  assert.equal(app.requests.length, 1);

  await initialize();
  stream.options.onError(new Error('STT-Verbindung verloren.'));
  assert.equal(stream.stopped, true);
  assert.equal(capture.stopped, true);
  assert.equal(listening, false);
  assert.equal(error, 'STT-Verbindung verloren.');
});

test('canceling while Suisse Speech connects never starts a microphone afterward', async () => {
  let connected, stopped = false, microphoneStarts = 0;
  const dependencies = {
    microphoneGenerationRef: { current: 0 }, sttProviderRef: { current: 'suisse' },
    suisseRecognizerRef: {}, recognizer: { current: null }, speechSilenceTimeoutMsRef: { current: 500 },
    setSttError() {}, setIsListening() {}, setRecognitionText() {}, isRecognizingRef: {}, releaseMicrophone() {},
    SuisseSpeechSTTProvider: class {
      start() { return new Promise(resolve => { connected = resolve; }); }
      stop() { stopped = true; }
    },
    MicrophoneCapture: class { async start() { microphoneStarts++; } },
    console: { error(...args) { assert.fail(args.join(' ')); } }
  };
  const pending = bind(callbacks.initialize, dependencies)();
  dependencies.microphoneGenerationRef.current++;
  connected();
  await pending;
  assert.equal(stopped, true);
  assert.equal(microphoneStarts, 0);
});
