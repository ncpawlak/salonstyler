import { formatOverride, MAX_OVERRIDE_MINUTES } from '@chairside/core';
import type { ClientServiceOverrideRow, ClientVisit, ServiceMenu } from '@chairside/db';
import * as ImagePicker from 'expo-image-picker';
import { useMemo, useState } from 'react';
import { Image, Platform, Pressable, View } from 'react-native';

import {
  Badge,
  Button,
  Card,
  Chip,
  EmptyState,
  Input,
  ListGroup,
  ListRow,
  SectionHeader,
  SegmentedControl,
  Sheet,
  Text,
  type BadgeTone,
} from '@/components/ui';
import { haptics } from '@/lib/haptics';

import { errorMessage } from '../appointments/api';
import { formatDay } from '../appointments/format';
import { formatPrice } from '../services/data';
import {
  useAddClientFormula,
  useAddClientNote,
  useClientFormulas,
  useClientNotes,
  useClientOverrideRows,
  useClientPhotos,
  useDeleteClientFormula,
  useDeleteClientNote,
  useDeleteClientOverride,
  useDeleteClientPhoto,
  useSaveClientOverride,
  useUploadClientPhoto,
} from './api';
import { overrideSuggestions } from './suggestions';

const PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

function ErrorLine({ text }: { text: string | null }) {
  return text ? (
    <Text variant="footnote" tone="destructive">
      {text}
    </Text>
  ) : null;
}

// ---------------------------------------------------------------------------
// Duration overrides
// ---------------------------------------------------------------------------

function menuItems(menu: ServiceMenu) {
  return [...menu.services, ...menu.combos].filter((s) => !s.archivedAt);
}

