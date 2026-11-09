import { useEffect, useRef, useState } from 'react';
import { Pressable, View, type LayoutChangeEvent } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';

import { cn } from '@/lib/cn';
import { haptics } from '@/lib/haptics';
import { useTheme } from '@/theme/theme-provider';
import { elevation, motion, radius } from '@/theme/tokens';

import { Text } from './text';

export type SegmentedControlProps<T extends string> = {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
  accessibilityLabel?: string;
};

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  className,
  accessibilityLabel,
}: SegmentedControlProps<T>) {
  const { colors } = useTheme();
  const [width, setWidth] = useState(0);
  const reduceMotion = useReducedMotion();
  const index = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  const segmentWidth = options.length ? (width - 4) / options.length : 0;
  const translateX = useSharedValue(0);
  const placed = useRef(false);

  useEffect(() => {
    if (segmentWidth <= 0) return;
    const x = index * segmentWidth;
    if (!placed.current || reduceMotion) {
      placed.current = true;
      translateX.set(x);
    } else {
      translateX.set(withSpring(x, { ...motion.spring, damping: 22 }));
    }
  }, [index, segmentWidth, reduceMotion, translateX]);

  const indicatorStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  return (
    <View
      accessibilityRole="tablist"
      accessibilityLabel={accessibilityLabel}
      onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
      className={cn('h-10 flex-row rounded-lg bg-muted p-0.5', className)}
    >
      {width > 0 ? (
        <Animated.View
          style={[
            indicatorStyle,
            {
              width: segmentWidth,
              position: 'absolute',
              top: 2,
              bottom: 2,
              left: 2,
              borderRadius: radius.md,
              backgroundColor: colors.card,
              boxShadow: elevation.sm,
            },
          ]}
        />
      ) : null}
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityLabel={option.label}
            accessibilityState={{ selected }}
            hitSlop={{ top: 4, bottom: 4 }}
            onPress={() => {
              if (selected) return;
              haptics.selection();
              onChange(option.value);
            }}
            className="flex-1 items-center justify-center"
          >
            <Text
              variant="subhead"
              tone={selected ? 'default' : 'muted'}
              className={selected ? 'font-semibold' : 'font-medium'}
              numberOfLines={1}
              maxFontSizeMultiplier={1.4}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
