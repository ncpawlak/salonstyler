import '../global.css';

import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AskChairsideButton } from '@/components/shell/ask-chairside';
import { usePushNotifications } from '@/features/notifications/api';
import { installNotificationResponseHandler } from '@/features/notifications/push';
import { createQueryClient } from '@/lib/query-client';
import { SessionProvider, useSession } from '@/providers/session-provider';
import { ThemeProvider, useTheme } from '@/theme/theme-provider';

// At module scope so Approve/Decline tapped on the lock screen are handled even before React mounts.
installNotificationResponseHandler();

function RootNavigator() {
  const { isLoading, session, salon } = useSession();
  const { colors } = useTheme();
  usePushNotifications(session && salon ? salon.id : null);

  if (isLoading) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator color={colors['muted-foreground']} />
      </View>
    );
  }

  const signedIn = session !== null;
  const hasSalon = salon !== null;

  // Exactly one group is reachable at a time; Expo Router redirects to it when the guards change.
  // The gallery and static mockups sit outside the guards so they can be reviewed without an account.
  return (
    <>
      <Stack
        screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}
      >
        <Stack.Protected guard={!signedIn}>
          <Stack.Screen name="(auth)/sign-in" />
        </Stack.Protected>
        <Stack.Protected guard={signedIn && !hasSalon}>
          <Stack.Screen name="(onboarding)/create-salon" />
        </Stack.Protected>
        <Stack.Protected guard={signedIn && hasSalon}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="settings" />
          <Stack.Screen name="settings/ai" />
          <Stack.Screen name="settings/payments" />
          <Stack.Screen name="settings/notifications" />
          <Stack.Screen name="requests/[id]" options={{ presentation: 'modal' }} />
          <Stack.Screen name="hours/index" />
          <Stack.Screen name="services/index" />
          <Stack.Screen name="services/[id]" />
        </Stack.Protected>
      </Stack>
      <AskChairsideButton />
    </>
  );
}

function ThemedApp() {
  const { scheme } = useTheme();
  return (
    <BottomSheetModalProvider>
      <SessionProvider>
        <RootNavigator />
      </SessionProvider>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
    </BottomSheetModalProvider>
  );
}

export default function RootLayout() {
  const [queryClient] = useState(createQueryClient);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <QueryClientProvider client={queryClient}>
        <SafeAreaProvider>
          <ThemeProvider>
            <ThemedApp />
          </ThemeProvider>
        </SafeAreaProvider>
      </QueryClientProvider>
    </GestureHandlerRootView>
  );
}
