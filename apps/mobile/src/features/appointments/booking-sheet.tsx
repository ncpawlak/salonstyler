import { formatDuration, planBooking, type WorkHours } from '@chairside/core';
import type { AppointmentWithDetails, ClientRow, ServiceMenu } from '@chairside/db';
import { useMemo, useState } from 'react';
import { View } from 'react-native';

import {
  Avatar,
  Button,
  Chip,
  Input,
  ListGroup,
  ListRow,
  SegmentedControl,
  Sheet,
  Text,
} from '@/components/ui';
import { haptics } from '@/lib/haptics';

import { formatPrice, useServiceMenu } from '../services/data';
import {
  errorMessage,
  useAddClient,
  useBookAppointment,
  useClients,
  useRescheduleAppointment,
} from './api';
import { formatDay, formatTime } from './format';
import {
  resolveSelection,
  selectionFromSnapshots,
  type BookingItem,
  type BookingSelection,
} from './selection';

export type BookingTarget =
  | { kind: 'new'; start: number; client?: PickedClient }
  | { kind: 'edit'; appointment: AppointmentWithDetails };

export interface BookingSheetProps {
  target: BookingTarget | null;
  onClose: () => void;
  hours: WorkHours;
  gridMinutes: number;
  /** Everything on the calendar around the target (the edited appointment is excluded here). */
  appointments: readonly AppointmentWithDetails[];
}

const statusOptions = [
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'held', label: 'Hold' },
] as const;

const WARNING_TEXT = {
  'outside-hours': 'This is outside your work hours.',
  'lead-time': 'This is sooner than your minimum notice.',
  'booking-window': 'This is further out than your booking window.',
} as const;

type PickedClient = Pick<ClientRow, 'id' | 'name' | 'phone'>;

export function BookingSheet({
  target,
  onClose,
  hours,
  gridMinutes,
  appointments,
}: BookingSheetProps) {
  const editing = target?.kind === 'edit' ? target.appointment : null;
  return (
    <Sheet
      open={!!target}
      onOpenChange={(open) => !open && onClose()}
      title={editing ? 'Edit services' : 'New appointment'}
      subtitle={
        target
          ? formatDay(
              target.kind === 'new' ? target.start : Date.parse(target.appointment.starts_at),
              hours.timeZone,
            )
          : undefined
      }
    >
      {target ? (
        <BookingForm
          // Remount per target so state resets between bookings.
          key={target.kind === 'new' ? `new-${target.start}` : `edit-${target.appointment.id}`}
          target={target}
          onDone={onClose}
          hours={hours}
          gridMinutes={gridMinutes}
          appointments={appointments}
        />
      ) : null}
    </Sheet>
  );
}

