import { templateRunningLateDrafts, type ClientTextDraft } from '@chairside/ai/assistant';
import type { RunningLatePlan, RunningLateStrategy, WorkHours } from '@chairside/core';
import type { AppointmentWithDetails, ClientReplySource } from '@chairside/db';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';

import { Badge, Button, Chip, Icon, Input, Sheet, Skeleton, Text } from '@/components/ui';
import { cn } from '@/lib/cn';
import { haptics } from '@/lib/haptics';
import { supabase } from '@/lib/supabase';
import { useCurrentSalon } from '@/providers/session-provider';

import { errorMessage, useApplyRunningLate } from '../appointments/api';
import { formatTime } from '../appointments/format';
import { assistantApi } from '../assistant/api';
import { useRecordReply } from '../replies/api';
import { replySource } from '../replies/compose';
import { SEND_CHANNEL, SEND_ICON, SEND_LABEL, sendClientText } from '../replies/send';
import {
  defaultLateAppointment,
  describePlan,
  planOptions,
  RUNNING_LATE_PRESETS,
  runningLateCandidates,
  strategyLabel,
} from './running-late';
import { clientSpan } from './summary';

export interface RunningLateSheetProps {
  open: boolean;
  onClose: () => void;
  /** Today's appointments. */
  appointments: readonly AppointmentWithDetails[];
  hours: WorkHours;
  now: number;
  /** Preselected delay, e.g. from Ask Chairside ("I'm running 15 late"). */
  initialDelay?: number | null;
}

/**
 * "Running late" (issue #37): pick the delay, see who moves (computed by `@chairside/core`), review
 * the AI-drafted text for each client, then update the calendar in one go. Each text opens in
 * Messages with one tap (issue #7).
 */
export function RunningLateSheet({ open, onClose, initialDelay, ...rest }: RunningLateSheetProps) {
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title="Running late"
      subtitle="Move today’s clients and let them know"
    >
      {open ? (
        <RunningLateBody initialDelay={initialDelay ?? 15} onClose={onClose} {...rest} />
      ) : null}
    </Sheet>
  );
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

/** After Update, a text's source records whether the stylist edited it. */
type SentDraft = Omit<ClientTextDraft, 'source'> & { source: ClientReplySource };
type Applied = { plan: RunningLatePlan; drafts: SentDraft[] };

