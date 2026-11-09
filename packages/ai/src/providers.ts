import { z } from 'zod';

/** LLM providers Chairside can call with the stylist's own API key. */
export const aiProviderSchema = z.enum(['openai', 'anthropic', 'gemini']);
export type AiProvider = z.infer<typeof aiProviderSchema>;

export const AI_PROVIDERS: readonly AiProvider[] = aiProviderSchema.options;

export function isAiProvider(value: unknown): value is AiProvider {
  return aiProviderSchema.safeParse(value).success;
}

export interface AiProviderInfo {
  id: AiProvider;
  label: string;
  /** Suggested models (first = default). Any model id the provider accepts can be typed in. */
  models: readonly string[];
  keyPlaceholder: string;
  keyUrl: string;
}

export const AI_PROVIDER_INFO: Readonly<Record<AiProvider, AiProviderInfo>> = {
  openai: {
    id: 'openai',
    label: 'OpenAI (ChatGPT)',
    models: ['gpt-4.1-mini', 'gpt-4.1', 'gpt-4o-mini'],
    keyPlaceholder: 'sk-...',
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    models: ['claude-sonnet-4-5', 'claude-haiku-4-5'],
    keyPlaceholder: 'sk-ant-...',
    keyUrl: 'https://console.anthropic.com/settings/keys',
  },
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    models: ['gemini-2.5-flash', 'gemini-2.5-pro'],
    keyPlaceholder: 'AIza...',
    keyUrl: 'https://aistudio.google.com/apikey',
  },
};

export function defaultModel(provider: AiProvider): string {
  return AI_PROVIDER_INFO[provider].models[0]!;
}

/** Default monthly token budget per salon (input + output tokens). */
export const DEFAULT_MONTHLY_TOKEN_BUDGET = 1_000_000;
