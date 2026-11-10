import type { ClientRow } from '@chairside/db';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Linking, Switch, View } from 'react-native';

import { DetailScreen } from '@/components/shell/screen';
import {
  Avatar,
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Sheet,
  SkeletonRow,
  Text,
} from '@/components/ui';
import { errorMessage } from '@/features/appointments/api';
import { formatDay } from '@/features/appointments/format';
import {
  useClient,
  useClientSummary,
  useClientVisits,
  useUpdateClient,
} from '@/features/clients/api';
import {
  FormulasSection,
  NotesSection,
  OverridesSection,
  PhotosSection,
  VisitsSection,
} from '@/features/clients/sections';
import { ClientFormsSection } from '@/features/forms/client-forms-section';
import { formatPrice, useServiceMenu } from '@/features/services/data';
import { useCurrentSalon } from '@/providers/session-provider';
import { useTheme } from '@/theme/theme-provider';

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card className="flex-1 gap-1">
      <Text variant="footnote" tone="muted">
        {label}
      </Text>
      <Text variant="headline" numeric numberOfLines={1}>
        {value}
      </Text>
    </Card>
  );
}

export default function ClientProfileScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const salon = useCurrentSalon();
  const client = useClient(id);
  const summary = useClientSummary(id);
  const visits = useClientVisits(id);
  const menu = useServiceMenu();
  const [editing, setEditing] = useState(false);
  const tz = salon.timezone;

  if (client.isPending) {
    return (
      <DetailScreen title="Client">
        <SkeletonRow />
        <SkeletonRow />
      </DetailScreen>
    );
  }
  if (!client.data) {
    return (
      <DetailScreen title="Client">
        <EmptyState
          icon="person-outline"
          title={client.isError ? "Couldn't load client" : 'Client not found'}
          message={
            client.isError ? 'Check your connection and try again.' : 'They may have been deleted.'
          }
          actionLabel={client.isError ? 'Retry' : undefined}
          onAction={client.isError ? () => client.refetch() : undefined}
        />
      </DetailScreen>
    );
  }

  const c = client.data;
  const firstName = c.name.split(' ')[0] ?? c.name;
  const s = summary.data;
  const book = () =>
    router.navigate({
      pathname: '/',
      params: { bookClient: c.id, bookClientName: c.name, bookClientPhone: c.phone ?? '' },
    });

  return (
    <DetailScreen
      title={c.name}
      right={
        <Button
          variant="ghost"
          size="sm"
          label="Edit"
          accessibilityLabel="Edit client"
          onPress={() => setEditing(true)}
        />
      }
    >
      <View className="gap-6 pb-10" testID="client-profile">
        <Card className="items-center gap-2 py-5">
          <Avatar name={c.name} size={64} />
          <Text variant="title2">{c.name}</Text>
          {c.phone || c.email ? (
            <Text variant="subhead" tone="muted" numeric>
              {[c.phone, c.email].filter(Boolean).join(' · ')}
            </Text>
          ) : null}
          {c.tags.length || c.marketing_opt_in ? (
            <View className="flex-row flex-wrap justify-center gap-1.5">
              {c.tags.map((t) => (
                <Badge key={t} label={t} tone="primary" />
              ))}
              {c.marketing_opt_in ? <Badge label="Marketing OK" /> : null}
            </View>
          ) : null}
          {c.notes ? (
            <Text variant="subhead" className="text-center">
              {c.notes}
            </Text>
          ) : null}
          <View className="mt-2 flex-row gap-3 self-stretch px-2">
            <Button grow icon="add" label={`Book ${firstName}`} onPress={book} />
            {c.phone ? (
              <Button
                grow
                variant="secondary"
                icon="call-outline"
                label="Call"
                onPress={() => void Linking.openURL(`tel:${c.phone!.replace(/[^\d+]/g, '')}`)}
              />
            ) : null}
          </View>
        </Card>

        <View className="gap-3">
          <View className="flex-row gap-3">
            <Stat label="Visits" value={String(s?.visit_count ?? 0)} />
            <Stat label="No-shows" value={String(s?.no_show_count ?? 0)} />
            <Stat label="Paid" value={formatPrice(s?.paid_cents ?? 0)} />
          </View>
          <View className="flex-row gap-3">
            <Stat
              label="Last visit"
              value={s?.last_visit_at ? formatDay(Date.parse(s.last_visit_at), tz) : '—'}
            />
            <Stat
              label="Next visit"
              value={s?.next_visit_at ? formatDay(Date.parse(s.next_visit_at), tz) : '—'}
            />
          </View>
        </View>

        <OverridesSection
          clientId={c.id}
          firstName={firstName}
          menu={menu.data}
          visits={visits.data}
        />
        <FormulasSection clientId={c.id} />
        <ClientFormsSection clientId={c.id} timeZone={tz} />
        <NotesSection clientId={c.id} timeZone={tz} />
        <PhotosSection clientId={c.id} />
        <VisitsSection visits={visits.data} timeZone={tz} />
      </View>

      <EditClientSheet client={c} open={editing} onOpenChange={setEditing} />
    </DetailScreen>
  );
}

function EditClientSheet({
  client,
  open,
  onOpenChange,
}: {
  client: ClientRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { colors } = useTheme();
  const update = useUpdateClient(client.id);
  const [form, setForm] = useState<{
    name: string;
    phone: string;
    email: string;
    notes: string;
    tags: string;
    marketingOptIn: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (open && !form) {
    setError(null);
    setForm({
      name: client.name,
      phone: client.phone ?? '',
      email: client.email ?? '',
      notes: client.notes ?? '',
      tags: client.tags.join(', '),
      marketingOptIn: client.marketing_opt_in,
    });
  } else if (!open && form) {
    setForm(null);
  }

  const save = async () => {
    if (!form) return;
    setError(null);
    try {
      await update.mutateAsync({ ...form, tags: form.tags.split(',') });
      onOpenChange(false);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Edit client">
      {form ? (
        <View className="gap-3">
          <Input
            label="Name"
            value={form.name}
            onChangeText={(name) => setForm({ ...form, name })}
          />
          <Input
            label="Phone"
            value={form.phone}
            keyboardType="phone-pad"
            onChangeText={(phone) => setForm({ ...form, phone })}
          />
          <Input
            label="Email"
            value={form.email}
            keyboardType="email-address"
            autoCapitalize="none"
            onChangeText={(email) => setForm({ ...form, email })}
          />
          <Input
            label="Tags"
            helper="Comma separated, e.g. VIP, sensitive scalp"
            value={form.tags}
            onChangeText={(tags) => setForm({ ...form, tags })}
          />
          <Input
            label="About"
            value={form.notes}
            multiline
            onChangeText={(notes) => setForm({ ...form, notes })}
          />
          <View className="min-h-tap flex-row items-center gap-3">
            <Text variant="body" className="flex-1">
              OK to send marketing
            </Text>
            <Switch
              accessibilityLabel="OK to send marketing"
              value={form.marketingOptIn}
              onValueChange={(marketingOptIn) => setForm({ ...form, marketingOptIn })}
              trackColor={{ true: colors.primary, false: colors.input }}
            />
          </View>
          {error ? (
            <Text variant="footnote" tone="destructive">
              {error}
            </Text>
          ) : null}
          <Button
            label="Save"
            disabled={!form.name.trim()}
            loading={update.isPending}
            onPress={() => void save()}
          />
        </View>
      ) : null}
    </Sheet>
  );
}
