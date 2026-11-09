import {
  buildAppointmentImport,
  buildClientImport,
  importFields,
  missingRequiredFields,
  previewClientMatches,
  type AppointmentImportPlan,
  type ColumnMapping,
  type ImportIssue,
  type ImportKind,
  type ImportTable,
} from '@chairside/core';
import type { ImportAppointmentsResult, ImportClientsResult } from '@chairside/db';
import * as DocumentPicker from 'expo-document-picker';
import { useMemo, useState } from 'react';
import { View } from 'react-native';

import { DetailScreen } from '@/components/shell/screen';
import {
  Badge,
  Button,
  Card,
  Icon,
  ListGroup,
  ListRow,
  SectionHeader,
  Sheet,
  Text,
  type IconName,
} from '@/components/ui';
import { formatDay, formatTime } from '@/features/appointments/format';
import {
  proposeColumnMapping,
  readImportFile,
  readPickedBytes,
  runAppointmentImport,
  runClientImport,
  useClientContacts,
  useInvalidateAfterImport,
  type MappingSource,
} from '@/features/import/api';
import {
  BLOCK_TIME,
  appointmentClients,
  appointmentPayload,
  clientPayload,
  defaultServiceChoices,
  importedServiceNames,
  menuItems,
  type ServiceChoice,
} from '@/features/import/plan';
import { useServiceMenu } from '@/features/services/data';
import { useCurrentSalon } from '@/providers/session-provider';

const GUIDES: Record<
  ImportKind,
  { title: string; icon: IconName; blurb: string; steps: string[] }
> = {
  clients: {
    title: 'Clients',
    icon: 'people-outline',
    blurb: 'Names, phones, emails, birthdays, tags, last visit and no-shows.',
    steps: [
      'On a computer, sign in to Vagaro and open Reports → Customers.',
      'Choose Export → Excel (or CSV).',
      'Email the file to yourself or save it to Files, then choose it here.',
    ],
  },
  appointments: {
    title: 'Upcoming appointments',
    icon: 'calendar-outline',
    blurb: 'Future bookings land on your calendar and block that time.',
    steps: [
      'In Vagaro, open Reports → Appointments Summary.',
      'Set the dates from today to your last booking, then Export → Excel (or CSV).',
      'Import clients first so each appointment links to their full profile.',
    ],
  },
};

const SOURCE_BADGE: Record<MappingSource, { label: string; tone: 'primary' | 'neutral' }> = {
  ai: { label: 'Mapped by AI', tone: 'primary' },
  demo: { label: 'Mapped by AI (demo)', tone: 'primary' },
  manual: { label: 'Matched by headers', tone: 'neutral' },
};

interface AppointmentOutcome {
  result: ImportAppointmentsResult;
  labels: { startsAt: string; title: string; row: number }[];
}

type Step =
  | { name: 'start' }
  | { name: 'mapping' }
  | { name: 'preview' }
  | { name: 'importing'; done: number; total: number; label: string }
  | { name: 'clients-done'; result: ImportClientsResult }
  | { name: 'appointments-done'; outcome: AppointmentOutcome };

type SetStep = (step: Step) => void;

interface Loaded {
  kind: ImportKind;
  fileName: string;
  table: ImportTable;
  mapping: ColumnMapping;
  source: MappingSource;
  notice?: string;
}

const sample = (table: ImportTable, col: number) =>
  table.rows.find((r) => r[col]?.trim())?.[col]?.trim() ?? '';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

const apptTitle = (a: AppointmentImportPlan['appointments'][number]) =>
  `${a.client.name || 'No client'} · ${a.services.map((s) => s.name).join(' + ') || 'Appointment'}`;

