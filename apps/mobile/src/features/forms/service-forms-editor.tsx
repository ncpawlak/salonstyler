import { router } from 'expo-router';
import { Switch, View } from 'react-native';

import { Button, Card, SectionHeader, Text } from '@/components/ui';
import { errorMessage } from '@/features/appointments/api';
import { useCurrentSalon } from '@/providers/session-provider';

import { useFormTemplates, useServiceFormRequirements, useSetServiceFormRequired } from './api';

/**
 * Service editor → Forms: which forms clients must sign before this service (e.g. Color Consent on
 * color). Each toggle saves on its own, apart from the service menu save.
 */
export function ServiceFormsEditor({
  serviceId,
  canEdit,
}: {
  serviceId: string;
  canEdit: boolean;
}) {
  const salon = useCurrentSalon();
  const templates = useFormTemplates(salon.id);
  const requirements = useServiceFormRequirements(salon.id);
  const set = useSetServiceFormRequired(salon.id);

  if (!templates.data || !requirements.data) return null;
  const required = new Set(
    requirements.data.filter((r) => r.service_id === serviceId).map((r) => r.template_id),
  );

  return (
    <>
      <SectionHeader title="Forms" />
      <Card className="gap-3" testID="service-forms">
        {templates.data.length === 0 ? (
          <Text variant="footnote" tone="muted">
            No forms yet. Add intake and consent forms in Settings → Forms.
          </Text>
        ) : (
          templates.data.map((t) => (
            <View key={t.id} className="flex-row items-center justify-between gap-3">
              <View className="flex-1">
                <Text variant="body">{t.name}</Text>
                <Text variant="footnote" tone="muted">
                  Clients sign before this service
                </Text>
              </View>
              <Switch
                accessibilityLabel={`Require ${t.name}`}
                value={required.has(t.id)}
                disabled={!canEdit || set.isPending}
                onValueChange={(v) => set.mutate({ serviceId, templateId: t.id, required: v })}
              />
            </View>
          ))
        )}
        {canEdit ? (
          <Button
            variant="ghost"
            size="sm"
            label="Manage forms"
            onPress={() => router.push('/settings/forms')}
          />
        ) : null}
        {set.error ? (
          <Text variant="footnote" tone="destructive">
            {errorMessage(set.error)}
          </Text>
        ) : null}
      </Card>
    </>
  );
}
