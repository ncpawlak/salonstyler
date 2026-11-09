import { useSegments } from 'expo-router';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import Animated, {
  FadeIn,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, Chip, Icon, Input, Sheet, Text } from '@/components/ui';
import { haptics } from '@/lib/haptics';
import { elevation, motion } from '@/theme/tokens';

export const TAB_BAR_HEIGHT = 56;

const suggestions = [
  'Book Maya for a root touch-up next week',
  'Am I free Friday at 2?',
  "I'm running 15 late",
  'Block off Saturday afternoon',
];

/**
 * Floating "Ask Chairside" AI entry point, mounted once at the root so it is on every screen.
 * Tap to type, long-press to talk (mocked until the AI adapters land, #32).
 */
export function AskChairsideButton() {
  const segments = useSegments();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);
  const [listening, setListening] = useState(false);
  const scale = useSharedValue(1);
  const reduceMotion = useReducedMotion();
  const style = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  const first = segments[0] as string | undefined;
  if (first === '(auth)' || first === '(onboarding)') return null;
  const inTabs = first === '(tabs)';
  const bottom = (inTabs ? TAB_BAR_HEIGHT : 0) + insets.bottom + 16;

  const openSheet = (voice: boolean) => {
    setListening(voice);
    setOpen(true);
  };

  return (
    <>
      <Animated.View
        entering={reduceMotion ? undefined : FadeIn.duration(motion.duration.slow)}
        pointerEvents="box-none"
        style={{ position: 'absolute', right: 16, bottom }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Ask Chairside"
          accessibilityHint="Opens the assistant. Long press to talk."
          onPressIn={() => {
            if (!reduceMotion) scale.set(withSpring(0.94, motion.spring));
          }}
          onPressOut={() => {
            scale.set(withSpring(1, motion.spring));
          }}
          onPress={() => {
            haptics.tap();
            openSheet(false);
          }}
          onLongPress={() => {
            haptics.heavy();
            openSheet(true);
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
      <Sheet
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setListening(false);
        }}
        title="Ask Chairside"
        subtitle="Book, reschedule, block time, or ask about your day."
      >
        <View className="gap-4">
          {listening ? (
            <View className="items-center gap-3 rounded-xl bg-primary-soft py-6">
              <View className="h-16 w-16 items-center justify-center rounded-full bg-primary">
                <Icon name="mic" size={28} color="primary-foreground" />
              </View>
              <Text variant="headline" className="text-primary-soft-foreground">
                Listening…
              </Text>
              <Text variant="footnote" className="text-primary-soft-foreground">
                Release to send (voice is mocked in this preview)
              </Text>
            </View>
          ) : (
            <Input
              icon="sparkles-outline"
              placeholder="Type a request…"
              accessibilityLabel="Message Chairside"
              returnKeyType="send"
            />
          )}
          <View className="flex-row flex-wrap gap-2">
            {suggestions.map((s) => (
              <Chip key={s} label={s} onPress={() => setOpen(false)} />
            ))}
          </View>
          <View className="flex-row gap-3">
            <Button
              variant="secondary"
              icon={listening ? 'keypad-outline' : 'mic-outline'}
              label={listening ? 'Type instead' : 'Hold to talk'}
              haptic="selection"
              onPress={() => setListening((v) => !v)}
              grow
            />
          </View>
        </View>
      </Sheet>
    </>
  );
}