/** Settings → Import from Vagaro: file → column mapping → preview → import → results. */
export default function ImportScreen() {
  const salon = useCurrentSalon();
  const [step, setStep] = useState<Step>({ name: 'start' });
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [busyKind, setBusyKind] = useState<ImportKind | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pick = async (kind: ImportKind) => {
    setError(null);
    const picked = await DocumentPicker.getDocumentAsync({
      type: [
        'text/csv',
        'text/comma-separated-values',
        'text/plain',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-excel',
      ],
      copyToCacheDirectory: true,
      multiple: false,
    });
    const asset = picked.canceled ? null : picked.assets[0];
    if (!asset) return;
    setBusyKind(kind);
    try {
      const bytes = await readPickedBytes(asset.uri, asset.file);
      const table = readImportFile({ name: asset.name, bytes });
      if (!table.rows.length) throw new Error('That file has no rows to import.');
      const proposed = await proposeColumnMapping(salon.id, kind, table);
      setLoaded({ kind, fileName: asset.name, table, ...proposed });
      setStep({ name: 'mapping' });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusyKind(null);
    }
  };

  const restart = () => {
    setLoaded(null);
    setError(null);
    setStep({ name: 'start' });
  };

  let body;
  if (step.name === 'start' || !loaded) {
    body = <StartStep onPick={(k) => void pick(k)} busyKind={busyKind} error={error} />;
  } else if (step.name === 'mapping') {
    body = (
      <MappingStep
        loaded={loaded}
        onChange={(mapping) => setLoaded({ ...loaded, mapping })}
        onBack={restart}
        onNext={() => setStep({ name: 'preview' })}
      />
    );
  } else if (step.name === 'preview') {
    const back = () => setStep({ name: 'mapping' });
    body =
      loaded.kind === 'clients' ? (
        <ClientPreview loaded={loaded} onBack={back} setStep={setStep} />
      ) : (
        <AppointmentPreview loaded={loaded} onBack={back} setStep={setStep} />
      );
  } else if (step.name === 'importing') {
    body = (
      <Card className="items-center gap-2 py-8" testID="import-progress">
        <Icon name="cloud-upload-outline" color="primary" size={32} />
        <Text variant="headline">{step.label}</Text>
        <Text variant="footnote" tone="muted" numeric>
          {step.done} of {step.total}
        </Text>
      </Card>
    );
  } else if (step.name === 'clients-done') {
    body = <ClientResults result={step.result} loaded={loaded} onRestart={restart} />;
  } else {
    body = <AppointmentResults outcome={step.outcome} onRestart={restart} />;
  }

  return <DetailScreen title="Import from Vagaro">{body}</DetailScreen>;
}

