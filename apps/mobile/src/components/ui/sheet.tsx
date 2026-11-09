import {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetScrollView,
  type BottomSheetBackdropProps,
} from '@gorhom/bottom-sheet';
import { useCallback, useEffect, useRef } from 'react';
import { View } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '@/theme/theme-provider';
import { radius } from '@/theme/tokens';

import { SheetHeader, type SheetProps } from './sheet-parts';

export { useSheet, type SheetProps } from './sheet-parts';

/**
 * Bottom sheet for create/edit flows so the user keeps their place (PLAN §5b).
 * Controlled: render it anywhere and toggle `open`.
 * Native uses @gorhom/bottom-sheet; web uses `sheet.web.tsx` (same API).
 */
export function Sheet({ open, onOpenChange, title, subtitle, children, snapPoints }: SheetProps) {
  const ref = useRef<BottomSheetModal>(null);
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    if (open) ref.current?.present();
    else ref.current?.dismiss();
  }, [open]);

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        appearsOnIndex={0}
        disappearsOnIndex={-1}
        opacity={0.4}
        pressBehavior="close"
      />
    ),
    [],
  );

  return (
    <BottomSheetModal
      ref={ref}
      snapPoints={snapPoints}
      enableDynamicSizing={!snapPoints}
      maxDynamicContentSize={snapPoints ? undefined : 720}
      onDismiss={() => onOpenChange(false)}
      backdropComponent={renderBackdrop}
      animateOnMount={!reduceMotion}
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
      accessibilityLabel={title}
      backgroundStyle={{
        backgroundColor: colors.card,
        borderTopLeftRadius: radius.xl,
        borderTopRightRadius: radius.xl,
      }}
      handleIndicatorStyle={{ backgroundColor: colors.input, width: 40 }}
    >
      <BottomSheetScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
        keyboardShouldPersistTaps="handled"
      >
        {title ? (
          <SheetHeader title={title} subtitle={subtitle} onClose={() => onOpenChange(false)} />
        ) : null}
        <View className="px-5">{children}</View>
      </BottomSheetScrollView>
    </BottomSheetModal>
  );
}
