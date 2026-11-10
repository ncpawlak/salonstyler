import { addDays, formatLocalDate, parseLocalDate, toSalonDate } from '@chairside/core';
import {
  OFFER_MINUTE_OPTIONS,
  type WaitlistEntry,
  type WaitlistOffer,
} from '@chairside/db/waitlist';
import { useMemo, useState } from 'react';
import { Switch, View } from 'react-native';

import { DetailScreen } from '@/components/shell/screen';
import {
  Badge,
  Button,
  Card,
  Chip,
  EmptyState,
  Icon,
  Input,
  ListGroup,
  ListRow,
  SectionHeader,
  SkeletonRow,
  Text,
} from '@/components/ui';
import { errorMessage, useClients } from '@/features/appointments/api';
import { formatDay, formatLocalDateLong, formatTime } from '@/features/appointments/format';
import { webOrigin } from '@/features/client-self-service/api';
import { SEND_ICON, SEND_LABEL, sendClientText } from '@/features/replies/send';
import { useServiceMenu } from '@/features/services/data';
import {
  useAddWaitlistEntry,
  useCheckWaitlist,
  useDismissWaitlistOffer,
  useRemoveWaitlistEntry,
  useSendWaitlistOffer,
  useUpdateWaitlistSettings,
  useWaitlist,
  useWaitlistSettings,
} from '@/features/waitlist/api';
import { WAITLIST_WINDOWS } from '@/features/waitlist/join';
import { offerText, windowLabel } from '@/features/waitlist/offer-text';
import { useCurrentSalon } from '@/providers/session-provider';

const minutesLabel = (m: number) => (m < 60 ? `${m} min` : `${m / 60} hr`);

/**
 * Settings → Waitlist (#21): who's waiting for which day, the offers the engine drafted when a
 * time freed up, and the settings. Offers wait for the stylist to send them unless auto-offer
 * is on; the first client to claim one gets the time.
 */
export default function WaitlistScreen() {
  const salon = useCurrentSalon();
  const tz = salon.timezone;
  const list = useWaitlist(tz);
  const check = useCheckWaitlist();
  const [notice, setNotice] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const byDay = useMemo(() => {
    const groups = new Map<string, WaitlistEntry[]>();
    for (const e of list.data ?? []) groups.set(e.day, [...(groups.get(e.day) ?? []), e]);
    return [...groups.entries()];
  }, [list.data]);

  return (
    <DetailScreen title="Waitlist">
      <View className="gap-1">
        <WaitlistSettingsCard />

        <View className="flex-row items-center justify-between pt-2">
          <SectionHeader title="Waiting" />
          <View className="flex-row gap-2">
            <Button
              size="sm"
              variant="ghost"
              icon="refresh"
              label="Check now"
              loading={check.isPending}
              onPress={() =>
                check.mutate(undefined, {
                  onSuccess: (r) =>
                    setNotice(
                      r.offers
                        ? `${r.offers} new offer${r.offers === 1 ? '' : 's'}.`
                        : 'No new openings fit anyone waiting.',
                    ),
                })
              }
            />
            <Button
              size="sm"
              variant="outline"
              icon="add"
              label="Add"
              onPress={() => setAdding((v) => !v)}
            />
          </View>
        </View>
        {notice ? (
          <Text variant="footnote" tone="success" accessibilityLiveRegion="polite">
            {notice}
          </Text>
        ) : null}
        {check.error ? (
          <Text variant="footnote" tone="destructive">
            {errorMessage(check.error)}
          </Text>
        ) : null}

        {adding ? <AddEntryCard onDone={() => setAdding(false)} /> : null}

        {list.isPending ? (
          <View className="gap-3">
            <SkeletonRow />
            <SkeletonRow />
          </View>
        ) : list.error ? (
          <EmptyState
            icon="cloud-offline-outline"
            title="Couldn't load the waitlist"
            message={errorMessage(list.error)}
            actionLabel="Try again"
            onAction={() => void list.refetch()}
          />
        ) : byDay.length === 0 ? (
          <EmptyState
            icon="time-outline"
            title="No one is waiting"
            message="Clients can join from your booking page when nothing fits, or add them here. When an appointment is cancelled, the waitlist gets first dibs."
          />
        ) : (
          byDay.map(([day, entries]) => (
            <View key={day} className="gap-2 pt-2">
              <Text variant="subhead" tone="muted">
                {formatLocalDateLong(day)}
              </Text>
              {entries.map((e) => (
                <EntryCard key={e.id} entry={e} timeZone={tz} />
              ))}
            </View>
          ))
        )}
      </View>
    </DetailScreen>
  );
}

const ENTRY_STATUS: Record<
  WaitlistEntry['status'],
  { label: string; tone?: 'primary' | 'warning' | 'success' }
> = {
  waiting: { label: 'Waiting', tone: 'primary' },
  offered: { label: 'Offered', tone: 'warning' },
  booked: { label: 'Booked', tone: 'success' },
  expired: { label: 'Ended' },
  cancelled: { label: 'Left' },
};

