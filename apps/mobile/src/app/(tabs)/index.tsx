import { router } from 'expo-router';
import { Pressable, View } from 'react-native';

import { RequestCard } from '@/components/mockups/request-card';
import { ClientLine, ProcessingTimer } from '@/components/mockups/today-widgets';
import { Screen } from '@/components/shell/screen';
import {
  Badge,
  Button,
  Card,
  Chip,
  Donut,
  Icon,
  ListGroup,
  ListRow,
  SectionHeader,
  Text,
  type IconName,
} from '@/components/ui';
import { haptics } from '@/lib/haptics';
import {
  MOCK_NOW_MINUTES,
  MOCK_TODAY,
  appointmentMinutes,
  busyness,
  formatDuration,
  formatTime,
  quickActions,
  serviceById,
  todayAppointments,
} from '@/mocks/data';
import { usePendingRequests } from '@/mocks/inbox-store';
import { useTheme } from '@/theme/theme-provider';

const dateLabel = MOCK_TODAY.toLocaleDateString('en-US', {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
});

export default function TodayScreen() {
  const { tag } = useTheme();
  const pending = usePendingRequests();
  const next = todayAppointments.find((a) => a.status === 'upcoming');
  const booked = todayAppointments
    .filter((a) => a.status !== 'blocked')
    .reduce((sum, a) => sum + appointmentMinutes(a), 0);
  const dayShare = busyness(MOCK_TODAY);
  const clientCount = todayAppointments.filter((a) => a.status !== 'blocked').length;

  return (
    <Screen title="Today" subtitle={dateLabel}>
      {next ? (
        <Card elevation="md" className="gap-4">
          <View className="flex-row items-center justify-between">
            <Badge label="Next up" tone="primary" />
            <Text variant="subhead" tone="muted" numeric>
              {formatTime(next.start)}
            </Text>
          </View>
          <View>
            <Text variant="display" numeric>
              in {formatDuration(next.start - MOCK_NOW_MINUTES)}
            </Text>
          </View>
          <ClientLine
            name={next.client}
            detail={`${formatDuration(appointmentMinutes(next))} · ${next.note ?? 'Regular'}`}
          />
          <View className="flex-row flex-wrap gap-2">
            {next.serviceIds.map((id) => {
              const s = serviceById(id);
              return <Chip key={id} label={s.name} tag={s.tag} />;
            })}
          </View>
          <View className="flex-row gap-3">
            <Button
              variant="secondary"
              label="I'm late"
              accessibilityLabel="Running late, notify Priya"
              icon="time-outline"
              grow
            />
            <Button label="Check in" icon="checkmark-circle-outline" grow />
          </View>
        </Card>
      ) : null}

      <View className="mt-3 flex-row gap-3">
        <Card className="flex-1 items-center gap-2">
          <Donut value={dayShare} size={72} />
          <Text variant="footnote" tone="muted" className="text-center">
            {clientCount} clients · {formatDuration(booked)}
          </Text>
        </Card>
        <ProcessingTimer />
      </View>

      <SectionHeader title="Quick actions" />
      <View className="flex-row gap-3">
        {quickActions.map((a) => (
          <QuickAction
            key={a.id}
            icon={a.icon}
            label={a.label}
            onPress={() => {
              if (a.id === 'checkout') router.push('/mockups/checkout');
              else if (a.id === 'book') router.push('/mockups/service-builder');
            }}
          />
        ))}
      </View>

      <SectionHeader
        title={`Pending requests · ${pending.length}`}
        action={
          pending.length ? (
            <Button
              variant="ghost"
              size="sm"
              label="See all"
              haptic="selection"
              onPress={() => router.push('/inbox')}
            />
          ) : undefined
        }
      />
      {pending[0] ? (
        <RequestCard request={pending[0]} compact />
      ) : (
        <Card className="flex-row items-center gap-3">
          <Icon name="checkmark-done" color="success" />
          <Text variant="subhead" tone="muted">
            You’re all caught up.
          </Text>
        </Card>
      )}

      <SectionHeader title="Schedule" />
      <ListGroup>
        {todayAppointments.map((a, i) => {
          const s = a.serviceIds[0] ? serviceById(a.serviceIds[0]) : undefined;
          const c = s ? tag(s.tag) : undefined;
          return (
            <ListRow
              key={a.id}
              title={a.client}
              subtitle={
                a.status === 'blocked'
                  ? 'Blocked'
                  : a.serviceIds.map((id) => serviceById(id).name).join(' + ')
              }
              leading={
                <View className="w-16">
                  <Text variant="subhead" numeric className="font-semibold">
                    {formatTime(a.start)}
                  </Text>
                </View>
              }
              trailing={
                a.status === 'done' ? (
                  <Badge label="Done" tone="success" />
                ) : a.status === 'in-progress' ? (
                  <Badge label="In chair" tone="primary" />
                ) : c ? (
                  <View className="h-3 w-3 rounded-full" style={{ backgroundColor: c.solid }} />
                ) : undefined
              }
              last={i === todayAppointments.length - 1}
              onPress={() => router.push('/calendar')}
            />
          );
        })}
      </ListGroup>
    </Screen>
  );
}

function QuickAction({
  icon,
  label,
  onPress,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => {
        haptics.tap();
        onPress();
      }}
      className="flex-1 items-center gap-2 rounded-xl border border-border bg-card px-1 py-3 active:bg-muted"
    >
      <View className="h-10 w-10 items-center justify-center rounded-full bg-primary-soft">
        <Icon name={icon} size={22} color="primary-soft-foreground" />
      </View>
      <Text variant="caption" className="text-center" numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}
