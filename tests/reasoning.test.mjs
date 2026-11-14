import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import { streamText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createGroq } from '@ai-sdk/groq';

const source = readFileSync(new URL('../src/services/reasoning.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } }).outputText;
const { getReasoningLevels, getDefaultReasoningLevel, resolveReasoningLevel, getReasoningProviderOptions } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const app = ts.createSourceFile('App.tsx', readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const constants = app.statements.filter(ts.isVariableStatement).filter(statement => statement.declarationList.declarations.some(declaration => ['DEFAULT_GROQ_MODEL', 'AVAILABLE_PROVIDERS'].includes(declaration.name.getText(app))));
const providers = new Function(ts.transpileModule(constants.map(node => node.getText(app)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText + '\nreturn AVAILABLE_PROVIDERS;')();

// Read the actual app's request settings so SDK serialization tests cover its mapping.
let requestSettings;
let reasoningOptionsDeclaration = '';
function findRequestSettings(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(app) === 'reasoningOptions') {
    reasoningOptionsDeclaration = `const ${node.getText(app)};`;
  }
  if (ts.isCallExpression(node) && node.expression.getText(app) === 'streamText') {
    requestSettings = node.arguments[0].properties.filter(property =>
      ['maxOutputTokens', 'providerOptions'].includes(property.name?.getText(app)));
  }
  ts.forEachChild(node, findRequestSettings);
}
findRequestSettings(app);
assert.equal(requestSettings?.length, 2);
const appRequestSettings = new Function('selectedProvider', 'selectedModel', 'selectedReasoningLevel', 'modelSettings', 'getReasoningProviderOptions',
  ts.transpileModule(`${reasoningOptionsDeclaration}\nconst settings = {${requestSettings.map(node => node.getText(app)).join(',')}};`,
    { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText + '\nreturn settings;');

test('the lowest documented effort is selected for each model family', () => {
  assert.equal(getDefaultReasoningLevel('openai', 'gpt-6-astra'), 'low');
  assert.equal(getDefaultReasoningLevel('openai', 'gpt-6.1-sol'), 'low');
  for (const model of ['gpt-6.1-terra', 'gpt-6-luna', 'gpt-6-sol', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
    assert.equal(getDefaultReasoningLevel('openai', model), 'none', model);
  }
  for (const model of ['gemini-4-carbon', 'gemini-4-argon', 'gemini-4-hydrogen', 'gemini-3.8-flash', 'gemini-3.1-pro-preview']) {
    assert.equal(getDefaultReasoningLevel('google', model), 'low', model);
  }
  for (const model of ['gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3-flash-preview']) {
    assert.equal(getDefaultReasoningLevel('google', model), 'minimal', model);
  }
  assert.equal(getDefaultReasoningLevel('groq', 'openai/gpt-oss-120b'), 'low');
  assert.equal(getDefaultReasoningLevel('groq', 'openai/gpt-oss-20b'), 'low');
  assert.equal(getDefaultReasoningLevel('groq', 'qwen/qwen3.8-27b'), 'none');
});

test('unsupported values fall back to the minimum; undocumented models send no reasoning parameter', () => {
  assert.equal(resolveReasoningLevel('openai', 'gpt-6-astra', 'none'), 'low');
  assert.equal(resolveReasoningLevel('google', 'gemini-3.8-flash', 'minimal'), 'low');
  assert.equal(resolveReasoningLevel('groq', 'openai/gpt-oss-20b', 'xhigh'), 'low');
  assert.deepEqual(getReasoningLevels('openai', 'chat-latest'), []);
  assert.equal(getReasoningProviderOptions('openai', 'chat-latest', 'high'), undefined);
  assert.equal(getReasoningProviderOptions('openai', 'openai/gpt-oss-20b', 'high'), undefined);
});

test('model and provider change callbacks reset any higher selection to the new minimum', () => {
  const callbacks = {};
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ['handleModelChange', 'handleProviderChange'].includes(node.name.getText(app))) {
      callbacks[node.name.getText(app)] = node.initializer.arguments[0];
    }
    ts.forEachChild(node, visit);
  }
  visit(app);
  for (const provider of providers) {
    let level = 'max';
    let selectedModel;
    const dependencies = {
      selectedProvider: provider.id, getDefaultReasoningLevel, AVAILABLE_PROVIDERS: providers,
      setSelectedModel(value) { selectedModel = value; }, setSelectedProvider() {}, setMessages() {}, stopSpeech() {},
      setReasoningLevel(value) { level = value; }
    };
    const bind = node => new Function(...Object.keys(dependencies), ts.transpileModule(`const callback = ${node.getText(app)};`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText + '\nreturn callback;')(...Object.values(dependencies));
    const changeModel = bind(callbacks.handleModelChange);
    for (const model of provider.models) {
      level = 'max';
      changeModel({ target: { value: model.id } });
      assert.equal(level, getDefaultReasoningLevel(provider.id, model.id) ?? 'low');
    }
    level = 'max';
    bind(callbacks.handleProviderChange)({ target: { value: provider.id } });
    assert.equal(selectedModel, { google: 'gemini-3.5-flash-lite', openai: 'chat-latest', groq: 'openai/gpt-oss-120b' }[provider.id]);
    assert.equal(level, getDefaultReasoningLevel(provider.id, provider.models[0].id) ?? 'low');
  }
});

test('all selectable efforts serialize through the real SDK adapters and preserve text-only streaming', async () => {
  let requests = 0;
  for (const provider of providers) {
    for (const model of provider.models) {
      const levels = getReasoningLevels(provider.id, model.id);
      for (const level of levels.length ? levels : [undefined]) {
        let body;
        const fetch = async (_url, init) => {
          body = JSON.parse(init.body);
          const event = provider.id === 'google'
            ? { candidates: [{ content: { role: 'model', parts: [{ text: 'thinking', thought: true }, { text: 'OK' }] }, finishReason: 'STOP', index: 0 }] }
            : { id: 'test', object: 'chat.completion.chunk', created: 1, model: model.id, choices: [{ index: 0, delta: { reasoning: 'thinking', content: 'OK' }, finish_reason: 'stop' }] };
          return new Response('data: ' + JSON.stringify(event) + '\n\n' + (provider.id === 'google' ? '' : 'data: [DONE]\n\n'), { headers: { 'Content-Type': 'text/event-stream' } });
        };
        const create = { openai: createOpenAI, google: createGoogleGenerativeAI, groq: createGroq }[provider.id];
        const client = create({ apiKey: 'offline-test', fetch });
        const instance = provider.id === 'openai' ? client.chat(model.id) : client(model.id);
        const result = streamText({ model: instance, instructions: 'Be concise.', prompt: 'Hello',
          ...appRequestSettings(provider.id, model.id, level, { maxTokens: 500 }, getReasoningProviderOptions), maxRetries: 0 });
        let text = '';
        for await (const chunk of result.textStream) text += chunk;
        assert.equal(text, 'OK', `${provider.id}/${model.id}/${level}`);
        if (provider.id === 'google') {
          assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, level);
          assert.equal(body.reasoning_effort, undefined);
        } else {
          assert.equal(body.reasoning_effort, level);
          if (provider.id === 'openai') {
            assert.equal(body.max_completion_tokens, 500, `${model.id} must use max_completion_tokens`);
            assert.equal('max_tokens' in body, false, `${model.id} must omit max_tokens`);
          } else {
            assert.equal(body.max_tokens, 500);
          }
          if (provider.id === 'groq') assert.equal(body.reasoning_format, model.id.startsWith('qwen/') ? 'hidden' : undefined);
        }
        requests++;
      }
    }
  }
  assert(requests > 70, 'cover every documented level for all listed models');
});