function EntryCard({ entry, timeZone }: { entry: WaitlistEntry; timeZone: string }) {
  const remove = useRemoveWaitlistEntry();
  const status = ENTRY_STATUS[entry.status];
  const window = windowLabel(entry.windowStart, entry.windowEnd) ?? 'Any time';
  const open = entry.offers.filter((o) => o.status === 'draft' || o.status === 'sent');

  return (
    <Card className="gap-3" testID={`waitlist-entry-${entry.id}`}>
      <View className="flex-row items-start gap-3">
        <View className="flex-1 gap-0.5">
          <Text variant="headline">{entry.clientName}</Text>
          <Text variant="footnote" tone="muted">
            {entry.servicesLabel} · {window}
            {entry.source === 'public' ? ' · joined online' : ''}
          </Text>
        </View>
        <Badge label={status.label} tone={status.tone} />
      </View>
      {open.map((o) => (
        <OfferRow key={o.id} entry={entry} offer={o} timeZone={timeZone} />
      ))}
      {entry.status === 'waiting' || entry.status === 'offered' ? (
        <Button
          size="sm"
          variant="ghost"
          label="Remove from waitlist"
          loading={remove.isPending}
          onPress={() => remove.mutate(entry.id)}
        />
      ) : null}
      {remove.error ? (
        <Text variant="footnote" tone="destructive">
          {errorMessage(remove.error)}
        </Text>
      ) : null}
    </Card>
  );
}

