import Ionicons from '@expo/vector-icons/Ionicons';
import { Tabs } from 'expo-router/js-tabs';
import type { ComponentProps } from 'react';
import type { ColorValue } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { TAB_BAR_HEIGHT } from '@/components/shell/ask-chairside';
import { useSalonRealtime } from '@/features/realtime/use-salon-realtime';
import { usePendingRequests } from '@/features/today/api';
import { haptics } from '@/lib/haptics';
import { useTheme } from '@/theme/theme-provider';

type IoniconName = ComponentProps<typeof Ionicons>['name'];

function tabIcon(active: IoniconName, inactive: IoniconName) {
  function TabIcon({ color, focused }: { color: ColorValue; focused: boolean }) {
    return (
      <Ionicons
        name={focused ? active : inactive}
        size={24}
        color={typeof color === 'string' ? color : undefined}
      />
    );
  }
  return TabIcon;
}

export default function TabsLayout() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const pending = usePendingRequests().data?.length ?? 0;
  useSalonRealtime();

  return (
    <Tabs
      screenListeners={{ tabPress: () => haptics.selection() }}
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: colors.background },
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors['muted-foreground'],
        tabBarAllowFontScaling: false,
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
        tabBarStyle: {
          backgroundColor: colors.card,
          borderTopColor: colors.border,
          height: TAB_BAR_HEIGHT + insets.bottom,
          paddingTop: 4,
        },
        tabBarBadgeStyle: {
          backgroundColor: colors.destructive,
          color: colors['destructive-foreground'],
          fontSize: 11,
          fontWeight: '700',
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{ title: 'Today', tabBarIcon: tabIcon('sunny', 'sunny-outline') }}
      />
      <Tabs.Screen
        name="calendar"
        options={{ title: 'Calendar', tabBarIcon: tabIcon('calendar', 'calendar-outline') }}
      />
      <Tabs.Screen
        name="inbox"
        options={{
          title: 'Inbox',
          tabBarIcon: tabIcon('file-tray-full', 'file-tray-outline'),
          tabBarBadge: pending || undefined,
          tabBarAccessibilityLabel: pending ? `Inbox, ${pending} pending requests` : 'Inbox',
        }}
      />
      <Tabs.Screen
        name="clients"
        options={{ title: 'Clients', tabBarIcon: tabIcon('people', 'people-outline') }}
      />
    </Tabs>
  );
}
