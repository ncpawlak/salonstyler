import { Stack } from 'expo-router';

import { useTheme } from '@/theme/theme-provider';

/**
 * Everything a signed-in salon member sees. The root layout guards this whole group, so a new
 * screen file here is protected without registering it anywhere. Only screens that open as a
 * modal need an entry below.
 */
export default function AppLayout() {
  const { colors } = useTheme();
  return (
    <Stack
      screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}
    >
      {/* First, so it's where the root guard lands after sign-in. */}
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="requests/[id]" options={{ presentation: 'modal' }} />
      <Stack.Screen name="assistant" options={{ presentation: 'modal' }} />
      <Stack.Screen name="checkout/index" options={{ presentation: 'modal' }} />
      <Stack.Screen name="checkout/[appointmentId]" options={{ presentation: 'modal' }} />
    </Stack>
  );
}