function OfferRow({
  entry,
  offer,
  timeZone,
}: {
  entry: WaitlistEntry;
  offer: WaitlistOffer;
  timeZone: string;
}) {
  const send = useSendWaitlistOffer();
  const dismiss = useDismissWaitlistOffer();
  const [result, setResult] = useState<string | null>(null);
  const at = Date.parse(offer.startsAt);
  const when = `${formatDay(at, timeZone)} · ${formatTime(at, timeZone)}`;

  const sendText = () =>
    send.mutate(
      { offerId: offer.id, via: 'text' },
      {
        onSuccess: async (sent) => {
          if (!sent) return;
          try {
            const r = await sendClientText({ to: sent.phone, body: offerText(sent, webOrigin()) });
            setResult(r === 'copied' ? 'Offer copied. Paste it into a text.' : 'Offer sent.');
          } catch (e) {
            setResult(e instanceof Error ? e.message : 'Couldn’t open Messages');
          }
        },
      },
    );

  return (
    <View className="gap-2 rounded-lg bg-muted p-3" testID={`waitlist-offer-${offer.id}`}>
      <View className="flex-row items-center gap-2">
        <Icon name="sparkles-outline" size={18} color="primary" />
        <Text variant="body" className="flex-1">
          {offer.status === 'draft' ? 'Opening fits: ' : 'Offered: '}
          {when}
        </Text>
      </View>
      {offer.status === 'sent' && offer.expiresAt ? (
        <Text variant="footnote" tone="muted">
          Sent by {offer.sentVia}; open until {formatTime(Date.parse(offer.expiresAt), timeZone)}.
        </Text>
      ) : null}
      {offer.status === 'draft' ? (
        <View className="flex-row flex-wrap gap-2">
          <Button
            size="sm"
            icon={SEND_ICON}
            label={`${SEND_LABEL} text offer`}
            disabled={!entry.clientPhone}
            loading={send.isPending && send.variables?.via === 'text'}
            onPress={sendText}
          />
          {entry.clientEmail ? (
            <Button
              size="sm"
              variant="outline"
              icon="mail-outline"
              label="Email offer"
              loading={send.isPending && send.variables?.via === 'email'}
              onPress={() =>
                send.mutate(
                  { offerId: offer.id, via: 'email' },
                  { onSuccess: () => setResult(`Offer emailed to ${entry.clientEmail}.`) },
                )
              }
            />
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            label="Dismiss"
            loading={dismiss.isPending}
            onPress={() => dismiss.mutate(offer.id)}
          />
        </View>
      ) : null}
      {result ? (
        <Text variant="footnote" tone="success" accessibilityLiveRegion="polite">
          {result}
        </Text>
      ) : null}
      {send.error || dismiss.error ? (
        <Text variant="footnote" tone="destructive">
          {errorMessage(send.error ?? dismiss.error)}
        </Text>
      ) : null}
    </View>
  );
}

function WaitlistSettingsCard() {
  const salon = useCurrentSalon();
  const isOwner = salon.role === 'owner';
  const settings = useWaitlistSettings();
  const update = useUpdateWaitlistSettings();
  const saved = settings.data;
  if (!saved) return null;
  const disabled = !isOwner || update.isPending;

  return (
    <Card className="gap-4">
      <ToggleRow
        label="Waitlist"
        hint="Clients can join from your booking page when nothing fits."
        value={saved.waitlist_enabled}
        disabled={disabled}
        onChange={(v) => update.mutate({ waitlist_enabled: v })}
      />
      <ToggleRow
        label="Send offers automatically"
        hint="Off: offers wait here for you to send. On: matching clients are emailed right away."
        value={saved.waitlist_auto_offer}
        disabled={disabled || !saved.waitlist_enabled}
        onChange={(v) => update.mutate({ waitlist_auto_offer: v })}
      />
      <View className="gap-2">
        <Text variant="body">Offers stay open for</Text>
        <View className="flex-row flex-wrap gap-2">
          {OFFER_MINUTE_OPTIONS.map((m) => (
            <Chip
              key={m}
              label={minutesLabel(m)}
              selected={saved.waitlist_offer_minutes === m}
              onPress={disabled ? undefined : () => update.mutate({ waitlist_offer_minutes: m })}
            />
          ))}
        </View>
      </View>
      {!isOwner ? (
        <Text variant="footnote" tone="warning">
          Only the salon owner can change these.
        </Text>
      ) : null}
      {update.error ? (
        <Text variant="footnote" tone="destructive">
          {errorMessage(update.error)}
        </Text>
      ) : null}
    </Card>
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
  hint: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <View className="flex-row items-center gap-3">
      <View className="flex-1 gap-0.5">
        <Text variant="body">{label}</Text>
        <Text variant="footnote" tone="muted">
          {hint}
        </Text>
      </View>
      <Switch
        accessibilityLabel={label}
        value={value}
        onValueChange={onChange}
        disabled={disabled}
      />
    </View>
  );
}

const DAYS_SHOWN = 14;

function AddEntryCard({ onDone }: { onDone: () => void }) {
  const salon = useCurrentSalon();
  const [search, setSearch] = useState('');
  const clients = useClients(search);
  const menu = useServiceMenu();
  const add = useAddWaitlistEntry();
  const [clientId, setClientId] = useState<string | null>(null);
  const [serviceId, setServiceId] = useState<string | null>(null);
  const [windowKey, setWindowKey] = useState<(typeof WAITLIST_WINDOWS)[number]['key']>('any');

  const [days] = useState(() => {
    const today = parseLocalDate(toSalonDate(Date.now(), salon.timezone));
    return Array.from({ length: DAYS_SHOWN }, (_, i) => formatLocalDate(addDays(today, i)));
  });
  const [day, setDay] = useState(days[0]!);
  const services = useMemo(
    () =>
      [...(menu.data?.services ?? []), ...(menu.data?.combos ?? [])].filter((s) => !s.archivedAt),
    [menu.data],
  );
  const client = clients.data?.find((c) => c.id === clientId);
  const service = services.find((s) => s.id === serviceId);
  const span = WAITLIST_WINDOWS.find((w) => w.key === windowKey)!;

  return (
    <Card className="gap-3">
      <Text variant="headline">Add to the waitlist</Text>
      <Input
        label="Client"
        placeholder="Search by name or phone"
        value={search}
        onChangeText={(t) => {
          setSearch(t);
          setClientId(null);
        }}
      />
      {client ? (
        <Chip label={client.name} selected onPress={() => setClientId(null)} />
      ) : (
        <ListGroup>
          {(clients.data ?? []).slice(0, 5).map((c, i, all) => (
            <ListRow
              key={c.id}
              title={c.name}
              subtitle={c.phone ?? c.email ?? undefined}
              onPress={() => setClientId(c.id)}
              last={i === all.length - 1}
            />
          ))}
        </ListGroup>
      )}
      <Text variant="subhead" tone="muted">
        Service
      </Text>
      <View className="flex-row flex-wrap gap-2">
        {services.map((s) => (
          <Chip
            key={s.id}
            label={s.name}
            selected={s.id === serviceId}
            onPress={() => setServiceId(s.id)}
          />
        ))}
      </View>
      <Text variant="subhead" tone="muted">
        Day
      </Text>
      <View className="flex-row flex-wrap gap-2">
        {days.map((d) => (
          <Chip
            key={d}
            label={formatLocalDateLong(d)}
            selected={d === day}
            onPress={() => setDay(d)}
          />
        ))}
      </View>
      <View className="flex-row flex-wrap gap-2">
        {WAITLIST_WINDOWS.map((w) => (
          <Chip
            key={w.key}
            label={w.label}
            selected={w.key === windowKey}
            onPress={() => setWindowKey(w.key)}
          />
        ))}
      </View>
      {add.error ? (
        <Text variant="footnote" tone="destructive">
          {errorMessage(add.error)}
        </Text>
      ) : null}
      <View className="flex-row gap-2">
        <Button grow variant="outline" label="Cancel" onPress={onDone} />
        <Button
          grow
          label="Add"
          disabled={!client || !service}
          loading={add.isPending}
          onPress={() =>
            add.mutate(
              {
                clientId: client!.id,
                items: [{ serviceId: service!.id }],
                servicesLabel: service!.name,
                day,
                windowStart: span.start,
                windowEnd: span.end,
              },
              { onSuccess: onDone },
            )
          }
        />
      </View>
    </Card>
  );
}
