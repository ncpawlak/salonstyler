import { useEffect } from 'react';
import { View, type DimensionValue } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { useTheme } from '@/theme/theme-provider';
import { radius } from '@/theme/tokens';

export type SkeletonProps = {
  width?: DimensionValue;
  height?: DimensionValue;
  circle?: boolean;
  className?: string;
};

export function Skeleton({ width = '100%', height = 16, circle, className }: SkeletonProps) {
  const { colors } = useTheme();
  const opacity = useSharedValue(1);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    if (reduceMotion) return;
    opacity.set(withRepeat(withTiming(0.45, { duration: 800 }), -1, true));
  }, [opacity, reduceMotion]);

  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className={className}
      style={{ width, height }}
    >
      <Animated.View
        style={[
          { flex: 1, backgroundColor: colors.muted, borderRadius: circle ? 9999 : radius.md },
          style,
        ]}
      />
    </View>
  );
}

/** Placeholder for a ListRow while data loads. */
export function SkeletonRow() {
  return (
    <View accessible accessibilityLabel="Loading" className="flex-row items-center gap-3 px-4 py-3">
      <Skeleton width={40} height={40} circle />
      <View className="flex-1 gap-2">
        <Skeleton width="60%" height={14} />
        <Skeleton width="35%" height={12} />
      </View>
    </View>
  );
}
