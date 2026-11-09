import {
  HAIR_LENGTH_VARIANTS,
  resolveService,
  SERVICE_COLOR_TAGS,
  STARTER_CATEGORIES,
  formatDuration,
  type ServiceDefinition,
  type ServiceSegment,
} from '@chairside/core';
import type { MenuService } from '@chairside/db/services';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, Switch, View } from 'react-native';

import { DetailScreen } from '@/components/shell/screen';
import {
  Button,
  Card,
  Chip,
  EmptyState,
  Input,
  SectionHeader,
  SkeletonRow,
  Text,
} from '@/components/ui';
import { RebookIntervalField } from '@/features/rebook/interval-field';
import { COLOR_HEX } from '@/features/services/colors';
import { useSaveService, useServiceMenu } from '@/features/services/data';
import { SegmentTimeline } from '@/features/services/timeline';
import { useTheme } from '@/theme/theme-provider';

const KINDS: ServiceSegment['kind'][] = ['busy', 'processing', 'style'];
const KIND_LABEL = { busy: 'Busy', processing: 'Processing', style: 'Style' } as const;

const BLANK: ServiceDefinition = {
  name: '',
  category: 'Cuts',
  priceCents: null,
  colorTag: 'indigo',
  segments: [{ kind: 'busy', minutes: 30 }],
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
  consultationRequired: false,
  bookableOnline: true,
  newClientsOnly: false,
  variants: [],
};

function Stepper({
  label,
  value,
  onChange,
  disabled,
  step = 5,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  disabled?: boolean;
  step?: number;
}) {
  return (
    <View className="flex-row items-center gap-2">
      <Button
        variant="secondary"
        size="icon"
        icon="remove"
        haptic="selection"
        accessibilityLabel={`Decrease ${label}`}
        disabled={disabled || value <= 0}
        onPress={() => onChange(Math.max(0, value - step))}
      />
      <Text variant="body" numeric className="w-14 text-center">
        {value}m
      </Text>
      <Button
        variant="secondary"
        size="icon"
        icon="add"
        haptic="selection"
        accessibilityLabel={`Increase ${label}`}
        disabled={disabled}
        onPress={() => onChange(value + step)}
      />
    </View>
  );
}

function ToggleRow({
  label,
  hint,
  value,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <View className="min-h-tap flex-row items-center gap-3">
      <View className="flex-1">
        <Text variant="body">{label}</Text>
        {hint ? (
          <Text variant="footnote" tone="muted">
            {hint}
          </Text>
        ) : null}
      </View>
      <Switch
        accessibilityLabel={label}
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        trackColor={{ true: colors.primary, false: colors.input }}
      />
    </View>
  );
}

export default function ServiceEditorScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: menu, error, canEdit } = useServiceMenu();

  if (!menu) {
    return (
      <DetailScreen title="Service">
        {error ? (
          <EmptyState icon="cloud-offline-outline" title="Couldn't load" message={error.message} />
        ) : (
          <View className="gap-3">
            <SkeletonRow />
            <SkeletonRow />
          </View>
        )}
      </DetailScreen>
    );
  }
  const existing = menu.services.find((s) => s.id === id);
  if (id !== 'new' && !existing) {
    return (
      <DetailScreen title="Service">
        <EmptyState icon="help-circle-outline" title="Service not found" />
      </DetailScreen>
    );
  }
  return <ServiceEditor key={id} existing={existing} canEdit={canEdit} />;
}

