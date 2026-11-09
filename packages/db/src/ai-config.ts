import type { AiProviderConfig, AiProviderId, ChairsideClient } from './index.ts';

export async function getAiProviderConfig(
  client: ChairsideClient,
  salonId: string,
): Promise<AiProviderConfig | null> {
  const { data, error } = await client
    .from('ai_provider_config')
    .select('*')
    .eq('salon_id', salonId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export interface SaveAiProviderConfigInput {
  salonId: string;
  provider: AiProviderId;
  model: string;
  monthlyTokenBudget: number;
  /** Write-only. Omit to keep the saved key (required on first save and when switching provider). */
  apiKey?: string;
}

/** Owner-only. The key goes straight into Vault; the response contains only a masked hint. */
export async function saveAiProviderConfig(
  client: ChairsideClient,
  input: SaveAiProviderConfigInput,
): Promise<AiProviderConfig> {
  const { data, error } = await client.rpc('save_ai_provider_config', {
    p_salon_id: input.salonId,
    p_provider: input.provider,
    p_model: input.model,
    p_monthly_token_budget: input.monthlyTokenBudget,
    ...(input.apiKey ? { p_api_key: input.apiKey } : {}),
  });
  if (error) throw error;
  return data;
}

/** Owner-only. Removes the settings and destroys the stored key. */
export async function deleteAiProviderConfig(
  client: ChairsideClient,
  salonId: string,
): Promise<void> {
  const { error } = await client.rpc('delete_ai_provider_config', { p_salon_id: salonId });
  if (error) throw error;
}

/** Tokens used this calendar month (salon timezone), for budget display. */
export async function getAiTokensUsedThisMonth(
  client: ChairsideClient,
  salonId: string,
): Promise<number> {
  const { data, error } = await client.rpc('ai_tokens_used_this_month', { p_salon_id: salonId });
  if (error) throw error;
  return Number(data ?? 0);
}
