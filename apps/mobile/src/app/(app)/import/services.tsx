import {
  formatDuration,
  parsePriceText,
  planServiceImport,
  serviceImportIssues,
  servicesToArchive,
  type ExtractServicesRequest,
  type ServiceImportAction,
  type ServiceImportRow,
  type ServiceMenuSource,
} from '@chairside/core';
import type { ServiceMenu } from '@chairside/db/services';
import { useQueryClient } from '@tanstack/react-query';
import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { View } from 'react-native';

import { DetailScreen } from '@/components/shell/screen';
import {
  Badge,
  Button,
  Card,
  Icon,
  Input,
  ListGroup,
  ListRow,
  SectionHeader,
  SegmentedControl,
  Sheet,
  Text,
  type BadgeTone,
} from '@/components/ui';
import { AiRequestError } from '@/features/ai-settings/api';
import {
  extractServices,
  runServiceImport,
  type ServiceImportMode,
  type ServiceImportOutcome,
} from '@/features/import/services-api';
import { formatPrice, useServiceMenu } from '@/features/services/data';
import { supabase } from '@/lib/supabase';
import { useCurrentSalon } from '@/providers/session-provider';

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
type ImageType = Extract<ExtractServicesRequest, { source: 'image' }>['mimeType'];

const SOURCE_BADGE: Record<ServiceMenuSource, string> = {
  ai: 'Read by AI',
  demo: 'Read by AI (demo)',
  parser: 'Read line by line',
};

type Step =
  | { name: 'start' }
  | { name: 'review' }
  | { name: 'importing'; done: number; total: number }
  | { name: 'done'; outcome: ServiceImportOutcome };

type Busy = 'url' | 'image' | 'text' | null;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function rowStatus(row: ServiceImportRow): { label: string; tone: BadgeTone } {
  if (row.action === 'skip')
    return { label: row.match ? 'On your menu' : 'Skipped', tone: 'neutral' };
  if (serviceImportIssues(row).length) return { label: 'Needs details', tone: 'warning' };
  if (row.action === 'update') return { label: 'Update', tone: 'primary' };
  return { label: 'New', tone: 'success' };
}

function rowSummary(row: ServiceImportRow): string {
  const parts = [row.category ?? 'Other'];
  parts.push(row.durationMinutes ? formatDuration(row.durationMinutes) : 'No duration');
  if (row.processingMinutes) parts.push(`${formatDuration(row.processingMinutes)} processing`);
  parts.push(formatPrice(row.priceCents));
  return parts.join(' · ');
}

async function pickScreenshot(): Promise<{ mimeType: ImageType; data: string } | null> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    quality: 0.7,
    base64: true,
  });
  const asset = result.canceled ? null : result.assets[0];
  if (!asset) return null;
  const dataUri = /^data:([^;]+);base64,(.*)$/s.exec(asset.uri);
  const mimeType = asset.mimeType ?? asset.file?.type ?? dataUri?.[1] ?? 'image/jpeg';
  const data = asset.base64 ?? dataUri?.[2];
  if (!IMAGE_TYPES.has(mimeType)) throw new Error('Choose a PNG, JPEG or WebP screenshot.');
  if (!data) throw new Error('Couldn’t read that image. Try another screenshot.');
  if (data.length > 8 * 1024 * 1024) {
    throw new Error('That image is too large. Crop the screenshot to just the menu.');
  }
  return { mimeType: mimeType as ImageType, data };
}

