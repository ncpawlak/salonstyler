import type { AssistantCard, DraftCard, SlotOption, SlotsCard } from '@chairside/ai/assistant';
import type { ChatMessage } from '@chairside/ai';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router, useFocusEffect } from 'expo-router';
import { type ComponentRef, useCallback, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  Badge,
  Button,
  Card,
  Chip,
  EmptyState,
  Icon,
  Input,
  SkeletonRow,
  Text,
} from '@/components/ui';
import { assistantApi } from '@/features/assistant/api';
import { haptics } from '@/lib/haptics';
import { supabase } from '@/lib/supabase';
import { useCurrentSalon } from '@/providers/session-provider';

const SUGGESTIONS = [
  'Schedule Karina for December 18th',
  "What's on tomorrow?",
  'Book Maya for a haircut on Friday',
];

type Entry =
  | { id: string; role: 'user'; text: string }
  | { id: string; role: 'assistant'; text: string; cards: AssistantCard[] }
  | { id: string; role: 'error'; text: string; retry?: string };

let nextId = 0;
const id = () => String(++nextId);

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
const errorCode = (e: unknown) => (e as { code?: string }).code;

const titleCase = (s: string) =>
  s
    .trim()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

/** Ask Chairside: the owner's AI assistant. Every booking is a held draft until they confirm. */
export default function AssistantScreen() {
  const salon = useCurrentSalon();
  const api = assistantApi(supabase, salon.id);
  const queryClient = useQueryClient();
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);

  const status = useQuery({
    queryKey: ['assistant-status', salon.id],
    queryFn: api.status,
  });

  const [entries, setEntries] = useState<Entry[]>([]);
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [text, setText] = useState('');
  const [notConfigured, setNotConfigured] = useState(false);
  const [busyCard, setBusyCard] = useState<string | null>(null);
  const [addedClients, setAddedClients] = useState<string[]>([]);

  // Pick up a key saved in Settings → AI assistant when coming back.
  const refetchStatus = status.refetch;
  useFocusEffect(
    useCallback(() => {
      setNotConfigured(false);
      void refetchStatus();
    }, [refetchStatus]),
  );
  const lastUserText = [...entries].reverse().find((e) => e.role === 'user')?.text;

  const append = (...more: Entry[]) => {
    setEntries((prev) => [...prev, ...more]);
    setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 50);
  };

  /** Replaces a draft card in place wherever it was shown. */
  const updateDraft = (card: DraftCard) =>
    setEntries((prev) =>
      prev.map((e) =>
        e.role === 'assistant'
          ? {
              ...e,
              cards: e.cards.map((c) =>
                c.type === 'draft' && c.appointmentId === card.appointmentId ? card : c,
              ),
            }
          : e,
      ),
    );

  const send = useMutation({
    mutationFn: (message: string) => api.message({ history, text: message }),
    onMutate: (message) => append({ id: id(), role: 'user', text: message }),
    onSuccess: (r) => {
      setHistory((h) => [...h, ...r.messages]);
      append({ id: id(), role: 'assistant', text: r.reply, cards: r.cards });
      if (r.cards.some((c) => c.type === 'draft')) haptics.success();
    },
    onError: (e, message) => {
      if (errorCode(e) === 'not_configured') setNotConfigured(true);
      append({ id: id(), role: 'error', text: errorMessage(e), retry: message });
    },
  });

  const submit = (message = text) => {
    const trimmed = message.trim();
    if (!trimmed || send.isPending) return;
    setText('');
    send.mutate(trimmed);
  };

  const run = async (key: string, action: () => Promise<void>) => {
    setBusyCard(key);
    try {
      await action();
    } catch (e) {
      append({ id: id(), role: 'error', text: errorMessage(e) });
    } finally {
      setBusyCard(null);
    }
  };

  const pickSlot = (card: SlotsCard, slot: SlotOption) =>
    run(slot.start, async () => {
      haptics.selection();
      const { card: draft } = await api.propose({
        clientId: card.client!.id,
        start: slot.start,
        services: card.items,
      });
      append({
        id: id(),
        role: 'assistant',
        text: `Held ${draft.label} for ${draft.client.name}. Confirm to book it.`,
        cards: [draft],
      });
    });

  const confirm = (card: DraftCard) =>
    run(card.appointmentId, async () => {
      const { card: booked } = await api.confirm(card.appointmentId);
      updateDraft(booked);
      haptics.success();
      await queryClient.invalidateQueries();
    });

  const change = (card: DraftCard) =>
    run(card.appointmentId, async () => {
      const { card: released } = await api.discard(card.appointmentId);
      updateDraft(released);
      append({
        id: id(),
        role: 'assistant',
        text: 'Okay, I released that hold. Pick another time above, or tell me what works.',
        cards: [],
      });
    });

  const addClient = (name: string) =>
    run(`add:${name}`, async () => {
      const { client } = await api.createClient({ name: titleCase(name) });
      setAddedClients((prev) => [...prev, name]);
      append({ id: id(), role: 'assistant', text: `Added ${client.name} as a client.`, cards: [] });
      if (lastUserText) submit(lastUserText);
    });

  const showSetup = notConfigured || (status.data && !status.data.configured);

  return (
    <SafeAreaView edges={['top', 'bottom']} className="flex-1 bg-background">
      <KeyboardAvoidingView
        className="w-full max-w-2xl flex-1 self-center"
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View className="flex-row items-center gap-2 px-2 pb-1 pt-1">
          <Button
            variant="ghost"
            size="icon"
            icon="close"
            accessibilityLabel="Close"
            haptic="selection"
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
          />
          <View className="flex-1 flex-row items-center justify-center gap-1.5">
            <Icon name="sparkles" size={16} color="primary" />
            <Text variant="headline">Ask Chairside</Text>
            {status.data?.demo ? <Badge label="Demo" tone="warning" /> : null}
          </View>
          <View className="min-w-tap" />
        </View>

        {status.isPending ? (
          <View className="gap-3 p-4">
            <SkeletonRow />
            <SkeletonRow />
          </View>
        ) : showSetup ? (
          <EmptyState
            icon="sparkles-outline"
            title="Set up Ask Chairside"
            message={
              salon.role === 'owner'
                ? 'Connect your OpenAI, Anthropic or Gemini key in Settings → AI assistant. It stays encrypted on the server.'
                : 'Ask the salon owner to connect an AI provider in Settings → AI assistant.'
            }
            actionLabel={salon.role === 'owner' ? 'Open AI assistant settings' : undefined}
            onAction={() => router.push('/settings/ai')}
            className="flex-1"
          />
        ) : (
          <>
            <ScrollView
              ref={scroll}
              className="flex-1"
              contentContainerClassName="gap-3 px-4 pb-4 pt-2"
              keyboardShouldPersistTaps="handled"
            >
              {entries.length === 0 ? (
                <View className="gap-3 pt-6">
                  <Text variant="title3">How can I help?</Text>
                  <Text variant="subhead" tone="muted">
                    Ask me to find a time for a client and I’ll check your calendar for that day and
                    the days around it. Nothing is booked until you tap Confirm.
                  </Text>
                  <View className="flex-row flex-wrap gap-2 pt-1">
                    {SUGGESTIONS.map((s) => (
                      <Chip key={s} label={s} icon="sparkles-outline" onPress={() => submit(s)} />
                    ))}
                  </View>
                </View>
              ) : null}
              {entries.map((entry) => (
                <EntryView
                  key={entry.id}
                  entry={entry}
                  busyCard={busyCard}
                  addedClients={addedClients}
                  onPickSlot={pickSlot}
                  onConfirm={confirm}
                  onChange={change}
                  onAddClient={addClient}
                  onPickClient={(name, query) =>
                    lastUserText &&
                    submit(lastUserText.replace(new RegExp(escapeRegExp(query), 'i'), name))
                  }
                  onRetry={(message) => submit(message)}
                />
              ))}
              {send.isPending ? (
                <View className="flex-row items-center gap-2 px-1">
                  <Icon name="sparkles" size={14} color="muted-foreground" />
                  <Text variant="footnote" tone="muted">
                    Checking your calendar…
                  </Text>
                </View>
              ) : null}
            </ScrollView>
            <View className="flex-row items-end gap-2 border-t border-border px-4 pb-2 pt-2">
              <Input
                className="flex-1"
                icon="sparkles-outline"
                placeholder="Schedule Karina for December 18th…"
                accessibilityLabel="Message Chairside"
                value={text}
                onChangeText={setText}
                returnKeyType="send"
                onSubmitEditing={() => submit()}
                editable={!send.isPending}
              />
              <Button
                size="icon"
                icon="arrow-up"
                accessibilityLabel="Send"
                disabled={!text.trim() || send.isPending}
                onPress={() => submit()}
              />
            </View>
          </>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function EntryView({
  entry,
  busyCard,
  addedClients,
  onPickSlot,
  onConfirm,
  onChange,
  onAddClient,
  onPickClient,
  onRetry,
}: {
  entry: Entry;
  busyCard: string | null;
  addedClients: string[];
  onPickSlot: (card: SlotsCard, slot: SlotOption) => void;
  onConfirm: (card: DraftCard) => void;
  onChange: (card: DraftCard) => void;
  onAddClient: (name: string) => void;
  onPickClient: (name: string, query: string) => void;
  onRetry: (message: string) => void;
}) {
  if (entry.role === 'user') {
    return (
      <View className="max-w-[85%] self-end rounded-2xl rounded-br-md bg-primary px-4 py-2.5">
        <Text tone="inverse">{entry.text}</Text>
      </View>
    );
  }
  if (entry.role === 'error') {
    return (
      <View className="gap-2 rounded-xl border border-destructive px-4 py-3">
        <Text variant="subhead" tone="destructive">
          {entry.text}
        </Text>
        {entry.retry ? (
          <Button
            variant="outline"
            size="sm"
            icon="refresh"
            label="Try again"
            className="self-start"
            onPress={() => onRetry(entry.retry!)}
          />
        ) : null}
      </View>
    );
  }
  return (
    <View className="gap-2">
      {entry.text ? (
        <View className="max-w-[90%] self-start rounded-2xl rounded-bl-md bg-muted px-4 py-2.5">
          <Text>{entry.text}</Text>
        </View>
      ) : null}
      {entry.cards.map((card, i) => {
        switch (card.type) {
          case 'slots':
            return <SlotsCardView key={i} card={card} busy={busyCard} onPick={onPickSlot} />;
          case 'draft':
            return (
              <DraftCardView
                key={card.appointmentId}
                card={card}
                busy={busyCard === card.appointmentId}
                onConfirm={onConfirm}
                onChange={onChange}
              />
            );
          case 'client_not_found':
            return (
              <Card key={i} className="gap-3">
                <Text variant="subhead">
                  No client named “{card.query}”.
                  {card.suggestions.length ? ' Did you mean:' : ''}
                </Text>
                {card.suggestions.length ? (
                  <View className="flex-row flex-wrap gap-2">
                    {card.suggestions.map((s) => (
                      <Chip
                        key={s.id}
                        label={s.name}
                        icon="person-outline"
                        onPress={() => onPickClient(s.name, card.query)}
                      />
                    ))}
                  </View>
                ) : null}
                {addedClients.includes(card.query) ? (
                  <Badge label={`Added ${titleCase(card.query)}`} tone="success" />
                ) : (
                  <Button
                    variant="secondary"
                    icon="person-add-outline"
                    label={`Add ${titleCase(card.query)} as a client`}
                    loading={busyCard === `add:${card.query}`}
                    onPress={() => onAddClient(card.query)}
                  />
                )}
              </Card>
            );
        }
      })}
    </View>
  );
}

function SlotsCardView({
  card,
  busy,
  onPick,
}: {
  card: SlotsCard;
  busy: string | null;
  onPick: (card: SlotsCard, slot: SlotOption) => void;
}) {
  const days = card.days.filter((d) => d.slots.length > 0 || d.date === card.requestedDate);
  return (
    <Card className="gap-3">
      <View className="gap-0.5">
        <Text variant="headline">{card.client ? card.client.name : 'Open times'}</Text>
        <Text variant="footnote" tone="muted">
          {card.serviceSummary}
        </Text>
      </View>
      {days.map((day) => (
        <View key={day.date} className="gap-1.5">
          <View className="flex-row items-center gap-2">
            <Text variant="subhead" className="font-semibold">
              {day.label}
            </Text>
            {day.date === card.requestedDate ? <Badge label="Requested" tone="primary" /> : null}
          </View>
          {day.slots.length ? (
            <View className="flex-row flex-wrap gap-2">
              {day.slots.map((slot) => (
                <Chip
                  key={slot.start}
                  label={busy === slot.start ? 'Holding…' : slot.time}
                  icon={slot.requiresApproval ? 'alert-circle-outline' : undefined}
                  onPress={card.client && !busy ? () => onPick(card, slot) : undefined}
                />
              ))}
            </View>
          ) : (
            <Text variant="footnote" tone="muted">
              No openings
            </Text>
          )}
        </View>
      ))}
      {!card.client ? (
        <Text variant="footnote" tone="muted">
          Tell me who it’s for to hold a time.
        </Text>
      ) : null}
    </Card>
  );
}

function DraftCardView({
  card,
  busy,
  onConfirm,
  onChange,
}: {
  card: DraftCard;
  busy: boolean;
  onConfirm: (card: DraftCard) => void;
  onChange: (card: DraftCard) => void;
}) {
  const badge =
    card.status === 'confirmed'
      ? { label: 'Booked', tone: 'success' as const }
      : card.status === 'cancelled'
        ? { label: 'Released', tone: 'neutral' as const }
        : { label: 'Draft · held', tone: 'warning' as const };
  return (
    <Card className="gap-3" accessibilityLabel={`Draft booking, ${card.label}`}>
      <View className="flex-row items-start gap-3">
        <View className="h-10 w-10 items-center justify-center rounded-full bg-primary-soft">
          <Icon
            name={card.status === 'confirmed' ? 'checkmark' : 'calendar-outline'}
            size={20}
            color="primary-soft-foreground"
          />
        </View>
        <View className="flex-1 gap-0.5">
          <Text variant="headline">{card.client.name}</Text>
          <Text variant="subhead">{card.label}</Text>
          <Text variant="footnote" tone="muted">
            {card.serviceSummary}
          </Text>
        </View>
        <Badge label={badge.label} tone={badge.tone} />
      </View>
      {card.requiresApproval && card.status === 'held' ? (
        <Text variant="footnote" tone="warning">
          This time is outside your usual rules; confirming books it anyway.
        </Text>
      ) : null}
      {card.status === 'held' ? (
        <View className="flex-row gap-3">
          <Button
            variant="secondary"
            label="Change"
            icon="swap-horizontal"
            grow
            disabled={busy}
            onPress={() => onChange(card)}
          />
          <Button
            label="Confirm"
            icon="checkmark"
            grow
            haptic="success"
            loading={busy}
            onPress={() => onConfirm(card)}
          />
        </View>
      ) : null}
    </Card>
  );
}
