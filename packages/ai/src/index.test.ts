import { describe, expect, it } from 'vitest';
import { AI_PROVIDERS, isAiProvider } from './index';

describe('aiProviderSchema', () => {
  it('lists the supported providers', () => {
    expect(AI_PROVIDERS).toEqual(['openai', 'anthropic', 'gemini']);
  });

  it('accepts known providers and rejects others', () => {
    expect(isAiProvider('anthropic')).toBe(true);
    expect(isAiProvider('mistral')).toBe(false);
    expect(isAiProvider(42)).toBe(false);
  });
});
