import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, View, type PressableProps } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';

import { cn } from '@/lib/cn';
import { haptics } from '@/lib/haptics';
import { useTheme } from '@/theme/theme-provider';
import { motion, type ColorToken } from '@/theme/tokens';

import { Icon, type IconName } from './icon';
import { Text } from './text';

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'destructive';
export type ButtonSize = 'sm' | 'md' | 'lg' | 'icon';

const containerClass: Record<ButtonVariant, string> = {
  primary: 'bg-primary',
  secondary: 'bg-muted',
  outline: 'border border-input bg-transparent',
  ghost: 'bg-transparent',
  destructive: 'bg-destructive',
};

const labelColor: Record<ButtonVariant, ColorToken> = {
  primary: 'primary-foreground',
  secondary: 'foreground',
  outline: 'foreground',
  ghost: 'primary',
  destructive: 'destructive-foreground',
};

const sizeClass: Record<ButtonSize, string> = {
  sm: 'min-h-9 px-3 rounded-md gap-1.5',
  md: 'min-h-tap px-4 rounded-lg gap-2',
  lg: 'min-h-[52px] px-5 rounded-lg gap-2',
  icon: 'h-tap w-tap rounded-full',
};

export type ButtonProps = Omit<PressableProps, 'children'> & {
  label?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  iconRight?: IconName;
  loading?: boolean;
  fullWidth?: boolean;
  /** Share space equally with siblings in a row (lex-1 on the touch target). */
  grow?: boolean;
  haptic?: keyof typeof haptics | false;
  className?: string;
  children?: ReactNode;
};

const AnimatedView = Animated.createAnimatedComponent(View);

export function Button({
  label,
  variant = 'primary',
  size = 'md',
  icon,
  iconRight,
  loading,
  fullWidth,
  grow,
  haptic = 'tap',
  disabled,
  className,
  children,
  onPress,
  accessibilityLabel,
  ...props
}: ButtonProps) {
  const { colors } = useTheme();
  const scale = useSharedValue(1);
  const reduceMotion = useReducedMotion();
  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  const color = labelColor[variant];
  const isDisabled = disabled || loading;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: !!isDisabled, busy: !!loading }}
      disabled={isDisabled}
      // Small buttons still get a 44pt hit area.
      hitSlop={size === 'sm' ? 6 : undefined}
      onPressIn={() => {
        if (!reduceMotion) scale.set(withSpring(motion.pressScale, motion.spring));
      }}
      onPressOut={() => {
        scale.set(withSpring(1, motion.spring));
      }}
      onPress={(e) => {
        if (haptic) haptics[haptic]();
        onPress?.(e);
      }}
      className={cn(
        grow ? 'flex-1' : fullWidth ? 'self-stretch' : 'self-start',
        isDisabled && 'opacity-50',
      )}
      {...props}
    >
      <AnimatedView style={animatedStyle}>
        <View
          className={cn(
            'flex-row items-center justify-center',
            containerClass[variant],
            sizeClass[size],
            className,
          )}
        >
          {loading ? (
            <ActivityIndicator color={colors[color]} />
          ) : (
            <>
              {icon ? <Icon name={icon} size={size === 'sm' ? 16 : 20} color={color} /> : null}
              {label ? (
                <Text
                  variant={size === 'sm' ? 'subhead' : 'headline'}
                  className="font-semibold"
                  style={{ color: colors[color] }}
                  numberOfLines={1}
                >
                  {label}
                </Text>
              ) : null}
              {children}
              {iconRight ? (
                <Icon name={iconRight} size={size === 'sm' ? 16 : 20} color={color} />
              ) : null}
            </>
          )}
        </View>
      </AnimatedView>
    </Pressable>
  );
}