function StartStep({
  onPick,
  busyKind,
  error,
}: {
  onPick: (kind: ImportKind) => void;
  busyKind: ImportKind | null;
  error: string | null;
}) {
  return (
    <View className="gap-4">
      <Text variant="subhead" tone="muted" className="px-1">
        Moving from Vagaro? Export your data there, then bring it in here. Nothing is saved until
        you review it, and importing the same file again won’t create duplicates.
      </Text>
      {(Object.keys(GUIDES) as ImportKind[]).map((kind) => {
        const g = GUIDES[kind];
        return (
          <Card key={kind} className="gap-3">
            <View className="flex-row items-center gap-3">
              <Icon name={g.icon} color="primary" />
              <View className="flex-1">
                <Text variant="headline">{g.title}</Text>
                <Text variant="footnote" tone="muted">
                  {g.blurb}
                </Text>
              </View>
            </View>
            <View className="gap-1.5">
              {g.steps.map((s, i) => (
                <View key={s} className="flex-row gap-2">
                  <Text variant="footnote" tone="muted" numeric>
                    {i + 1}.
                  </Text>
                  <Text variant="footnote" className="flex-1">
                    {s}
                  </Text>
                </View>
              ))}
            </View>
            <Button
              label={kind === 'clients' ? 'Choose client file' : 'Choose appointment file'}
              icon="document-outline"
              variant={kind === 'clients' ? 'primary' : 'outline'}
              fullWidth
              loading={busyKind === kind}
              disabled={busyKind !== null}
              onPress={() => onPick(kind)}
            />
          </Card>
        );
      })}
      <Text variant="footnote" tone="subtle" className="px-1">
        Excel (.xlsx) and CSV files work. Columns are matched by your salon’s AI when it’s set up
        (it only sees masked samples) or by their headers otherwise. You confirm every column.
      </Text>
      {error ? (
        <Text variant="footnote" tone="destructive" className="px-1" testID="import-error">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

function MappingStep({
  loaded,
  onChange,
  onBack,
  onNext,
}: {
  loaded: Loaded;
  onChange: (mapping: ColumnMapping) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const { kind, table, mapping } = loaded;
  const fields = importFields(kind);
  const [editing, setEditing] = useState<string | null>(null);
  const m = mapping as Record<string, number | undefined>;
  const missing = missingRequiredFields(kind, mapping);
  const badge = SOURCE_BADGE[loaded.source];
  const editingField = fields.find((f) => f.key === editing);

  const assign = (field: string, col: number | null) => {
    const next: Record<string, number> = {};
    for (const [k, v] of Object.entries(m))
      if (v !== undefined && k !== field && v !== col) next[k] = v;
    if (col !== null) next[field] = col;
    onChange(next as ColumnMapping);
    setEditing(null);
  };

  const check = (on: boolean) => (on ? <Icon name="checkmark" color="primary" /> : null);

  return (
    <View className="gap-1" testID="import-mapping">
      <Card className="gap-1">
        <View className="flex-row items-center gap-2">
          <Text variant="headline" className="flex-1" numberOfLines={1}>
            {loaded.fileName}
          </Text>
          <Badge label={badge.label} tone={badge.tone} />
        </View>
        <Text variant="footnote" tone="muted">
          {plural(table.rows.length, 'row')} · {plural(table.headers.length, 'column')}
        </Text>
        {loaded.notice ? (
          <Text variant="footnote" tone="warning" testID="mapping-notice">
            {loaded.notice}
          </Text>
        ) : null}
      </Card>

      <SectionHeader title="Check the columns" />
      <ListGroup>
        {fields.map((f, i) => {
          const col = m[f.key];
          const header = col !== undefined ? table.headers[col] || `Column ${col + 1}` : '';
          return (
            <ListRow
              key={f.key}
              title={f.label}
              subtitle={
                col !== undefined
                  ? [`“${header}”`, sample(table, col)].filter(Boolean).join(' · ')
                  : 'Not in this file'
              }
              accessibilityHint={`Choose the column for ${f.label}`}
              onPress={() => setEditing(f.key)}
              last={i === fields.length - 1}
            />
          );
        })}
      </ListGroup>

      {missing.length ? (
        <Text variant="footnote" tone="warning" className="px-1 pt-3">
          Choose {missing.join(' and ')} to continue.
        </Text>
      ) : null}
      <View className="flex-row gap-3 pt-5">
        <Button label="Back" variant="outline" grow onPress={onBack} />
        <Button label="Preview" grow disabled={missing.length > 0} onPress={onNext} />
      </View>

      <Sheet
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        title={editingField?.label ?? ''}
        subtitle={editingField?.description}
      >
        <ListGroup>
          <ListRow
            title="Not in this file"
            chevron={false}
            trailing={check(editing !== null && m[editing] === undefined)}
            onPress={() => editing && assign(editing, null)}
          />
          {table.headers.map((h, col) => (
            <ListRow
              key={col}
              title={h || `Column ${col + 1}`}
              subtitle={sample(table, col) || 'Empty'}
              chevron={false}
              trailing={check(editing !== null && m[editing] === col)}
              onPress={() => editing && assign(editing, col)}
              last={col === table.headers.length - 1}
            />
          ))}
        </ListGroup>
      </Sheet>
    </View>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'warning' | 'muted';
}) {
  return (
    <View className="flex-row items-center justify-between py-1">
      <Text variant="subhead" tone={tone}>
        {label}
      </Text>
      <Text variant="headline" tone={tone} numeric>
        {value}
      </Text>
    </View>
  );
}

function Issues({ title, issues }: { title: string; issues: readonly ImportIssue[] }) {
  if (!issues.length) return null;
  return (
    <>
      <SectionHeader title={`${title} (${issues.length})`} />
      <Card className="gap-1">
        {issues.slice(0, 20).map((issue, i) => (
          <Text key={i} variant="footnote">
            <Text variant="footnote" tone="muted" numeric>
              Row {issue.row}:{' '}
            </Text>
            {issue.message}
          </Text>
        ))}
        {issues.length > 20 ? (
          <Text variant="footnote" tone="muted">
            …and {issues.length - 20} more
          </Text>
        ) : null}
      </Card>
    </>
  );
}

function ClientPreview({
  loaded,
  onBack,
  setStep,
}: {
  loaded: Loaded;
  onBack: () => void;
  setStep: SetStep;
}) {
  const salon = useCurrentSalon();
  const contacts = useClientContacts(true);
  const invalidate = useInvalidateAfterImport();
  const [error, setError] = useState<string | null>(null);
  const plan = useMemo(() => buildClientImport(loaded.table, loaded.mapping), [loaded]);
  const matches = useMemo(
    () => previewClientMatches(plan.clients, contacts.data ?? []),
    [plan, contacts.data],
  );

  const run = async () => {
    setError(null);
    const total = plan.clients.length;
    const label = 'Importing clients…';
    setStep({ name: 'importing', done: 0, total, label });
    try {
      const result = await runClientImport(salon.id, plan.clients.map(clientPayload), (done) =>
        setStep({ name: 'importing', done, total, label }),
      );
      await invalidate();
      setStep({ name: 'clients-done', result });
    } catch (e) {
      setError(errorText(e));
      setStep({ name: 'preview' });
    }
  };

  return (
    <View className="gap-1" testID="client-preview">
      <Card>
        <Stat label="Clients in the file" value={plan.clients.length} />
        {contacts.data ? (
          <>
            <Stat label="New to Chairside" value={matches.newCount} />
            <Stat label="Already here" value={matches.matched.size} />
          </>
        ) : null}
        {plan.mergedRows ? (
          <Stat label="Duplicate rows merged" value={plan.mergedRows} tone="muted" />
        ) : null}
        {plan.errors.length ? (
          <Stat label="Rows skipped" value={plan.errors.length} tone="warning" />
        ) : null}
      </Card>
      <Text variant="footnote" tone="muted" className="px-1 pt-2">
        People already in Chairside are matched by email, then phone, then name. Their details are
        never overwritten: only empty fields are filled in and new tags are added.
      </Text>

      <SectionHeader title="First clients" />
      <ListGroup>
        {plan.clients.slice(0, 5).map((c, i, list) => (
          <ListRow
            key={`${c.rows[0]}`}
            title={c.name}
            subtitle={
              [c.phone, c.email, c.tags.join(', ')].filter(Boolean).join(' · ') ||
              'No contact details'
            }
            chevron={false}
            trailing={
              matches.matched.has(i) ? (
                <Badge label="Match" />
              ) : (
                <Badge label="New" tone="success" />
              )
            }
            last={i === list.length - 1}
          />
        ))}
      </ListGroup>

      <Issues title="Skipped rows" issues={plan.errors} />
      <Issues title="Values left out" issues={plan.warnings} />

      {error ? (
        <Text variant="footnote" tone="destructive" className="px-1 pt-3" testID="import-error">
          {error}
        </Text>
      ) : null}
      <View className="flex-row gap-3 pt-5">
        <Button label="Back" variant="outline" grow onPress={onBack} />
        <Button
          label={`Import ${plural(plan.clients.length, 'client')}`}
          grow
          disabled={!plan.clients.length}
          onPress={() => void run()}
        />
      </View>
    </View>
  );
}

function AppointmentPreview({
  loaded,
  onBack,
  setStep,
}: {
  loaded: Loaded;
  onBack: () => void;
  setStep: SetStep;
}) {
  const salon = useCurrentSalon();
  const menu = useServiceMenu();
  const contacts = useClientContacts(true);
  const invalidate = useInvalidateAfterImport();
  const [error, setError] = useState<string | null>(null);
  const [now] = useState(() => Date.now());
  const plan = useMemo(
    () => buildAppointmentImport(loaded.table, loaded.mapping, { timeZone: salon.timezone, now }),
    [loaded, salon.timezone, now],
  );
  const people = useMemo(() => appointmentClients(plan.appointments), [plan]);
  const matches = useMemo(
    () =>
      previewClientMatches(
        people.clients.map((c) => ({
          name: c.name,
          phone: c.phone ?? null,
          email: c.email ?? null,
        })),
        contacts.data ?? [],
      ),
    [people, contacts.data],
  );
  const names = useMemo(
    () => (menu.data ? importedServiceNames(plan.appointments, menu.data) : []),
    [plan, menu.data],
  );
  const items = useMemo(() => (menu.data ? menuItems(menu.data) : []), [menu.data]);
  const [choices, setChoices] = useState<Record<string, ServiceChoice> | null>(null);
  const effective = choices ?? defaultServiceChoices(names);
  const [editing, setEditing] = useState<string | null>(null);
  const editingName = names.find((n) => n.key === editing);
  const unresolved = names.filter((n) => (effective[n.key] ?? BLOCK_TIME) === BLOCK_TIME).length;
  const choiceLabel = (choice: ServiceChoice | undefined) =>
    items.find((i) => i.id === choice)?.name ?? 'Block the time only';

  const run = async () => {
    const data = menu.data;
    if (!data) return;
    setError(null);
    const total = people.clients.length + plan.appointments.length;
    const label = 'Importing appointments…';
    const progress = (done: number) => setStep({ name: 'importing', done, total, label });
    progress(0);
    try {
      const clientResult = await runClientImport(salon.id, people.clients, progress);
      const ids = new Map(clientResult.results.map((r) => [r.index, r.clientId ?? null]));
      const payloads = plan.appointments.map((a, i) =>
        appointmentPayload(
          a,
          data,
          effective,
          ids.get(people.indexOf[i] ?? -1) ?? null,
          salon.timezone,
        ),
      );
      const result = await runAppointmentImport(salon.id, payloads, (done) =>
        progress(people.clients.length + done),
      );
      await invalidate();
      setStep({
        name: 'appointments-done',
        outcome: {
          result,
          labels: plan.appointments.map((a) => ({
            startsAt: a.startsAt,
            title: apptTitle(a),
            row: a.rows[0] ?? 0,
          })),
        },
      });
    } catch (e) {
      setError(errorText(e));
      setStep({ name: 'preview' });
    }
  };

  return (
    <View className="gap-1" testID="appointment-preview">
      <Card>
        <Stat label="Upcoming appointments" value={plan.appointments.length} />
        {contacts.data ? <Stat label="New clients to add" value={matches.newCount} /> : null}
        {plan.skipped.past ? (
          <Stat label="Past (skipped)" value={plan.skipped.past} tone="muted" />
        ) : null}
        {plan.skipped.cancelled ? (
          <Stat
            label="Cancelled or no-show (skipped)"
            value={plan.skipped.cancelled}
            tone="muted"
          />
        ) : null}
        {plan.errors.length ? (
          <Stat label="Rows skipped" value={plan.errors.length} tone="warning" />
        ) : null}
      </Card>
      <Text variant="footnote" tone="muted" className="px-1 pt-2">
        They’re booked as confirmed on your calendar ({salon.timezone}). Anything that overlaps an
        existing booking is left out and listed afterwards so you can decide.
      </Text>

      {names.length ? (
        <>
          <SectionHeader
            title={unresolved ? `Services · ${unresolved} not on your menu` : 'Services'}
          />
          <ListGroup>
            {names.map((n, i) => {
              const blocked = (effective[n.key] ?? BLOCK_TIME) === BLOCK_TIME;
              return (
                <ListRow
                  key={n.key}
                  title={n.name}
                  subtitle={`${n.count}× · ${choiceLabel(effective[n.key])}`}
                  trailing={
                    n.matchedId && !blocked ? null : (
                      <Badge
                        label={blocked ? 'No match' : 'Chosen'}
                        tone={blocked ? 'warning' : 'success'}
                      />
                    )
                  }
                  accessibilityHint="Choose which service this books as"
                  onPress={() => setEditing(n.key)}
                  last={i === names.length - 1}
                />
              );
            })}
          </ListGroup>
          <Text variant="footnote" tone="muted" className="px-1 pt-2">
            Menu services use your timeline, so processing time stays open for other clients. “Block
            the time only” keeps Vagaro’s start and length.
          </Text>
        </>
      ) : null}

      <SectionHeader title="Next up" />
      <ListGroup>
        {plan.appointments.slice(0, 5).map((a, i, list) => {
          const at = Date.parse(a.startsAt);
          return (
            <ListRow
              key={a.key}
              title={`${formatDay(at, salon.timezone)} · ${formatTime(at, salon.timezone)}`}
              subtitle={apptTitle(a)}
              chevron={false}
              last={i === list.length - 1}
            />
          );
        })}
      </ListGroup>

      <Issues title="Skipped rows" issues={plan.errors} />
      <Issues title="Values left out" issues={plan.warnings} />

      {error ? (
        <Text variant="footnote" tone="destructive" className="px-1 pt-3" testID="import-error">
          {error}
        </Text>
      ) : null}
      <View className="flex-row gap-3 pt-5">
        <Button label="Back" variant="outline" grow onPress={onBack} />
        <Button
          label={`Import ${plan.appointments.length}`}
          accessibilityLabel={`Import ${plural(plan.appointments.length, 'appointment')}`}
          grow
          loading={menu.isPending}
          disabled={!plan.appointments.length || !menu.data}
          onPress={() => void run()}
        />
      </View>

      <Sheet
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        title={editingName?.name ?? ''}
        subtitle="Book it as"
      >
        <ListGroup>
          {[{ id: BLOCK_TIME, name: 'Block the time only' }, ...items].map((item, i, list) => (
            <ListRow
              key={item.id}
              title={item.name}
              chevron={false}
              trailing={
                editing !== null && (effective[editing] ?? BLOCK_TIME) === item.id ? (
                  <Icon name="checkmark" color="primary" />
                ) : null
              }
              onPress={() => {
                if (editing) setChoices({ ...effective, [editing]: item.id });
                setEditing(null);
              }}
              last={i === list.length - 1}
            />
          ))}
        </ListGroup>
      </Sheet>
    </View>
  );
}

function ClientResults({
  result,
  loaded,
  onRestart,
}: {
  result: ImportClientsResult;
  loaded: Loaded;
  onRestart: () => void;
}) {
  const plan = useMemo(() => buildClientImport(loaded.table, loaded.mapping), [loaded]);
  const invalid = result.results.filter((r) => r.status === 'invalid');
  return (
    <View className="gap-1" testID="client-results">
      <Card className="flex-row items-center gap-3">
        <Icon name="checkmark-circle" color="success" size={32} />
        <Text variant="headline" className="flex-1">
          Clients imported
        </Text>
      </Card>
      <Card className="mt-3">
        <Stat label="Added" value={result.created} />
        <Stat label="Updated" value={result.updated} />
        <Stat label="Already up to date" value={result.unchanged} tone="muted" />
        {result.invalid ? (
          <Stat label="Couldn’t import" value={result.invalid} tone="warning" />
        ) : null}
      </Card>
      <Issues
        title="Not imported"
        issues={invalid.map((r) => ({
          row: plan.clients[r.index]?.rows[0] ?? r.index + 1,
          message: `${plan.clients[r.index]?.name ?? ''}: ${r.message ?? 'Invalid'}`,
        }))}
      />
      <View className="pt-6">
        <Button label="Import another file" variant="outline" fullWidth onPress={onRestart} />
      </View>
    </View>
  );
}

function AppointmentResults({
  outcome: { result, labels },
  onRestart,
}: {
  outcome: AppointmentOutcome;
  onRestart: () => void;
}) {
  const salon = useCurrentSalon();
  const conflicts = result.results.filter((r) => r.status === 'conflict');
  const invalid = result.results.filter((r) => r.status === 'invalid');
  const when = (iso: string | undefined) => {
    if (!iso) return '';
    const ms = Date.parse(iso);
    return `${formatDay(ms, salon.timezone)} · ${formatTime(ms, salon.timezone)}`;
  };
  return (
    <View className="gap-1" testID="appointment-results">
      <Card className="flex-row items-center gap-3">
        <Icon
          name={conflicts.length ? 'alert-circle' : 'checkmark-circle'}
          color={conflicts.length ? 'warning' : 'success'}
          size={32}
        />
        <Text variant="headline" className="flex-1">
          {conflicts.length ? 'Imported, with overlaps to check' : 'Appointments imported'}
        </Text>
      </Card>
      <Card className="mt-3">
        <Stat label="Booked" value={result.booked} />
        {result.duplicate ? (
          <Stat label="Already imported" value={result.duplicate} tone="muted" />
        ) : null}
        {result.past ? (
          <Stat label="Already started (skipped)" value={result.past} tone="muted" />
        ) : null}
        {result.conflict ? (
          <Stat label="Overlaps (not booked)" value={result.conflict} tone="warning" />
        ) : null}
        {result.invalid ? (
          <Stat label="Couldn’t import" value={result.invalid} tone="warning" />
        ) : null}
      </Card>

      {conflicts.length ? (
        <>
          <SectionHeader title="Overlaps" />
          <ListGroup>
            {conflicts.map((r, i) => {
              const l = labels[r.index];
              return (
                <ListRow
                  key={r.index}
                  title={l?.title ?? 'Appointment'}
                  subtitle={
                    r.conflict
                      ? `${when(l?.startsAt)} · overlaps ${r.conflict.clientName ?? 'a booking'} (${formatTime(Date.parse(r.conflict.startsAt), salon.timezone)})`
                      : `${when(l?.startsAt)} · ${r.message ?? 'overlaps another booking'}`
                  }
                  chevron={false}
                  last={i === conflicts.length - 1}
                />
              );
            })}
          </ListGroup>
          <Text variant="footnote" tone="muted" className="px-1 pt-2">
            These weren’t booked. Decide which to keep and book the other yourself, or free the time
            and import the file again: only what’s missing gets added.
          </Text>
        </>
      ) : null}
      <Issues
        title="Not imported"
        issues={invalid.map((r) => ({
          row: labels[r.index]?.row ?? r.index + 1,
          message: `${labels[r.index]?.title ?? ''}: ${r.message ?? 'Invalid'}`,
        }))}
      />
      <View className="pt-6">
        <Button label="Import another file" variant="outline" fullWidth onPress={onRestart} />
      </View>
    </View>
  );
}
