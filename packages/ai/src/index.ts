import { z } from 'zod';

/** LLM providers Chairside can call with the stylist's own API key. */
export const aiProviderSchema = z.enum(['openai', 'anthropic', 'gemini']);
export type AiProvider = z.infer<typeof aiProviderSchema>;

export const AI_PROVIDERS: readonly AiProvider[] = aiProviderSchema.options;

export function isAiProvider(value: unknown): value is AiProvider {
  return aiProviderSchema.safeParse(value).success;
}