export function OverridesSection({
  clientId,
  firstName,
  menu,
  visits,
}: {
  clientId: string;
  firstName: string;
  menu: ServiceMenu | undefined;
  visits: readonly ClientVisit[] | undefined;
}) {
  const rows = useClientOverrideRows(clientId);
  const save = useSaveClientOverride();
  const remove = useDeleteClientOverride();
  const [editing, setEditing] = useState<{ serviceId: string | null; delta: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const nameOf = (id: string) =>
    (menu ? menuItems(menu).find((s) => s.id === id)?.name : undefined) ?? 'Removed service';

  const suggestions = useMemo(
    () =>
      menu && visits && rows.data
        ? overrideSuggestions(
            menu,
            visits,
            rows.data.map((r) => ({ serviceId: r.service_id, deltaMinutes: r.delta_minutes })),
          )
        : [],
    [menu, visits, rows.data],
  );

  const apply = async (input: {
    serviceId: string;
    deltaMinutes: number;
    source: 'manual' | 'suggested';
  }) => {
    setError(null);
    try {
      await save.mutateAsync({ clientId, ...input });
      haptics.success();
      setEditing(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const existing = editing?.serviceId
    ? rows.data?.find((r) => r.service_id === editing.serviceId)
    : undefined;

  const del = async (row: ClientServiceOverrideRow) => {
    setError(null);
    try {
      await remove.mutateAsync(row.id);
      setEditing(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <View className="gap-2" testID="client-overrides">
      <SectionHeader
        title="Usual timing"
        action={
          <Button
            variant="ghost"
            size="sm"
            icon="add"
            label="Add"
            disabled={!menu}
            onPress={() => setEditing({ serviceId: null, delta: 15 })}
          />
        }
      />
      {suggestions.map((s) => (
        <Card key={s.serviceId} className="gap-2">
          <Text variant="subhead">
            {firstName}&apos;s last {s.visits} {s.serviceName.toLowerCase()} visits ran{' '}
            {formatOverride(s.deltaMinutes)}
            {s.currentDeltaMinutes ? ` (saved: ${formatOverride(s.currentDeltaMinutes)})` : ''}.
          </Text>
          <Button
            size="sm"
            variant="secondary"
            label={`Always book ${formatOverride(s.deltaMinutes)}`}
            loading={save.isPending}
            onPress={() =>
              void apply({
                serviceId: s.serviceId,
                deltaMinutes: s.deltaMinutes,
                source: 'suggested',
              })
            }
          />
        </Card>
      ))}
      {rows.data?.length ? (
        <ListGroup>
          {rows.data.map((row, i) => (
            <ListRow
              key={row.id}
              title={`${nameOf(row.service_id)} ${formatOverride(row.delta_minutes)}`}
              subtitle={row.note ?? 'Added automatically when you book this service'}
              last={i === rows.data.length - 1}
              onPress={() => setEditing({ serviceId: row.service_id, delta: row.delta_minutes })}
            />
          ))}
        </ListGroup>
      ) : rows.isFetched && !suggestions.length ? (
        <Text variant="footnote" tone="muted">
          Does {firstName} always take longer (or less) for a service? Save it once and every
          booking includes it.
        </Text>
      ) : null}
      <ErrorLine text={editing ? null : error} />

      <Sheet
        open={!!editing}
        onOpenChange={(open) => !open && setEditing(null)}
        title="Usual timing"
        subtitle={`Applied whenever ${firstName} books this service`}
      >
        {editing && menu ? (
          <View className="gap-4">
            <View className="flex-row flex-wrap gap-2">
              {menuItems(menu).map((s) => (
                <Chip
                  key={s.id}
                  label={s.name}
                  selected={editing.serviceId === s.id}
                  onPress={() => setEditing({ ...editing, serviceId: s.id })}
                />
              ))}
            </View>
            <View className="flex-row items-center justify-center gap-4">
              <Button
                variant="secondary"
                size="icon"
                icon="remove"
                accessibilityLabel="5 minutes less"
                disabled={editing.delta - 5 < -MAX_OVERRIDE_MINUTES}
                onPress={() => setEditing({ ...editing, delta: editing.delta - 5 })}
              />
              <Text variant="title2" numeric className="w-24 text-center">
                {editing.delta ? formatOverride(editing.delta) : '±0m'}
              </Text>
              <Button
                variant="secondary"
                size="icon"
                icon="add"
                accessibilityLabel="5 minutes more"
                disabled={editing.delta + 5 > MAX_OVERRIDE_MINUTES}
                onPress={() => setEditing({ ...editing, delta: editing.delta + 5 })}
              />
            </View>
            <ErrorLine text={error} />
            <Button
              label="Save"
              disabled={!editing.serviceId || editing.delta === 0}
              loading={save.isPending}
              onPress={() =>
                void apply({
                  serviceId: editing.serviceId!,
                  deltaMinutes: editing.delta,
                  source: 'manual',
                })
              }
            />
            {existing ? (
              <Button
                variant="ghost"
                icon="trash-outline"
                label="Remove"
                loading={remove.isPending}
                onPress={() => void del(existing)}
              />
            ) : null}
          </View>
        ) : null}
      </Sheet>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Color formulas
// ---------------------------------------------------------------------------

export function FormulasSection({ clientId }: { clientId: string }) {
  const formulas = useClientFormulas(clientId);
  const add = useAddClientFormula(clientId);
  const remove = useDeleteClientFormula();
  const [formula, setFormula] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    try {
      await add.mutateAsync({ formula });
      setFormula('');
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <View className="gap-2" testID="client-formulas">
      <SectionHeader title="Color formulas" />
      <View className="flex-row items-end gap-2">
        <View className="flex-1">
          <Input
            placeholder="e.g. 7N + 7G, 20vol, 35 min"
            value={formula}
            onChangeText={setFormula}
            accessibilityLabel="New formula"
            autoCorrect={false}
            onSubmitEditing={() => formula.trim() && void submit()}
          />
        </View>
        <Button
          size="icon"
          icon="add"
          accessibilityLabel="Save formula"
          disabled={!formula.trim()}
          loading={add.isPending}
          onPress={() => void submit()}
        />
      </View>
      <ErrorLine text={error} />
      {formulas.data?.length ? (
        <ListGroup>
          {formulas.data.map((f, i) => (
            <ListRow
              key={f.id}
              title={f.formula}
              subtitle={[formatLocalDate(f.visit_date), f.service_name, f.notes]
                .filter(Boolean)
                .join(' · ')}
              last={i === formulas.data.length - 1}
              trailing={
                <Button
                  variant="ghost"
                  size="icon"
                  icon="trash-outline"
                  accessibilityLabel="Delete formula"
                  onPress={() => remove.mutate(f.id)}
                />
              }
            />
          ))}
        </ListGroup>
      ) : null}
    </View>
  );
}

function formatLocalDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y!, m! - 1, d!).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

// ---------------------------------------------------------------------------
// Notes timeline
// ---------------------------------------------------------------------------

export function NotesSection({ clientId, timeZone }: { clientId: string; timeZone: string }) {
  const notes = useClientNotes(clientId);
  const add = useAddClientNote(clientId);
  const remove = useDeleteClientNote();
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    try {
      await add.mutateAsync(body);
      setBody('');
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <View className="gap-2" testID="client-notes">
      <SectionHeader title="Notes" />
      <View className="flex-row items-end gap-2">
        <View className="flex-1">
          <Input
            placeholder="Add a note (allergies, preferences, life events)"
            value={body}
            onChangeText={setBody}
            accessibilityLabel="New note"
            multiline
          />
        </View>
        <Button
          size="icon"
          icon="add"
          accessibilityLabel="Save note"
          disabled={!body.trim()}
          loading={add.isPending}
          onPress={() => void submit()}
        />
      </View>
      <ErrorLine text={error} />
      {notes.data?.length ? (
        <ListGroup>
          {notes.data.map((n, i) => (
            <ListRow
              key={n.id}
              title={n.body}
              subtitle={`${formatDay(Date.parse(n.created_at), timeZone)}${
                n.source === 'ai' ? ' · via Ask Chairside' : ''
              }`}
              last={i === notes.data.length - 1}
              trailing={
                <Button
                  variant="ghost"
                  size="icon"
                  icon="trash-outline"
                  accessibilityLabel="Delete note"
                  onPress={() => remove.mutate(n.id)}
                />
              }
            />
          ))}
        </ListGroup>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Photos (Supabase Storage, `client-photos` bucket)
// ---------------------------------------------------------------------------

type PhotoKind = 'before' | 'after' | 'other';
const KIND_OPTIONS = [
  { value: 'before', label: 'Before' },
  { value: 'after', label: 'After' },
  { value: 'other', label: 'Other' },
] as const;

export function PhotosSection({ clientId }: { clientId: string }) {
  const photos = useClientPhotos(clientId);
  const upload = useUploadClientPhoto(clientId);
  const remove = useDeleteClientPhoto();
  const [kind, setKind] = useState<PhotoKind>('after');
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const current = photos.data?.find((p) => p.id === viewing) ?? null;

  const pick = async () => {
    setError(null);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        quality: 0.8,
      });
      const asset = result.canceled ? null : result.assets[0];
      if (!asset) return;
      const contentType = asset.mimeType ?? asset.file?.type ?? 'image/jpeg';
      if (!PHOTO_TYPES.has(contentType)) {
        setError('Choose a JPEG, PNG, WebP or HEIC photo.');
        return;
      }
      const body =
        Platform.OS === 'web' && asset.file
          ? asset.file
          : await (await fetch(asset.uri)).arrayBuffer();
      await upload.mutateAsync({ body, contentType, kind });
      haptics.success();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed.');
    }
  };

  return (
    <View className="gap-2" testID="client-photos">
      <SectionHeader
        title="Photos"
        action={
          <Button
            variant="ghost"
            size="sm"
            icon="camera-outline"
            label="Add"
            loading={upload.isPending}
            onPress={() => void pick()}
          />
        }
      />
      <SegmentedControl
        options={KIND_OPTIONS}
        value={kind}
        onChange={setKind}
        accessibilityLabel="Photo type"
      />
      <ErrorLine text={error} />
      {photos.data?.length ? (
        <View className="flex-row flex-wrap gap-2">
          {photos.data.map((p) => (
            <Pressable
              key={p.id}
              accessibilityRole="imagebutton"
              accessibilityLabel={`${p.kind} photo${p.caption ? `: ${p.caption}` : ''}`}
              onPress={() => setViewing(p.id)}
              className="overflow-hidden rounded-lg bg-muted"
            >
              {p.url ? (
                <Image source={{ uri: p.url }} style={{ width: 104, height: 104 }} />
              ) : (
                <View style={{ width: 104, height: 104 }} />
              )}
              <View className="absolute bottom-1 left-1">
                <Badge label={p.kind} tone={p.kind === 'before' ? 'neutral' : 'primary'} />
              </View>
            </Pressable>
          ))}
        </View>
      ) : photos.isFetched ? (
        <Text variant="footnote" tone="muted">
          Before and after photos are private to your salon.
        </Text>
      ) : null}

      <Sheet open={!!current} onOpenChange={(open) => !open && setViewing(null)} title="Photo">
        {current ? (
          <View className="gap-3">
            {current.url ? (
              <Image
                source={{ uri: current.url }}
                style={{ width: '100%', aspectRatio: 1, borderRadius: 12 }}
                resizeMode="contain"
              />
            ) : null}
            <Button
              variant="destructive"
              icon="trash-outline"
              label="Delete photo"
              loading={remove.isPending}
              onPress={() =>
                remove.mutate(current, {
                  onSuccess: () => setViewing(null),
                  onError: (e) => setError(errorMessage(e)),
                })
              }
            />
          </View>
        ) : null}
      </Sheet>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Visit history
// ---------------------------------------------------------------------------

const STATUS: Record<ClientVisit['status'], { label: string; tone: BadgeTone }> = {
  held: { label: 'Held', tone: 'warning' },
  requested: { label: 'Requested', tone: 'warning' },
  confirmed: { label: 'Booked', tone: 'primary' },
  completed: { label: 'Done', tone: 'success' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  no_show: { label: 'No-show', tone: 'destructive' },
};

function paidCents(visit: ClientVisit): number {
  return visit.payments
    .filter((p) => ['succeeded', 'partially_refunded', 'refunded'].includes(p.status))
    .reduce((n, p) => n + p.amountCents - p.refundedCents, 0);
}

export function VisitsSection({
  visits,
  timeZone,
}: {
  visits: readonly ClientVisit[] | undefined;
  timeZone: string;
}) {
  return (
    <View className="gap-2" testID="client-visits">
      <SectionHeader title="Visits" />
      {visits?.length ? (
        <ListGroup>
          {visits.map((v, i) => {
            const paid = paidCents(v);
            const status = STATUS[v.status];
            return (
              <ListRow
                key={v.id}
                title={v.services.map((s) => s.name).join(' + ') || 'Appointment'}
                subtitle={[
                  formatDay(Date.parse(v.startsAt), timeZone),
                  v.priceCents != null ? formatPrice(v.priceCents) : null,
                  paid ? `paid ${formatPrice(paid)}` : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
                last={i === visits.length - 1}
                trailing={<Badge label={status.label} tone={status.tone} />}
              />
            );
          })}
        </ListGroup>
      ) : visits ? (
        <EmptyState icon="calendar-outline" title="No visits yet" message="Book their first one." />
      ) : null}
    </View>
  );
}
