import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const require = createRequire(import.meta.url);
function load(file, dependencies = {}) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled)(name => dependencies[name] ?? require(name), module, module.exports);
  return module.exports;
}
const latency = load('../src/services/latency.ts');
const { LatencyPanel } = load('../src/components/LatencyPanel.tsx', { '../services/latency': latency });
const base = { id: 1, text: 'Hallo, Hans.', source: 'voice', provider: 'groq', model: 'test-model', stt: 'suisse', speechEndMethod: 'vad', tts: 'suisse', dialect: 'basel', audioEnabled: true, status: 'measured', outputTiming: 'output-clock', steps: { speechEnd: 1000, transcript: 1500, send: 1505, request: 1510, firstToken: 1710, ttsText: 1720, firstAudio: 2000, playback: 2100 } };

test('panel renders an accessible collapsed summary, main average and individual phase tables', () => {
  const html = renderToStaticMarkup(createElement(LatencyPanel, { records: [base], onReset() {} }));
  assert.match(html, /Latenzmessung/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /1’100 ms/);
  assert.match(html, /n=1/);
  assert.match(html, /Latenzschritte Antwort 1/);
  assert.match(html, /Hallo, Hans\./);
  assert.match(html, /test-model/);
  assert.match(html, /STT: Suisse Speech/);
  assert.doesNotMatch(html, /NaN|Infinity/);
});

test('empty and typed-only panels display missing speech latency without a fabricated zero', () => {
  const empty = renderToStaticMarkup(createElement(LatencyPanel, { records: [], onReset() {} }));
  assert.match(empty, /n=0/);
  assert.match(empty, /nächste Antwort/);
  const typed = renderToStaticMarkup(createElement(LatencyPanel, { records: [{ ...base, source: 'text', steps: { send: 1000, playback: 2100 } }], onReset() {} }));
  assert.match(typed, /Ø Sprechpause — · n=0/);
});