function BookingForm({
  target,
  onDone,
  hours,
  gridMinutes,
  appointments,
}: {
  target: BookingTarget;
  onDone: () => void;
  hours: WorkHours;
  gridMinutes: number;
  appointments: readonly AppointmentWithDetails[];
}) {
  const editing = target.kind === 'edit' ? target.appointment : null;
  const menu = useServiceMenu();
  const book = useBookAppointment();
  const reschedule = useRescheduleAppointment();

  const [client, setClient] = useState<PickedClient | null>(
    editing?.client ?? (target.kind === 'new' ? (target.client ?? null) : null),
  );
  const [selection, setSelection] = useState<BookingSelection>(
    editing ? selectionFromSnapshots(editing.services) : { items: [], adjustMinutes: 0 },
  );
  const [start, setStart] = useState(
    target.kind === 'new' ? target.start : Date.parse(target.appointment.starts_at),
  );
  const [status, setStatus] = useState<'confirmed' | 'held'>('confirmed');
  const [openedAt] = useState(() => Date.now());
  // Tied to the plan it came from, so changing the booking clears it.
  const [serverError, setServerError] = useState<{ plan: unknown; text: string } | null>(null);

  const resolved = useMemo(
    () => (menu.data ? resolveSelection(menu.data, selection) : null),
    [menu.data, selection],
  );

  const plan = useMemo(() => {
    if (!resolved) return null;
    const others = appointments.filter((a) => a.id !== editing?.id);
    return planBooking({
      service: resolved.service,
      start,
      hours,
      existing: others.map((a) => ({ id: a.id, segments: a.segments })),
      names: Object.fromEntries(others.map((a) => [a.id, a.client?.name ?? 'a walk-in'])),
      now: openedAt,
    });
  }, [resolved, start, hours, appointments, editing?.id, openedAt]);

  const priceCents = useMemo(() => {
    if (!menu.data || !resolved) return null;
    let total = 0;
    for (const item of selection.items) {
      const def =
        menu.data.services.find((s) => s.id === item.serviceId) ??
        menu.data.combos.find((c) => c.id === item.serviceId);
      if (def?.priceCents == null) return null;
      total += def.priceCents;
    }
    return total;
  }, [menu.data, resolved, selection.items]);

  const pending = book.isPending || reschedule.isPending;
  const canSubmit = !!plan?.ok && !!resolved && (editing || client) && !pending;

  const submit = async () => {
    if (!plan?.ok || !resolved) return;
    setServerError(null);
    try {
      if (editing) {
        await reschedule.mutateAsync({
          id: editing.id,
          segments: plan.segments,
          services: resolved.snapshots,
          priceCents,
        });
      } else {
        await book.mutateAsync({
          clientId: client!.id,
          segments: plan.segments,
          services: resolved.snapshots,
          status,
          source: 'owner',
          priceCents,
        });
      }
      haptics.success();
      onDone();
    } catch (e) {
      haptics.error();
      setServerError({ plan, text: errorMessage(e) });
    }
  };

  const message =
    (serverError?.plan === plan ? serverError.text : null) ??
    (plan && !plan.ok ? plan.message : null);

  return (
    <View className="gap-5">
      {editing ? null : <ClientPicker client={client} onChange={setClient} />}

      {menu.data ? (
        <ServicePicker
          menu={menu.data}
          items={selection.items}
          onChange={(items) => setSelection((s) => ({ ...s, items }))}
        />
      ) : (
        <Text tone="muted">Loading services…</Text>
      )}

      {resolved ? (
        <View className="gap-2">
          <Text variant="headline">When</Text>
          <Stepper
            label={`Starts ${formatTime(start, hours.timeZone)}`}
            decrementLabel={`${gridMinutes} minutes earlier`}
            incrementLabel={`${gridMinutes} minutes later`}
            onDecrement={() => setStart((s) => s - gridMinutes * 60_000)}
            onIncrement={() => setStart((s) => s + gridMinutes * 60_000)}
          />
          <Stepper
            label={`${formatDuration(resolved.totalMinutes)} chair time`}
            decrementLabel="15 minutes shorter"
            incrementLabel="15 minutes longer"
            onDecrement={() => setSelection((s) => ({ ...s, adjustMinutes: s.adjustMinutes - 15 }))}
            onIncrement={() => setSelection((s) => ({ ...s, adjustMinutes: s.adjustMinutes + 15 }))}
          />
          <Text variant="footnote" tone="muted">
            {resolved.summary}
            {plan?.ok ? ` · until ${formatTime(Date.parse(plan.end), hours.timeZone)}` : ''}
            {priceCents != null ? ` · ${formatPrice(priceCents)}` : ''}
          </Text>
        </View>
      ) : null}

      {editing ? null : (
        <SegmentedControl
          accessibilityLabel="Booking status"
          options={statusOptions}
          value={status}
          onChange={setStatus}
        />
      )}
      {status === 'held' && !editing ? (
        <Text variant="footnote" tone="muted">
          Holds keep the slot and release automatically if not confirmed.
        </Text>
      ) : null}

      {message ? (
        <View
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          className="rounded-xl bg-destructive/10 px-4 py-3"
        >
          <Text variant="subhead" tone="destructive">
            {message}
          </Text>
        </View>
      ) : null}
      {plan?.ok && plan.warning ? (
        <View accessibilityRole="alert" className="rounded-xl bg-warning/10 px-4 py-3">
          <Text variant="subhead">{WARNING_TEXT[plan.warning]}</Text>
        </View>
      ) : null}

      <Button
        label={
          editing
            ? 'Save changes'
            : !client
              ? 'Pick a client'
              : !resolved
                ? 'Pick a service'
                : plan?.ok && plan.warning
                  ? 'Book anyway'
                  : status === 'held'
                    ? 'Place hold'
                    : 'Book'
        }
        fullWidth
        size="lg"
        loading={pending}
        disabled={!canSubmit}
        onPress={submit}
      />
    </View>
  );
}

function Stepper({
  label,
  decrementLabel,
  incrementLabel,
  onDecrement,
  onIncrement,
}: {
  label: string;
  decrementLabel: string;
  incrementLabel: string;
  onDecrement: () => void;
  onIncrement: () => void;
}) {
  return (
    <View className="flex-row items-center gap-3 rounded-xl bg-card px-2 py-1.5">
      <Button
        variant="ghost"
        size="icon"
        icon="remove"
        accessibilityLabel={decrementLabel}
        onPress={() => {
          haptics.selection();
          onDecrement();
        }}
      />
      <Text variant="headline" numeric className="flex-1 text-center">
        {label}
      </Text>
      <Button
        variant="ghost"
        size="icon"
        icon="add"
        accessibilityLabel={incrementLabel}
        onPress={() => {
          haptics.selection();
          onIncrement();
        }}
      />
    </View>
  );
}

