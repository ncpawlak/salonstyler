import { validityLabel } from '@chairside/core/forms';
import { router } from 'expo-router';
import { View } from 'react-native';

import { DetailScreen } from '@/components/shell/screen';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Icon,
  ListGroup,
  ListRow,
  SectionHeader,
  SkeletonRow,
  Text,
} from '@/components/ui';
import { errorMessage } from '@/features/appointments/api';
import {
  useFormTemplates,
  useInstallStarterForms,
  useServiceFormRequirements,
} from '@/features/forms/api';
import { useCurrentSalon } from '@/providers/session-provider';

const STARTER_KEYS = ['new_client_intake', 'color_consent'];

/** Settings → Forms: the salon's intake and consent forms, and which visits ask for them. */
export default function FormsSettingsScreen() {
  const salon = useCurrentSalon();
  const isOwner = salon.role === 'owner';
  const templates = useFormTemplates(salon.id);
  const requirements = useServiceFormRequirements(salon.id);
  const install = useInstallStarterForms(salon.id);

  const list = templates.data ?? [];
  const missingStarters = STARTER_KEYS.some((k) => !list.some((t) => t.starter_key === k));
  const serviceCount = (id: string) =>
    (requirements.data ?? []).filter((r) => r.template_id === id).length;

  return (
    <DetailScreen title="Forms">
      {templates.isPending ? (
        <View className="gap-3">
          <SkeletonRow />
          <SkeletonRow />
        </View>
      ) : templates.error ? (
        <EmptyState
          icon="cloud-offline-outline"
          title="Couldn't load forms"
          message={errorMessage(templates.error)}
          actionLabel="Try again"
          onAction={() => void templates.refetch()}
        />
      ) : (
        <View className="gap-1">
          <Card className="flex-row items-center gap-3">
            <Icon name="document-text-outline" color="primary" />
            <Text variant="footnote" tone="muted" className="flex-1">
              Clients fill out and sign these on their phone before the visit. Require a form on a
              service (e.g. Color Consent on color) or ask every new client. The link goes out with
              the booking confirmation, and signed forms land on the client’s profile.
            </Text>
          </Card>
          {!isOwner ? (
            <Text variant="footnote" tone="warning" className="px-1 pt-2">
              Only the salon owner can change forms.
            </Text>
          ) : null}

          <SectionHeader
            title="Your forms"
            action={
              isOwner ? (
                <Button
                  variant="ghost"
                  size="sm"
                  icon="add"
                  label="New form"
                  onPress={() => router.push('/settings/forms/new')}
                />
              ) : undefined
            }
          />
          {list.length === 0 ? (
            <Text variant="subhead" tone="muted" className="px-1">
              No forms yet.
            </Text>
          ) : (
            <ListGroup>
              {list.map((t, i) => {
                const services = serviceCount(t.id);
                const asks = [
                  services ? `${services} service${services === 1 ? '' : 's'}` : null,
                  t.ask_new_clients ? 'new clients' : null,
                ].filter(Boolean);
                return (
                  <ListRow
                    key={t.id}
                    title={t.name}
                    subtitle={`${t.fields.length} questions · ${validityLabel(t.valid_days)}${
                      asks.length ? ` · Asked of ${asks.join(' and ')}` : ''
                    }`}
                    trailing={
                      asks.length ? <Badge label="On" tone="success" /> : <Badge label="Off" />
                    }
                    chevron
                    onPress={() => router.push(`/settings/forms/${t.id}`)}
                    last={i === list.length - 1}
                  />
                );
              })}
            </ListGroup>
          )}

          {isOwner && missingStarters ? (
            <View className="pt-3">
              <Button
                variant="outline"
                icon="sparkles-outline"
                label="Add starter forms"
                loading={install.isPending}
                onPress={() => install.mutate()}
              />
              <Text variant="footnote" tone="muted" className="px-1 pt-2">
                New Client Intake and Color Consent / Patch Test, ready to edit.
              </Text>
            </View>
          ) : null}
          {install.error ? (
            <Text variant="footnote" tone="destructive" className="px-1 pt-2">
              {errorMessage(install.error)}
            </Text>
          ) : null}
        </View>
      )}
    </DetailScreen>
  );
}
