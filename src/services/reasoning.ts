export type ReasoningLevel = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const REASONING_LABELS: Record<ReasoningLevel, string> = {
  none: 'Aus (none)', minimal: 'Minimal', low: 'Niedrig', medium: 'Mittel',
  high: 'Hoch', xhigh: 'Sehr hoch', max: 'Maximum'
};

const LOW_HIGH = ['low', 'medium', 'high'] as const;
const MINIMAL_HIGH = ['minimal', 'low', 'medium', 'high'] as const;
const LOW_MAX = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const NONE_MAX = ['none', ...LOW_MAX] as const;

// Provider-specific documented values, ordered from least to most reasoning.
// https://developers.openai.com/api/docs/guides/latest-model
// https://aistudio.google.com/docs/thinking#thinking-levels
// https://console.groq.com/docs/reasoning
const MODEL_REASONING: Record<string, readonly ReasoningLevel[]> = {
  'openai:gpt-6-astra': LOW_MAX,
  'openai:gpt-6.1-sol': LOW_MAX,
  'openai:gpt-6.1-terra': NONE_MAX,
  'openai:gpt-6-luna': NONE_MAX,
  'openai:gpt-6-sol': NONE_MAX,
  'openai:gpt-5.6-sol': NONE_MAX,
  'openai:gpt-5.6-terra': NONE_MAX,
  'openai:gpt-5.6-luna': NONE_MAX,
  'google:gemini-4-carbon': LOW_HIGH,
  'google:gemini-4-argon': LOW_HIGH,
  'google:gemini-4-hydrogen': [...LOW_HIGH, 'xhigh'],
  'google:gemini-3.8-flash': LOW_HIGH,
  'google:gemini-3.6-flash': MINIMAL_HIGH,
  'google:gemini-3.5-flash-lite': MINIMAL_HIGH,
  'google:gemini-3.1-flash-lite': MINIMAL_HIGH,
  'google:gemini-3.1-pro-preview': LOW_HIGH,
  'google:gemini-3-flash-preview': MINIMAL_HIGH,
  'groq:openai/gpt-oss-120b': LOW_HIGH,
  'groq:openai/gpt-oss-20b': LOW_HIGH,
  'groq:qwen/qwen3.8-27b': ['none', ...LOW_HIGH]
};

export function getReasoningLevels(provider: string, model: string): readonly ReasoningLevel[] {
  return MODEL_REASONING[`${provider}:${model}`] ?? [];
}

export function getDefaultReasoningLevel(provider: string, model: string): ReasoningLevel | undefined {
  return getReasoningLevels(provider, model)[0];
}

export function resolveReasoningLevel(provider: string, model: string, requested?: string): ReasoningLevel | undefined {
  const levels = getReasoningLevels(provider, model);
  return levels.find(level => level === requested) ?? levels[0];
}

type ReasoningProviderOptions = Record<string, Record<string, string | { thinkingLevel: ReasoningLevel }>>;

export function getReasoningProviderOptions(provider: string, model: string, requested?: string): ReasoningProviderOptions | undefined {
  const level = resolveReasoningLevel(provider, model, requested);
  if (!level) return;
  const options: ReasoningProviderOptions = {};
  if (provider === 'google') options.google = { thinkingConfig: { thinkingLevel: level } };
  if (provider === 'openai') options.openai = { reasoningEffort: level };
  if (provider === 'groq') {
    options.groq = { reasoningEffort: level };
    // Qwen's raw format would place <think> blocks in the spoken answer.
    // GPT-OSS returns separate reasoning and rejects reasoning_format entirely.
    if (model === 'qwen/qwen3.8-27b') options.groq.reasoningFormat = 'hidden';
  }
  return options;
}
