import { AnthropicProvider } from './adapters/anthropic.ts';
import { GeminiProvider } from './adapters/gemini.ts';
import { OpenAiProvider } from './adapters/openai.ts';
import type { AiProvider } from './providers.ts';
import type { LLMProvider, ProviderOptions } from './types.ts';

const FACTORIES: Record<AiProvider, (options: ProviderOptions) => LLMProvider> = {
  openai: (options) => new OpenAiProvider(options),
  anthropic: (options) => new AnthropicProvider(options),
  gemini: (options) => new GeminiProvider(options),
};

/** The only place that maps a provider id to an adapter. Callers depend on `LLMProvider` alone. */
export function createProvider(provider: AiProvider, options: ProviderOptions): LLMProvider {
  if (!options.apiKey) throw new Error(`createProvider(${provider}): apiKey is required`);
  if (!options.model) throw new Error(`createProvider(${provider}): model is required`);
  return FACTORIES[provider](options);
}