function RunningLateBody({
  appointments,
  hours,
  now,
  initialDelay,
  onClose,
}: Omit<RunningLateSheetProps, 'open' | 'initialDelay'> & { initialDelay: number }) {
  const salon = useCurrentSalon();
  const tz = hours.timeZone;
  const apply = useApplyRunningLate();
  const record = useRecordReply();

  // Freeze the day as it was when the sheet opened, so a refetch can't reshuffle the options.
  const [day] = useState(() => appointments);
  const [openedAt] = useState(now);
  const byId = useMemo(() => new Map(day.map((a) => [a.id, a])), [day]);
  const candidates = useMemo(() => runningLateCandidates(day, openedAt), [day, openedAt]);

  const [delay, setDelay] = useState(initialDelay);
  const [firstId, setFirstId] = useState(() => defaultLateAppointment(day, openedAt)?.id ?? null);
  const [strategy, setStrategy] = useState<RunningLateStrategy>('ripple');
  const [edits, setEdits] = useState<{ key: string; texts: Record<string, string> }>({
    key: '',
    texts: {},
  });
  const [applied, setApplied] = useState<Applied | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<Record<string, string>>({});

  const options = useMemo(
    () =>
      firstId
        ? planOptions({ appointments: day, hours, delayMinutes: delay, firstId, now: openedAt })
        : [],
    [day, hours, delay, firstId, openedAt],
  );
  const live = options.find((o) => o.strategy === strategy) ?? options[0] ?? null;
  const plan = applied?.plan ?? live;
  const movesKey = plan ? plan.moves.map((m) => `${m.id}@${m.to.start}`).join(',') : '';

  const request = useMemo(
    () =>
      plan?.ok && plan.moves.length
        ? {
            key: `${plan.delayMinutes}|${movesKey}`,
            body: {
              delayMinutes: plan.delayMinutes,
              moves: plan.moves.map((m) => ({ appointmentId: m.id, newStart: m.to.start })),
            },
          }
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by movesKey
    [movesKey, plan?.ok, plan?.delayMinutes],
  );
  // Tapping through delays shouldn't call the model for every intermediate choice.
  const settled = useDebounced(request, 600);
  const drafting = useQuery({
    queryKey: ['running-late-drafts', salon.id, settled?.key],
    queryFn: () => assistantApi(supabase, salon.id).draftRunningLate(settled!.body),
    enabled: !applied && !!settled && settled.key === request?.key,
    staleTime: Infinity,
    retry: false,
  });

  const fallback = useMemo(
    () =>
      plan
        ? templateRunningLateDrafts({
            salonName: salon.name,
            timeZone: tz,
            delayMinutes: plan.delayMinutes,
            items: plan.moves.map((m) => ({
              appointmentId: m.id,
              clientName: byId.get(m.id)?.client?.name ?? null,
              oldStart: m.from.start,
              newStart: m.to.start,
            })),
          })
        : [],
    [plan, salon.name, tz, byId],
  );
  const ready = !!request && drafting.data && settled?.key === request.key;
  const drafts: SentDraft[] =
    applied?.drafts ??
    (ready ? drafting.data!.drafts : drafting.isError && request ? fallback : []);
  const draftsLoading = !applied && !!request && !ready && !drafting.isError;
  const texts = edits.key === movesKey ? edits.texts : {};
  const textFor = (id: string) => texts[id] ?? drafts.find((d) => d.appointmentId === id)?.text;
  const notice = applied
    ? null
    : drafting.isError
      ? 'Couldn’t reach Ask Chairside, so these are standard texts.'
      : ready
        ? drafting.data!.notice
        : null;

  const editText = (id: string, text: string) =>
    setEdits((e) => ({
      key: movesKey,
      texts: { ...(e.key === movesKey ? e.texts : {}), [id]: text },
    }));

  const send = async (id: string) => {
    const text = textFor(id)?.trim();
    const draft = drafts.find((d) => d.appointmentId === id) ?? null;
    if (!text) return;
    setError(null);
    const client = byId.get(id)?.client ?? null;
    try {
      const result = await sendClientText({ to: client?.phone ?? null, body: text });
      if (result === 'cancelled') return;
      haptics.success();
      setSent((s) => ({ ...s, [id]: result === 'copied' ? 'Copied' : 'Sent' }));
      await record.mutateAsync({
        kind: 'running_late',
        body: text,
        channel: SEND_CHANNEL,
        source: replySource(draft, text),
        toPhone: client?.phone ?? null,
        appointmentId: id,
        clientId: client?.id ?? null,
      });
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const confirm = async () => {
    if (!plan?.ok || !plan.moves.length) return;
    setError(null);
    const finalDrafts = plan.moves.map((m) => {
      const d =
        drafts.find((x) => x.appointmentId === m.id) ??
        fallback.find((x) => x.appointmentId === m.id)!;
      const text = textFor(m.id) ?? d.text;
      return { ...d, text, source: replySource(d, text) };
    });
    try {
      await apply.mutateAsync({
        delayMinutes: plan.delayMinutes,
        strategy: plan.strategy,
        moves: plan.moves.map((m) => ({ appointmentId: m.id, segments: m.segments })),
      });
      haptics.success();
      setApplied({ plan, drafts: finalDrafts });
    } catch (e) {
      haptics.error();
      setError(errorMessage(e));
    }
  };

  if (!candidates.length) {
    return (
      <View className="items-center gap-3 py-6">
        <Icon name="checkmark-done" color="success" />
        <Text variant="subhead" tone="muted" className="text-center">
          Nobody else is booked today, so there’s no one to move.
        </Text>
        <Button label="Close" variant="secondary" onPress={onClose} />
      </View>
    );
  }

  const first = firstId ? byId.get(firstId) : undefined;
  const unchanged = plan?.unchanged.map((id) => byId.get(id)).filter(Boolean) ?? [];

  return (
    <View className="gap-5" testID="running-late-sheet">
      {applied ? (
        <View
          accessibilityRole="alert"
          className="flex-row items-center gap-2 rounded-xl bg-success/10 px-4 py-3"
        >
          <Icon name="checkmark-circle" color="success" />
          <Text variant="subhead" className="flex-1">
            Calendar updated. Send each client their text below.
          </Text>
        </View>
      ) : (
        <>
          <View className="gap-2">
            <Text variant="footnote" tone="muted" className="font-medium">
              How late?
            </Text>
            <View className="flex-row flex-wrap gap-2">
              {RUNNING_LATE_PRESETS.map((m) => (
                <Chip
                  key={m}
                  label={`${m} min`}
                  selected={delay === m}
                  onPress={() => setDelay(m)}
                />
              ))}
              {!RUNNING_LATE_PRESETS.includes(delay as never) ? (
                <Chip label={`${delay} min`} selected />
              ) : null}
            </View>
          </View>

          {candidates.length > 1 ? (
            <View className="gap-2">
              <Text variant="footnote" tone="muted" className="font-medium">
                Starting with
              </Text>
              <View className="flex-row flex-wrap gap-2">
                {candidates.slice(0, 6).map((a) => (
                  <Chip
                    key={a.id}
                    label={`${a.client?.name.split(/\s+/)[0] ?? 'Walk-in'} · ${formatTime(clientSpan(a).start, tz)}`}
                    selected={a.id === firstId}
                    onPress={() => setFirstId(a.id)}
                  />
                ))}
              </View>
            </View>
          ) : null}

          {options.length > 1 ? (
            <View className="gap-2" accessibilityRole="radiogroup">
              {options.map((o) => {
                const selected = o.strategy === plan?.strategy;
                return (
                  <Pressable
                    key={o.strategy}
                    accessibilityRole="radio"
                    accessibilityState={{ selected, disabled: !o.ok }}
                    accessibilityLabel={strategyLabel(o.strategy, first)}
                    disabled={!o.ok}
                    onPress={() => {
                      haptics.selection();
                      setStrategy(o.strategy);
                    }}
                    className={cn(
                      'flex-row items-center gap-3 rounded-xl border px-4 py-3',
                      selected ? 'border-primary bg-primary-soft' : 'border-border bg-card',
                      !o.ok && 'opacity-50',
                    )}
                  >
                    <Icon
                      name={selected ? 'radio-button-on' : 'radio-button-off'}
                      color={selected ? 'primary' : 'muted-foreground'}
                    />
                    <View className="flex-1">
                      <Text variant="subhead" className="font-semibold">
                        {strategyLabel(o.strategy, first)}
                      </Text>
                      <Text variant="footnote" tone={o.ok ? 'muted' : 'destructive'}>
                        {describePlan(o, byId)}
                      </Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>
          ) : null}
        </>
      )}

      {plan && plan.moves.length ? (
        <View className="gap-3">
          <Text variant="footnote" tone="muted" className="font-medium">
            {applied ? 'Texts to send' : `Affected · ${plan.moves.length}`}
          </Text>
          {plan.moves.map((m) => {
            const appt = byId.get(m.id);
            const text = textFor(m.id);
            const source = drafts.find((d) => d.appointmentId === m.id)?.source;
            return (
              <View
                key={m.id}
                className="gap-2 rounded-xl border border-border bg-card p-3"
                testID={`running-late-move-${m.id}`}
              >
                <View className="flex-row items-center gap-2">
                  <Text variant="subhead" className="flex-1 font-semibold" numberOfLines={1}>
                    {appt?.client?.name ?? 'Walk-in'}
                  </Text>
                  <Text variant="subhead" numeric tone="muted">
                    {formatTime(Date.parse(m.from.start), tz)} →{' '}
                  </Text>
                  <Text variant="subhead" numeric className="font-semibold">
                    {formatTime(Date.parse(m.to.start), tz)}
                  </Text>
                  <Badge label={`+${m.shiftMinutes}`} tone="warning" />
                </View>
                {draftsLoading && text === undefined ? (
                  <Skeleton height={64} />
                ) : text !== undefined ? (
                  <>
                    <Input
                      value={text}
                      onChangeText={(t) => editText(m.id, t)}
                      multiline
                      numberOfLines={4}
                      textAlignVertical="top"
                      maxLength={480}
                      accessibilityLabel={`Text to ${appt?.client?.name ?? 'client'}`}
                      editable={!applied}
                    />
                    <View className="flex-row items-center gap-2">
                      <Text variant="caption" tone="subtle" className="flex-1">
                        {appt?.client?.phone ?? 'No phone on file'}
                        {source === 'ai' ? ' · Drafted by Ask Chairside' : ''}
                      </Text>
                      <Button
                        size="sm"
                        variant={applied ? 'primary' : 'outline'}
                        icon={sent[m.id] ? 'checkmark' : SEND_ICON}
                        label={sent[m.id] ?? SEND_LABEL}
                        accessibilityLabel={` text to ${appt?.client?.name ?? 'client'}`}
                        onPress={() => void send(m.id)}
                      />
                    </View>
                  </>
                ) : null}
              </View>
            );
          })}
        </View>
      ) : plan ? (
        <Text variant="subhead" tone="muted">
          Nobody needs to move.
        </Text>
      ) : null}

      {unchanged.length ? (
        <Text variant="footnote" tone="muted">
          Still on time: {unchanged.map((a) => a!.client?.name ?? 'walk-in').join(', ')}.
        </Text>
      ) : null}
      {plan?.overtimeMinutes ? (
        <Text variant="footnote" tone="warning">
          You’ll finish {plan.overtimeMinutes} min past your hours.
        </Text>
      ) : null}
      {notice ? (
        <Text variant="footnote" tone="subtle">
          {notice}
        </Text>
      ) : null}
      {error ? (
        <Text variant="subhead" tone="destructive" accessibilityRole="alert">
          {error}
        </Text>
      ) : null}

      {applied ? (
        <Button label="Done" onPress={onClose} fullWidth />
      ) : (
        <Button
          label={
            plan?.moves.length
              ? `Update ${plan.moves.length === 1 ? '1 appointment' : `${plan.moves.length} appointments`}`
              : 'Update calendar'
          }
          icon="checkmark"
          onPress={confirm}
          loading={apply.isPending}
          disabled={!plan?.ok || !plan.moves.length || apply.isPending}
          fullWidth
        />
      )}
    </View>
  );
}