/** Settings → Import services: link / screenshot / text → review & edit → save → results. */
export default function ImportServicesScreen() {
  const salon = useCurrentSalon();
  const menu = useServiceMenu();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>({ name: 'start' });
  const [rows, setRows] = useState<ServiceImportRow[]>([]);
  const [source, setSource] = useState<{ kind: ServiceMenuSource; notice?: string } | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<{ message: string; tryScreenshot: boolean } | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const read = async (kind: Exclude<Busy, null>, input: { url?: string; text?: string }) => {
    setError(null);
    try {
      let request: ExtractServicesRequest;
      if (kind === 'image') {
        const image = await pickScreenshot();
        if (!image) return;
        request = { source: 'image', salonId: salon.id, ...image };
      } else if (kind === 'url') {
        request = { source: 'url', salonId: salon.id, url: input.url ?? '' };
      } else {
        request = { source: 'text', salonId: salon.id, text: input.text ?? '' };
      }
      setBusy(kind);
      const [extracted, current] = await Promise.all([
        extractServices(supabase, request),
        menu.data ? Promise.resolve(menu.data) : menu.refetch().then((r) => r.data),
      ]);
      if (!current) throw new Error('Couldn’t load your current menu. Try again.');
      setRows(planServiceImport(extracted.services, current.services));
      setSource({ kind: extracted.source, notice: extracted.notice });
      setStep({ name: 'review' });
    } catch (e) {
      const code = e instanceof AiRequestError ? e.code : null;
      setError({
        message:
          code === 'network'
            ? 'Couldn’t reach Chairside. Check your connection and try again.'
            : errorText(e),
        tryScreenshot:
          kind !== 'image' &&
          !!code &&
          ['page_fetch_failed', 'page_unreadable', 'no_services_found', 'unsupported_url'].includes(
            code,
          ),
      });
    } finally {
      setBusy(null);
    }
  };

  const run = async (mode: ServiceImportMode) => {
    if (!menu.data) return;
    setRunError(null);
    setStep({ name: 'importing', done: 0, total: rows.length });
    try {
      const outcome = await runServiceImport(
        supabase,
        salon.id,
        rows,
        menu.data,
        mode,
        (done, total) => setStep({ name: 'importing', done, total }),
      );
      await queryClient.invalidateQueries({ queryKey: ['service-menu', salon.id] });
      setStep({ name: 'done', outcome });
    } catch (e) {
      await queryClient.invalidateQueries({ queryKey: ['service-menu', salon.id] });
      setRunError(errorText(e));
      setStep({ name: 'review' });
    }
  };

  const restart = () => {
    setRows([]);
    setSource(null);
    setError(null);
    setRunError(null);
    setStep({ name: 'start' });
  };

  let body;
  if (!menu.canEdit) {
    body = (
      <Card className="gap-2">
        <Text variant="headline">Owners only</Text>
        <Text variant="subhead" tone="muted">
          Ask the salon owner to import the service menu.
        </Text>
      </Card>
    );
  } else if (step.name === 'start') {
    body = <StartStep busy={busy} error={error} onRead={(k, i) => void read(k, i)} />;
  } else if (step.name === 'review' && menu.data) {
    body = (
      <ReviewStep
        rows={rows}
        menu={menu.data}
        source={source}
        error={runError}
        onChange={setRows}
        onBack={restart}
        onImport={(mode) => void run(mode)}
      />
    );
  } else if (step.name === 'importing') {
    body = (
      <Card className="items-center gap-2 py-8" testID="services-import-progress">
        <Icon name="cloud-upload-outline" color="primary" size={32} />
        <Text variant="headline">Saving services…</Text>
        <Text variant="footnote" tone="muted" numeric>
          {step.done} of {step.total}
        </Text>
      </Card>
    );
  } else if (step.name === 'done') {
    body = <Results outcome={step.outcome} onRestart={restart} />;
  }

  return <DetailScreen title="Import services">{body}</DetailScreen>;
}

