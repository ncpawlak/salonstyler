import {
  AI_PROVIDER_INFO,
  AI_PROVIDERS,
  type AiProvider,
  DEFAULT_MONTHLY_TOKEN_BUDGET,
  defaultModel,
} from '@chairside/ai';
import {
  deleteAiProviderConfig,
  getAiProviderConfig,
  getAiTokensUsedThisMonth,
  saveAiProviderConfig,
} from '@chairside/db';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Linking, View } from 'react-native';

import { DetailScreen } from '@/components/shell/screen';
import {
  Badge,
  Button,
  Card,
  Chip,
  EmptyState,
  Icon,
  Input,
  SectionHeader,
  SkeletonRow,
  Text,
} from '@/components/ui';
import { invokeAi } from '@/features/ai-settings/api';
import { supabase } from '@/lib/supabase';
import { useCurrentSalon } from '@/providers/session-provider';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function AiSettingsScreen() {
  const salon = useCurrentSalon();
  const salonId = salon.id;
  const isOwner = salon.role === 'owner';
  const queryClient = useQueryClient();

  const config = useQuery({
    queryKey: ['ai-config', salonId],
    queryFn: () => getAiProviderConfig(supabase, salonId),
  });
  const usage = useQuery({
    queryKey: ['ai-usage', salonId],
    queryFn: () => getAiTokensUsedThisMonth(supabase, salonId),
  });

  const [provider, setProvider] = useState<AiProvider>('openai');
  const [model, setModel] = useState(defaultModel('openai'));
  const [apiKey, setApiKey] = useState('');
  const [budget, setBudget] = useState(String(DEFAULT_MONTHLY_TOKEN_BUDGET));
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load the saved settings into the form whenever they change (adjust state during render).
  const [loadedConfig, setLoadedConfig] = useState(config.data);
  if (config.data && config.data !== loadedConfig) {
    setLoadedConfig(config.data);
    setProvider(config.data.provider);
    setModel(config.data.model);
    setBudget(String(config.data.monthly_token_budget));
  }

  const saved = config.data ?? null;
  const switchingProvider = !!saved && saved.provider !== provider;
  const needsKey = !saved || switchingProvider;
  const trimmedKey = apiKey.trim();
  const trimmedModel = model.trim();
  const budgetNumber = Number.parseInt(budget, 10);
  const budgetValid = Number.isSafeInteger(budgetNumber) && budgetNumber >= 0;
  const info = AI_PROVIDER_INFO[provider];
  const used = usage.data ?? 0;

  const showResult = (message: string | null, err: unknown = null) => {
    setNotice(message);
    setError(err ? errorMessage(err) : null);
  };

  const selectProvider = (next: AiProvider) => {
    setProvider(next);
    setModel(saved?.provider === next ? saved.model : defaultModel(next));
    showResult(null);
  };

  const test = useMutation({
    mutationFn: () =>
      invokeAi(supabase, {
        action: 'test',
        salonId,
        provider,
        model: trimmedModel,
        ...(trimmedKey ? { apiKey: trimmedKey } : {}),
      }),
    onSuccess: (r) => showResult(`Connected to ${r.model} in ${r.latencyMs} ms.`),
    onError: (e) => showResult(null, e),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['ai-usage', salonId] }),
  });

  const save = useMutation({
    mutationFn: () =>
      saveAiProviderConfig(supabase, {
        salonId,
        provider,
        model: trimmedModel,
        monthlyTokenBudget: budgetNumber,
        ...(trimmedKey ? { apiKey: trimmedKey } : {}),
      }),
    onSuccess: (data) => {
      setApiKey('');
      queryClient.setQueryData(['ai-config', salonId], data);
      showResult('Saved. Your key is stored encrypted and can’t be viewed again.');
    },
    onError: (e) => showResult(null, e),
  });

  const remove = useMutation({
    mutationFn: () => deleteAiProviderConfig(supabase, salonId),
    onSuccess: () => {
      setApiKey('');
      queryClient.setQueryData(['ai-config', salonId], null);
      showResult('AI settings removed and the key was deleted.');
    },
    onError: (e) => showResult(null, e),
  });

  const busy = test.isPending || save.isPending || remove.isPending;
  const canTest = isOwner && !!trimmedModel && (!needsKey || !!trimmedKey) && !busy;
  const canSave = canTest && budgetValid;

  return (
    <DetailScreen title="AI assistant">
      {config.isPending ? (
        <View className="gap-3">
          <SkeletonRow />
          <SkeletonRow />
        </View>
      ) : config.error ? (
        <EmptyState
          icon="cloud-offline-outline"
          title="Couldn't load AI settings"
          message={errorMessage(config.error)}
          actionLabel="Try again"
          onAction={() => void config.refetch()}
        />
      ) : (
        <View className="gap-1">
          <Card className="flex-row items-center gap-3">
            <Icon name="sparkles-outline" color="primary" />
            <View className="flex-1 gap-0.5">
              <Text variant="headline">Bring your own AI key</Text>
              <Text variant="footnote" tone="muted">
                Chairside uses your AI account to understand booking requests. The key is stored
                encrypted on the server and is never shown again after you save it.
              </Text>
            </View>
            {saved ? <Badge label="On" tone="success" /> : <Badge label="Off" />}
          </Card>
          {!isOwner ? (
            <Text variant="footnote" tone="warning" className="px-1 pt-2">
              Only the salon owner can change these.
            </Text>
          ) : null}

          <SectionHeader title="Provider" />
          <View className="flex-row flex-wrap gap-2">
            {AI_PROVIDERS.map((p) => (
              <Chip
                key={p}
                label={AI_PROVIDER_INFO[p].label}
                selected={p === provider}
                onPress={isOwner ? () => selectProvider(p) : undefined}
              />
            ))}
          </View>

          <SectionHeader title="Model" />
          <Input
            accessibilityLabel="Model"
            value={model}
            onChangeText={setModel}
            autoCapitalize="none"
            autoCorrect={false}
            editable={isOwner}
          />
          <View className="flex-row flex-wrap gap-2 pt-2">
            {info.models.map((m) => (
              <Chip
                key={m}
                label={m}
                selected={m === trimmedModel}
                onPress={isOwner ? () => setModel(m) : undefined}
              />
            ))}
          </View>

          <SectionHeader title="API key" />
          <Input
            accessibilityLabel="API key"
            icon="key-outline"
            value={apiKey}
            onChangeText={setApiKey}
            placeholder={
              saved && !switchingProvider
                ? `Saved key ${saved.key_hint}. Leave blank to keep it.`
                : info.keyPlaceholder
            }
            helper={
              switchingProvider ? `Paste a ${info.label} key to switch providers.` : undefined
            }
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            textContentType="none"
            editable={isOwner}
          />
          <Button
            variant="ghost"
            size="sm"
            iconRight="open-outline"
            label={`Get your ${info.label} API key`}
            accessibilityRole="link"
            onPress={() => void Linking.openURL(info.keyUrl)}
            className="px-1"
          />

          <SectionHeader title="Monthly token budget" />
          <Input
            accessibilityLabel="Monthly token budget"
            value={budget}
            onChangeText={(t) => setBudget(t.replace(/[^0-9]/g, ''))}
            keyboardType="number-pad"
            editable={isOwner}
            error={budgetValid ? undefined : 'Enter a whole number of tokens.'}
            helper={`Used this month: ${used.toLocaleString()}${
              saved ? ` of ${saved.monthly_token_budget.toLocaleString()}` : ''
            } tokens. Set 0 to turn AI off.`}
          />

          {notice ? (
            <Text
              variant="footnote"
              tone="success"
              className="px-1 pt-4"
              accessibilityLiveRegion="polite"
            >
              {notice}
            </Text>
          ) : null}
          {error ? (
            <Text
              variant="footnote"
              tone="destructive"
              className="px-1 pt-4"
              accessibilityLiveRegion="polite"
            >
              {error}
            </Text>
          ) : null}

          {isOwner ? (
            <View className="gap-3 pt-6">
              <Button
                variant="outline"
                icon="pulse-outline"
                label="Test connection"
                fullWidth
                loading={test.isPending}
                disabled={!canTest}
                onPress={() => test.mutate()}
              />
              <Button
                label="Save"
                fullWidth
                loading={save.isPending}
                disabled={!canSave}
                onPress={() => save.mutate()}
              />
              {saved ? (
                <Button
                  variant="destructive"
                  label="Remove AI settings"
                  icon="trash-outline"
                  fullWidth
                  loading={remove.isPending}
                  disabled={busy}
                  onPress={() => remove.mutate()}
                />
              ) : null}
            </View>
          ) : null}
        </View>
      )}
    </DetailScreen>
  );
}
