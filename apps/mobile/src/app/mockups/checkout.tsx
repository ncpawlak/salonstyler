import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import Animated, { FadeIn, ZoomIn } from 'react-native-reanimated';

import { ClientLine } from '@/components/mockups/today-widgets';
import { DetailScreen } from '@/components/shell/screen';
import { Button, Card, Chip, Icon, SectionHeader, SegmentedControl, Text } from '@/components/ui';
import { haptics } from '@/lib/haptics';
import { serviceById, todayAppointments } from '@/mocks/data';

const tips = [
  { value: '0', label: 'None' },
  { value: '15', label: '15%' },
  { value: '20', label: '20%' },
  { value: '25', label: '25%' },
] as const;

type Tip = (typeof tips)[number]['value'];

const money = (n: number) => `$${n.toFixed(2)}`;

export default function CheckoutMockup() {
  const appt = todayAppointments.find((a) => a.status === 'in-progress') ?? todayAppointments[0];
  const [tip, setTip] = useState<Tip>('20');
  const [state, setState] = useState<'idle' | 'charging' | 'paid'>('idle');

  if (!appt) return null;
  const items = appt.serviceIds.map(serviceById);
  const subtotal = items.reduce((sum, s) => sum + s.price, 0);
  const tipAmount = (subtotal * Number(tip)) / 100;
  const total = subtotal + tipAmount;

  if (state === 'paid') {
    return (
      <DetailScreen title="Checkout" close>
        <Animated.View entering={FadeIn}>
          <View className="items-center gap-4 py-16">
            <Animated.View entering={ZoomIn.springify()}>
              <View className="h-24 w-24 items-center justify-center rounded-full bg-success">
                <Icon name="checkmark" size={56} color="success-foreground" />
              </View>
            </Animated.View>
            <Text variant="title1" numeric accessibilityRole="header">
              {money(total)} paid
            </Text>
            <Text variant="subhead" tone="muted" className="text-center">
              Receipt texted to {appt.client.split(' ')[0]}. Rebook in 6 weeks?
            </Text>
            <View className="w-full flex-row gap-3 pt-4">
              <Button variant="secondary" label="Done" grow onPress={() => router.back()} />
              <Button label="Rebook" icon="calendar-outline" grow />
            </View>
          </View>
        </Animated.View>
      </DetailScreen>
    );
  }

  return (
    <DetailScreen title="Checkout" close>
      <Card>
        <ClientLine name={appt.client} detail="In chair now" />
      </Card>

      <SectionHeader title="Services" />
      <Card className="gap-3">
        {items.map((s) => (
          <View key={s.id} className="flex-row items-center justify-between">
            <Chip label={s.name} tag={s.tag} />
            <Text variant="body" numeric>
              {money(s.price)}
            </Text>
          </View>
        ))}
        <View className="h-px bg-border" />
        <Row label="Subtotal" value={money(subtotal)} />
        <Row label={`Tip ${tip}%`} value={money(tipAmount)} />
      </Card>

      <SectionHeader title="Tip" />
      <SegmentedControl accessibilityLabel="Tip" options={tips} value={tip} onChange={setTip} />

      <View className="mt-6 flex-row items-end justify-between">
        <Text variant="headline" tone="muted">
          Total
        </Text>
        <Text variant="display" numeric>
          {money(total)}
        </Text>
      </View>

      <Button
        size="lg"
        fullWidth
        className="mt-4"
        icon="phone-portrait-outline"
        label="Charge with Tap to Pay"
        loading={state === 'charging'}
        haptic="heavy"
        onPress={() => {
          setState('charging');
          setTimeout(() => {
            haptics.success();
            setState('paid');
          }, 1200);
        }}
      />
      <Button variant="ghost" label="Other payment" fullWidth className="mt-1" />
    </DetailScreen>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row justify-between">
      <Text variant="subhead" tone="muted">
        {label}
      </Text>
      <Text variant="subhead" numeric>
        {value}
      </Text>
    </View>
  );
}
