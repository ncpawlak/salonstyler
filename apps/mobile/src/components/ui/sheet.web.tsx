import { Modal, Pressable, ScrollView, View } from 'react-native';
import Animated, { FadeIn, SlideInDown, useReducedMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '@/theme/theme-provider';
import { elevation, radius } from '@/theme/tokens';

import { SheetHeader, type SheetProps } from './sheet-parts';

export { useSheet, type SheetProps } from './sheet-parts';

/**
 * Web implementation of the bottom sheet. @gorhom/bottom-sheet's modal does not
 * present on react-native-web with Reanimated 4, so web uses an RN Modal with the
 * same controlled API and look (bottom-anchored card, scrim, tap-outside to close).
 */
export function Sheet({ open, onOpenChange, title, subtitle, children }: SheetProps) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const reduceMotion = useReducedMotion();
  const close = () => onOpenChange(false);

  return (
    <Modal visible={open} transparent animationType="none" onRequestClose={close}>
      <View style={{ flex: 1, justifyContent: 'flex-end' }}>
        <Animated.View
          entering={reduceMotion ? undefined : FadeIn.duration(150)}
          style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.4)' }}
        >
          <Pressable
            style={{ flex: 1 }}
            onPress={close}
            accessibilityRole="button"
            accessibilityLabel="Close sheet"
          />
        </Animated.View>
        <Animated.View
          entering={reduceMotion ? undefined : SlideInDown.duration(220)}
          accessibilityViewIsModal
          accessibilityLabel={title}
          style={{
            width: '100%',
            maxWidth: 672,
            maxHeight: '90%',
            alignSelf: 'center',
            backgroundColor: colors.card,
            borderTopLeftRadius: radius.xl,
            borderTopRightRadius: radius.xl,
            boxShadow: elevation.lg,
          }}
        >
          <View
            style={{
              alignSelf: 'center',
              width: 40,
              height: 4,
              borderRadius: 2,
              marginVertical: 10,
              backgroundColor: colors.input,
            }}
          />
          <ScrollView
            style={{ flexGrow: 0, flexShrink: 1 }}
            contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
            keyboardShouldPersistTaps="handled"
          >
            {title ? <SheetHeader title={title} subtitle={subtitle} onClose={close} /> : null}
            <View className="px-5">{children}</View>
          </ScrollView>
        </Animated.View>
      </View>
    </Modal>
  );
}
