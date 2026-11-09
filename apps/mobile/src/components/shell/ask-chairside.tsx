import { router, useSegments } from 'expo-router';
import { Pressable, View } from 'react-native';
import Animated, {
  FadeIn,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon, Text } from '@/components/ui';
import { haptics } from '@/lib/haptics';
import { elevation, motion } from '@/theme/tokens';

export const TAB_BAR_HEIGHT = 56;

/**
 * Floating "Ask Chairside" AI entry point, mounted once at the root so it is on every screen.
 * Opens the assistant chat (`/assistant`); hidden on the chat itself. Voice input comes later.
 */
export function AskChairsideButton() {
  const segments: readonly string[] = useSegments();
  const insets = useSafeAreaInsets();
  const scale = useSharedValue(1);
  const reduceMotion = useReducedMotion();
  const style = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  // Signed-in screens sit inside the (app) group; look past it to the screen itself.
  const first = segments[0] === '(app)' ? segments[1] : segments[0];
  // Hidden on client-facing screens (checkout is shown to the client; receipts, manage links and
  // the booking page are public).
  if (
    first === '(auth)' ||
    first === '(onboarding)' ||
    first === 'assistant' ||
    first === 'checkout' ||
    first === 'receipt' ||
    first === 'm' ||
    first === 'b'
  ) {
    return null;
  }
  const inTabs = first === '(tabs)';
  const bottom = (inTabs ? TAB_BAR_HEIGHT : 0) + insets.bottom + 16;

  return (
    <Animated.View
      entering={reduceMotion ? undefined : FadeIn.duration(motion.duration.slow)}
      pointerEvents="box-none"
      style={{ position: 'absolute', right: 16, bottom }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Ask Chairside"
        accessibilityHint="Opens the assistant to book or ask about your day."
        onPressIn={() => {
          if (!reduceMotion) scale.set(withSpring(0.94, motion.spring));
        }}
        onPressOut={() => {
          scale.set(withSpring(1, motion.spring));
        }}
        onPress={() => {
          haptics.tap();
          router.push('/assistant');
        }}
      >
        <Animated.View style={[style, { boxShadow: elevation.lg, borderRadius: 999 }]}>
          <View className="h-14 flex-row items-center gap-2 rounded-full bg-primary pl-4 pr-5">
            <Icon name="sparkles" size={20} color="primary-foreground" />
            <Text variant="headline" tone="inverse" maxFontSizeMultiplier={1.3}>
              Ask
            </Text>
          </View>
        </Animated.View>
      </Pressable>
    </Animated.View>
  );
}