function ClientPicker({
  client,
  onChange,
}: {
  client: PickedClient | null;
  onChange: (client: PickedClient | null) => void;
}) {
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const clients = useClients(search);
  const add = useAddClient();

  if (client) {
    return (
      <View className="gap-2">
        <Text variant="headline">Client</Text>
        <ListGroup>
          <ListRow
            title={client.name}
            subtitle={client.phone ?? undefined}
            leading={<Avatar name={client.name} size={36} />}
            trailing={
              <Button variant="ghost" size="sm" label="Change" onPress={() => onChange(null)} />
            }
            last
          />
        </ListGroup>
      </View>
    );
  }

  if (creating) {
    const save = async () => {
      setError(null);
      try {
        const row = await add.mutateAsync({
          name: search.trim(),
          phone: phone.trim() || null,
          email: email.trim() || null,
        });
        haptics.success();
        onChange(row);
      } catch (e) {
        setError(errorMessage(e));
      }
    };
    return (
      <View className="gap-3">
        <Text variant="headline">New client</Text>
        <Input label="Name" value={search} onChangeText={setSearch} autoFocus />
        <Input
          label="Phone"
          value={phone}
          onChangeText={setPhone}
          keyboardType="phone-pad"
          autoComplete="tel"
        />
        <Input
          label="Email"
          value={email}
          onChangeText={setEmail}
          keyboardType="email-address"
          autoCapitalize="none"
          autoComplete="email"
          error={error ?? undefined}
        />
        <View className="flex-row gap-3">
          <Button variant="secondary" label="Back" grow onPress={() => setCreating(false)} />
          <Button
            label="Add client"
            grow
            loading={add.isPending}
            disabled={!search.trim()}
            onPress={save}
          />
        </View>
      </View>
    );
  }

  const results = (clients.data ?? []).slice(0, 6);
  return (
    <View className="gap-2">
      <Text variant="headline">Client</Text>
      <Input
        placeholder="Search name, phone or email"
        icon="search"
        value={search}
        onChangeText={setSearch}
        autoCapitalize="words"
        accessibilityLabel="Search clients"
      />
      {results.length > 0 ? (
        <ListGroup>
          {results.map((c, i) => (
            <ListRow
              key={c.id}
              title={c.name}
              subtitle={c.phone ?? c.email ?? undefined}
              leading={<Avatar name={c.name} size={32} />}
              onPress={() => {
                haptics.selection();
                onChange(c);
              }}
              last={i === results.length - 1}
            />
          ))}
        </ListGroup>
      ) : clients.isFetched ? (
        <Text variant="footnote" tone="muted">
          {search.trim() ? 'No matching clients.' : 'No clients yet.'}
        </Text>
      ) : null}
      <Button
        variant="outline"
        icon="person-add-outline"
        label={search.trim() ? `New client "${search.trim()}"` : 'New client'}
        onPress={() => setCreating(true)}
      />
    </View>
  );
}

function ServicePicker({
  menu,
  items,
  onChange,
}: {
  menu: ServiceMenu;
  items: BookingItem[];
  onChange: (items: BookingItem[]) => void;
}) {
  const options = [
    ...menu.services.filter((s) => !s.archivedAt),
    ...menu.combos.filter((c) => !c.archivedAt),
  ];
  const picked = new Set(items.map((i) => i.serviceId));
  const toggle = (id: string) => {
    haptics.selection();
    onChange(
      picked.has(id) ? items.filter((i) => i.serviceId !== id) : [...items, { serviceId: id }],
    );
  };
  const withVariants = items
    .map((i) => ({ item: i, service: menu.services.find((s) => s.id === i.serviceId) }))
    .filter((x) => x.service && x.service.variants.length > 0);

  return (
    <View className="gap-2">
      <Text variant="headline">Services</Text>
      {options.length === 0 ? (
        <Text variant="footnote" tone="muted">
          Add services in Settings → Services first.
        </Text>
      ) : (
        <View className="flex-row flex-wrap gap-2">
          {options.map((s) => (
            <Chip
              key={s.id}
              label={s.name}
              icon={s.isCombo ? 'layers-outline' : undefined}
              selected={picked.has(s.id)}
              onPress={() => toggle(s.id)}
            />
          ))}
        </View>
      )}
      {withVariants.map(({ item, service }) => (
        <View key={item.serviceId} className="gap-1.5">
          <Text variant="footnote" tone="muted">
            {service!.name}
          </Text>
          <View className="flex-row flex-wrap gap-2">
            <Chip
              label="Standard"
              selected={!item.variantId}
              onPress={() =>
                onChange(
                  items.map((i) => (i === item ? { serviceId: i.serviceId, variantId: null } : i)),
                )
              }
            />
            {service!.variants.map((v) => (
              <Chip
                key={v.id ?? v.name}
                label={`${v.name}${v.deltaMinutes ? ` (${v.deltaMinutes > 0 ? '+' : ''}${v.deltaMinutes}m)` : ''}`}
                selected={item.variantId === v.id}
                onPress={() =>
                  onChange(
                    items.map((i) =>
                      i === item ? { serviceId: i.serviceId, variantId: v.id ?? null } : i,
                    ),
                  )
                }
              />
            ))}
          </View>
        </View>
      ))}
    </View>
  );
}
