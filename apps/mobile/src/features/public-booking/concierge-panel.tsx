import type { ConciergeCard, ConciergeMessage } from '@chairside/ai/public-booking';
import { useMutation } from '@tanstack/react-query';
import { type ComponentRef, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';

import { Button, Card, Chip, Input, Text } from '@/components/ui';

import type { BookingItem, PublicBookingApi } from './api';

export type PickedSlot = {
  items: BookingItem[];
  serviceSummary: string;
  start: string;
  label: string;
};

/**
 * The client concierge: describe what you want in your own words and get real open times back.
 * The model only interprets; the times on its cards come from the scheduling engine.
 */
export function ConciergePanel({
  api,
  onPick,
}: {
  api: PublicBookingApi;
  onPick: (slot: PickedSlot) => void;
}) {
  const [history, setHistory] = useState<ConciergeMessage[]>([]);
  const [cards, setCards] = useState<Map<number, ConciergeCard[]>>(new Map());
  const [text, setText] = useState('');
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const send = useMutation({
    mutationFn: (message: string) => api.chat({ history, text: message }),
    onSuccess: (res) => {
      const next = [...history, ...res.messages];
      setHistory(next);
      if (res.cards.length) setCards((c) => new Map(c).set(next.length - 1, res.cards));
      setText('');
      requestAnimationFrame(() => scroll.current?.scrollToEnd({ animated: true }));
    },
  });

  const submit = () => {
    const message = text.trim();
    if (message && !send.isPending) send.mutate(message);
  };

  return (
    <Card className="gap-3">
      <View className="gap-1">
        <Text variant="headline">Not sure what to book?</Text>
        <Text variant="subhead" tone="muted">
          Tell us what you’d like and when, e.g. “a haircut Friday afternoon”.
        </Text>
      </View>
      {history.length ? (
        <ScrollView ref={scroll} className="max-h-96" contentContainerClassName="gap-2">
          {history.map((m, i) => (
            <View key={i} className="gap-2">
              <View
                className={
                  m.role === 'user'
                    ? 'max-w-[85%] self-end rounded-xl bg-primary px-3 py-2'
                    : 'max-w-[85%] self-start rounded-xl bg-muted px-3 py-2'
                }
              >
                <Text variant="subhead" tone={m.role === 'user' ? 'inverse' : 'default'}>
                  {m.content}
                </Text>
              </View>
              {(cards.get(i) ?? []).map((card, j) => (
                <SlotsCardView key={j} card={card} onPick={onPick} />
              ))}
            </View>
          ))}
        </ScrollView>
      ) : null}
      {send.error ? (
        <Text variant="footnote" tone="destructive">
          {send.error.message}
        </Text>
      ) : null}
      <View className="flex-row items-end gap-2">
        <Input
          className="flex-1"
          accessibilityLabel="Message the concierge"
          placeholder="Ask about services or times"
          value={text}
          onChangeText={setText}
          maxLength={500}
          onSubmitEditing={submit}
          returnKeyType="send"
        />
        <Button
          icon="send"
          size="icon"
          accessibilityLabel="Send"
          loading={send.isPending}
          disabled={!text.trim()}
          onPress={submit}
        />
      </View>
    </Card>
  );
}

function SlotsCardView({ card, onPick }: { card: ConciergeCard; onPick: (s: PickedSlot) => void }) {
  const days = card.days.filter((d) => d.slots.length > 0);
  if (!days.length) return null;
  return (
    <View className="gap-2 rounded-xl border border-border p-3">
      <Text variant="footnote" tone="muted">
        {card.serviceSummary}
      </Text>
      {days.map((d) => (
        <View key={d.date} className="gap-1.5">
          <Text variant="subhead" className="font-medium">
            {d.label}
          </Text>
          <View className="flex-row flex-wrap gap-2">
            {d.slots.map((s) => (
              <Chip
                key={s.start}
                label={s.requiresApproval ? `${s.time} · request` : s.time}
                onPress={() =>
                  onPick({
                    items: card.items,
                    serviceSummary: card.serviceSummary,
                    start: s.start,
                    label: `${d.label} · ${s.time}`,
                  })
                }
              />
            ))}
          </View>
        </View>
      ))}
    </View>
  );
}