function StartStep({
  busy,
  error,
  onRead,
}: {
  busy: Busy;
  error: { message: string; tryScreenshot: boolean } | null;
  onRead: (kind: Exclude<Busy, null>, input: { url?: string; text?: string }) => void;
}) {
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const disabled = busy !== null;

  return (
    <View className="gap-4">
      <Text variant="subhead" tone="muted" className="px-1">
        Bring your Vagaro service menu over. You review every service before anything is saved, and
        services already on your menu are skipped unless you choose to update them.
      </Text>

      <Card className="gap-3">
        <View className="flex-row items-center gap-3">
          <Icon name="link-outline" color="primary" />
          <View className="flex-1">
            <Text variant="headline">Vagaro booking page</Text>
            <Text variant="footnote" tone="muted">
              Paste your public link, like vagaro.com/your-salon.
            </Text>
          </View>
        </View>
        <Input
          value={url}
          onChangeText={setUrl}
          placeholder="vagaro.com/your-salon"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          testID="services-import-url"
        />
        <Button
          label="Read menu from link"
          icon="download-outline"
          fullWidth
          loading={busy === 'url'}
          disabled={disabled || !url.trim()}
          onPress={() => onRead('url', { url })}
          testID="services-import-url-submit"
        />
      </Card>

      {error ? (
        <Card className="gap-3" testID="services-import-error">
          <View className="flex-row gap-2">
            <Icon name="alert-circle-outline" color="warning" />
            <Text variant="subhead" className="flex-1">
              {error.message}
            </Text>
          </View>
          {error.tryScreenshot ? (
            <Button
              label="Choose a screenshot"
              icon="image-outline"
              fullWidth
              loading={busy === 'image'}
              disabled={disabled}
              onPress={() => onRead('image', {})}
              testID="services-import-fallback-image"
            />
          ) : null}
        </Card>
      ) : null}

      <Card className="gap-3">
        <View className="flex-row items-center gap-3">
          <Icon name="image-outline" color="primary" />
          <View className="flex-1">
            <Text variant="headline">Menu screenshot</Text>
            <Text variant="footnote" tone="muted">
              Screenshot your Vagaro services page. Read by your salon’s AI (Settings → AI).
            </Text>
          </View>
        </View>
        <Button
          label="Choose screenshot"
          icon="image-outline"
          variant="outline"
          fullWidth
          loading={busy === 'image'}
          disabled={disabled}
          onPress={() => onRead('image', {})}
          testID="services-import-image"
        />
      </Card>

      <Card className="gap-3">
        <View className="flex-row items-center gap-3">
          <Icon name="clipboard-outline" color="primary" />
          <View className="flex-1">
            <Text variant="headline">Paste your menu</Text>
            <Text variant="footnote" tone="muted">
              Copy the services from Vagaro (or any price list) and paste them here. Works without
              AI too.
            </Text>
          </View>
        </View>
        <Input
          value={text}
          onChangeText={setText}
          placeholder={'Haircuts\nWomen’s Haircut · 45 min · $65'}
          multiline
          numberOfLines={6}
          className="min-h-32"
          textAlignVertical="top"
          testID="services-import-text"
        />
        <Button
          label="Read pasted menu"
          icon="list-outline"
          variant="outline"
          fullWidth
          loading={busy === 'text'}
          disabled={disabled || !text.trim()}
          onPress={() => onRead('text', { text })}
          testID="services-import-text-submit"
        />
      </Card>
    </View>
  );
}