function ServiceEditor({ existing, canEdit }: { existing?: MenuService; canEdit: boolean }) {
  const save = useSaveService();
  const [draft, setDraft] = useState<ServiceDefinition>(() => existing ?? BLANK);
  const [priceText, setPriceText] = useState(
    draft.priceCents == null ? '' : String(draft.priceCents / 100),
  );
  const [error, setError] = useState<string | null>(null);

  const set = (patch: Partial<ServiceDefinition>) => setDraft((d) => ({ ...d, ...patch }));
  const setSegment = (i: number, patch: Partial<ServiceSegment>) =>
    set({ segments: draft.segments.map((s, j) => (j === i ? { ...s, ...patch } : s)) });

  const resolved = useMemo(() => {
    try {
      return { ok: true as const, value: resolveService(draft) };
    } catch (e) {
      return { ok: false as const, message: (e as Error).message };
    }
  }, [draft]);

  const onSave = () => {
    if (!draft.name.trim()) return setError('Give the service a name.');
    const price = priceText.trim() === '' ? null : Math.round(Number(priceText) * 100);
    if (price != null && (!Number.isFinite(price) || price < 0))
      return setError('Price must be a number.');
    setError(null);
    save.mutate(
      { ...draft, name: draft.name.trim(), priceCents: price, id: existing?.id, isCombo: false },
      {
        onSuccess: () => (router.canGoBack() ? router.back() : router.replace('/services')),
        onError: (e) => setError(e.message),
      },
    );
  };

  return (
    <DetailScreen
      title={!canEdit ? draft.name : existing ? 'Edit service' : 'New service'}
      close={!existing}
    >
      {!canEdit ? (
        <Card className="mb-2">
          <Text variant="footnote" tone="muted">
            Only the salon owner can edit services.
          </Text>
        </Card>
      ) : null}

      <Input
        label="Name"
        value={draft.name}
        onChangeText={(name) => set({ name })}
        placeholder="e.g. Full color"
        editable={canEdit}
      />

      <SectionHeader title="Timeline" />
      <Card className="gap-2">
        <SegmentTimeline
          segments={draft.segments.filter((s) => s.minutes > 0)}
          bufferBeforeMinutes={draft.bufferBeforeMinutes}
          bufferAfterMinutes={draft.bufferAfterMinutes}
          colorTag={draft.colorTag}
        />
        <Text variant="title3" tone={resolved.ok ? 'default' : 'destructive'}>
          {resolved.ok ? `Total ${formatDuration(resolved.value.totalMinutes)}` : resolved.message}
        </Text>
        {resolved.ok && resolved.value.processingMinutes > 0 ? (
          <Text variant="footnote" tone="muted">
            {formatDuration(resolved.value.processingMinutes)} processing — you can book another
            client then.
          </Text>
        ) : null}
      </Card>

      <SectionHeader title="Segments" />
      <View className="gap-3">
        {draft.segments.map((seg, i) => (
          <Card key={i} className="gap-3">
            <View className="flex-row flex-wrap gap-2">
              {KINDS.map((k) => (
                <Chip
                  key={k}
                  label={KIND_LABEL[k]}
                  selected={seg.kind === k}
                  onPress={canEdit ? () => setSegment(i, { kind: k }) : undefined}
                />
              ))}
            </View>
            <View className="flex-row items-center justify-between">
              <Stepper
                label={`segment ${i + 1}`}
                value={seg.minutes}
                disabled={!canEdit}
                onChange={(minutes) => setSegment(i, { minutes })}
              />
              {canEdit ? (
                <Button
                  variant="ghost"
                  size="sm"
                  label="Remove"
                  accessibilityLabel={`Remove segment ${i + 1}`}
                  disabled={draft.segments.length === 1}
                  onPress={() => set({ segments: draft.segments.filter((_, j) => j !== i) })}
                />
              ) : null}
            </View>
            <Input
              value={seg.label ?? ''}
              onChangeText={(label) => setSegment(i, { label: label || undefined })}
              placeholder="Label (e.g. Apply)"
              accessibilityLabel={`Segment ${i + 1} label`}
              editable={canEdit}
            />
          </Card>
        ))}
        {canEdit ? (
          <Button
            variant="outline"
            icon="add"
            label="Add segment"
            onPress={() => set({ segments: [...draft.segments, { kind: 'busy', minutes: 15 }] })}
          />
        ) : null}
      </View>

      <SectionHeader title="Buffers" />
      <Card className="gap-2">
        <View className="flex-row items-center justify-between">
          <Text variant="body">Before</Text>
          <Stepper
            label="buffer before"
            value={draft.bufferBeforeMinutes}
            disabled={!canEdit}
            onChange={(n) => set({ bufferBeforeMinutes: n })}
          />
        </View>
        <View className="flex-row items-center justify-between">
          <Text variant="body">After</Text>
          <Stepper
            label="buffer after"
            value={draft.bufferAfterMinutes}
            disabled={!canEdit}
            onChange={(n) => set({ bufferAfterMinutes: n })}
          />
        </View>
      </Card>

      <SectionHeader title="Category" />
      <View className="flex-row flex-wrap gap-2">
        {STARTER_CATEGORIES.map((c) => (
          <Chip
            key={c}
            label={c}
            selected={draft.category === c}
            onPress={canEdit ? () => set({ category: c }) : undefined}
          />
        ))}
      </View>

      <SectionHeader title="Color" />
      <View className="flex-row flex-wrap gap-3">
        {SERVICE_COLOR_TAGS.map((c) => (
          <Pressable
            key={c}
            accessibilityRole="button"
            accessibilityLabel={c}
            accessibilityState={{ selected: draft.colorTag === c }}
            disabled={!canEdit}
            hitSlop={4}
            onPress={() => set({ colorTag: c })}
            style={{ backgroundColor: COLOR_HEX[c] }}
            className={`h-9 w-9 rounded-full ${draft.colorTag === c ? 'border-4 border-foreground' : ''}`}
          />
        ))}
      </View>

      <SectionHeader title="Price" />
      <Input
        value={priceText}
        onChangeText={setPriceText}
        keyboardType="decimal-pad"
        icon="cash-outline"
        accessibilityLabel="Price in dollars"
        placeholder="Leave blank if it varies"
        editable={canEdit}
      />

      {existing ? <RebookIntervalField service={existing} canEdit={canEdit} /> : null}

      <SectionHeader title="Options" />
      <Card className="gap-1">
        <ToggleRow
          label="Hair-length variants"
          hint="Short +0 · Medium +15 · Long +30 (added to busy/style time)"
          value={draft.variants.length > 0}
          disabled={!canEdit}
          onChange={(on) =>
            set({ variants: on ? HAIR_LENGTH_VARIANTS.map((v) => ({ ...v })) : [] })
          }
        />
        {(
          [
            ['consultationRequired', 'Consultation required'],
            ['bookableOnline', 'Bookable online'],
            ['newClientsOnly', 'New clients only'],
          ] as const
        ).map(([key, label]) => (
          <ToggleRow
            key={key}
            label={label}
            value={draft[key]}
            disabled={!canEdit}
            onChange={(v) => set({ [key]: v })}
          />
        ))}
      </Card>

      {error ? (
        <Text variant="footnote" tone="destructive" className="mt-4">
          {error}
        </Text>
      ) : null}
      {canEdit ? (
        <Button
          className="mt-6"
          size="lg"
          fullWidth
          label="Save service"
          onPress={onSave}
          disabled={!resolved.ok}
          loading={save.isPending}
        />
      ) : null}
    </DetailScreen>
  );
}