function ReviewStep({
  rows,
  menu,
  source,
  error,
  onChange,
  onBack,
  onImport,
}: {
  rows: ServiceImportRow[];
  menu: ServiceMenu;
  source: { kind: ServiceMenuSource; notice?: string } | null;
  error: string | null;
  onChange: (rows: ServiceImportRow[]) => void;
  onBack: () => void;
  onImport: (mode: ServiceImportMode) => void;
}) {
  const [mode, setMode] = useState<ServiceImportMode>('merge');
  const [editing, setEditing] = useState<string | null>(null);
  const counts = useMemo(() => {
    let add = 0;
    let update = 0;
    let skip = 0;
    let blocked = 0;
    for (const r of rows) {
      if (r.action === 'skip') skip++;
      else if (serviceImportIssues(r).length) blocked++;
      else if (r.action === 'add') add++;
      else update++;
    }
    return { add, update, skip, blocked };
  }, [rows]);
  const archiveCount = useMemo(
    () => (mode === 'replace' ? servicesToArchive(rows, menu).length : 0),
    [mode, rows, menu],
  );
  const editingRow = rows.find((r) => r.key === editing) ?? null;
  const toSave = counts.add + counts.update;

  const update = (next: ServiceImportRow) =>
    onChange(rows.map((r) => (r.key === next.key ? next : r)));
  const skipBlocked = () =>
    onChange(
      rows.map((r) =>
        r.action !== 'skip' && serviceImportIssues(r).length ? { ...r, action: 'skip' } : r,
      ),
    );

  return (
    <View className="gap-1" testID="services-import-review">
      <Card className="gap-1">
        <View className="flex-row items-center gap-2">
          <Text variant="headline" className="flex-1">
            {plural(rows.length, 'service')} found
          </Text>
          {source ? <Badge label={SOURCE_BADGE[source.kind]} tone="primary" /> : null}
        </View>
        <Text variant="footnote" tone="muted" testID="services-import-counts">
          {counts.add} new · {counts.update} to update · {counts.skip} skipped
          {counts.blocked ? ` · ${counts.blocked} need details` : ''}
        </Text>
        {source?.notice ? (
          <Text variant="footnote" tone="warning" testID="services-import-notice">
            {source.notice}
          </Text>
        ) : null}
      </Card>

      <SectionHeader title="Your current menu" />
      <SegmentedControl
        options={[
          { value: 'merge', label: 'Keep & add' },
          { value: 'replace', label: 'Replace' },
        ]}
        value={mode}
        onChange={setMode}
        accessibilityLabel="Import mode"
      />
      <Text variant="footnote" tone="muted" className="px-1 pt-1">
        {mode === 'merge'
          ? 'Services you already have stay as they are.'
          : `${plural(archiveCount, 'service')} not in this import will be hidden from booking. They stay in your history and can be restored in Services.`}
      </Text>

      <SectionHeader title="Check each service" />
      <ListGroup>
        {rows.map((r, i) => {
          const status = rowStatus(r);
          return (
            <ListRow
              key={r.key}
              title={r.name}
              subtitle={rowSummary(r)}
              trailing={<Badge label={status.label} tone={status.tone} />}
              accessibilityHint={`Edit ${r.name}`}
              onPress={() => setEditing(r.key)}
              last={i === rows.length - 1}
            />
          );
        })}
      </ListGroup>

      {counts.blocked ? (
        <View className="gap-2 px-1 pt-3">
          <Text variant="footnote" tone="warning">
            {plural(counts.blocked, 'service')} need a duration or other details. Tap one to fix it,
            or skip them.
          </Text>
          <Button label="Skip those services" variant="outline" size="sm" onPress={skipBlocked} />
        </View>
      ) : null}
      {error ? (
        <Text variant="footnote" tone="destructive" className="px-1 pt-3" testID="import-error">
          {error}
        </Text>
      ) : null}
      <View className="flex-row gap-3 pt-5">
        <Button label="Back" variant="outline" grow onPress={onBack} />
        <Button
          label={toSave ? `Save ${plural(toSave, 'service')}` : 'Nothing to save'}
          grow
          disabled={counts.blocked > 0 || (toSave === 0 && archiveCount === 0)}
          onPress={() => onImport(mode)}
          testID="services-import-confirm"
        />
      </View>

      <Sheet
        open={editingRow !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        title={editingRow?.match ? `On your menu as “${editingRow.match.name}”` : 'Edit service'}
      >
        {editingRow ? (
          <RowEditor
            key={editingRow.key}
            row={editingRow}
            onSave={(next) => {
              update(next);
              setEditing(null);
            }}
          />
        ) : null}
      </Sheet>
    </View>
  );
}

const numberOrNull = (s: string) => {
  const n = Number(s.trim());
  return s.trim() && Number.isFinite(n) ? Math.round(n) : null;
};

function RowEditor({
  row,
  onSave,
}: {
  row: ServiceImportRow;
  onSave: (row: ServiceImportRow) => void;
}) {
  const [name, setName] = useState(row.name);
  const [category, setCategory] = useState(row.category ?? '');
  const [duration, setDuration] = useState(row.durationMinutes?.toString() ?? '');
  const [processing, setProcessing] = useState(row.processingMinutes?.toString() ?? '');
  const [price, setPrice] = useState(
    row.priceCents === null ? '' : (row.priceCents / 100).toFixed(row.priceCents % 100 ? 2 : 0),
  );
  const [action, setAction] = useState<ServiceImportAction>(row.action);

  const priceCents = price.trim() ? parsePriceText(price) : null;
  const draft: ServiceImportRow = {
    ...row,
    name: name.trim(),
    category: category.trim() || null,
    durationMinutes: numberOrNull(duration),
    processingMinutes: numberOrNull(processing) || null,
    priceCents,
    action,
  };
  const issues = action === 'skip' ? [] : serviceImportIssues(draft);
  const priceError = price.trim() && priceCents === null ? 'Enter a price like 65 or 65.50' : '';

  const actions: { value: ServiceImportAction; label: string }[] = row.match
    ? [
        { value: 'skip', label: 'Keep mine' },
        { value: 'update', label: 'Update' },
        { value: 'add', label: 'Add new' },
      ]
    : [
        { value: 'add', label: 'Add' },
        { value: 'skip', label: 'Skip' },
      ];

  return (
    <View className="gap-3" testID="services-import-editor">
      <SegmentedControl options={actions} value={action} onChange={setAction} />
      {row.match && action === 'update' ? (
        <Text variant="footnote" tone="muted">
          Updates the price and length of “{row.match.name}”. Its name, category and settings stay.
        </Text>
      ) : null}
      <Input label="Name" value={name} onChangeText={setName} maxLength={80} />
      <Input label="Category" value={category} onChangeText={setCategory} maxLength={40} />
      <View className="flex-row gap-3">
        <Input
          label="Length (min)"
          value={duration}
          onChangeText={setDuration}
          keyboardType="number-pad"
          className="flex-1"
          testID="services-import-duration"
        />
        <Input
          label="Processing (min)"
          value={processing}
          onChangeText={setProcessing}
          keyboardType="number-pad"
          helper="Optional gap"
          className="flex-1"
        />
      </View>
      <Input
        label="Price ($)"
        value={price}
        onChangeText={setPrice}
        keyboardType="decimal-pad"
        placeholder="Leave empty if it varies"
        error={priceError || undefined}
      />
      {issues.length ? (
        <Text variant="footnote" tone="warning">
          {issues.join(' · ')}
        </Text>
      ) : null}
      <Button
        label="Done"
        fullWidth
        disabled={!!priceError || !draft.name}
        onPress={() => onSave(draft)}
        testID="services-import-editor-done"
      />
    </View>
  );
}

function Results({ outcome, onRestart }: { outcome: ServiceImportOutcome; onRestart: () => void }) {
  const lines: [string, number][] = [
    ['Added', outcome.added],
    ['Updated', outcome.updated],
    ['Skipped', outcome.skipped],
    ['Hidden from booking', outcome.archived],
  ];
  return (
    <View className="gap-1" testID="services-import-done">
      <Card className="gap-1">
        <View className="flex-row items-center gap-2 pb-1">
          <Icon name="checkmark-circle-outline" color="primary" />
          <Text variant="headline">Import finished</Text>
        </View>
        {lines.map(([label, value]) =>
          value || label !== 'Hidden from booking' ? (
            <View key={label} className="flex-row items-center justify-between py-1">
              <Text variant="subhead">{label}</Text>
              <Text variant="headline" numeric testID={`services-import-${label.toLowerCase()}`}>
                {value}
              </Text>
            </View>
          ) : null,
        )}
      </Card>
      {outcome.failed.length ? (
        <>
          <SectionHeader title={`Not saved (${outcome.failed.length})`} />
          <Card className="gap-1">
            {outcome.failed.map((f) => (
              <Text key={f.name} variant="footnote">
                <Text variant="footnote" tone="muted">
                  {f.name}:{' '}
                </Text>
                {f.message}
              </Text>
            ))}
          </Card>
        </>
      ) : null}
      <View className="flex-row gap-3 pt-5">
        <Button label="Import more" variant="outline" grow onPress={onRestart} />
        <Button
          label="Open services"
          grow
          onPress={() => router.push('/services')}
          testID="services-import-open-services"
        />
      </View>
    </View>
  );
}
