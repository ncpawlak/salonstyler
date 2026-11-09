import Ionicons from '@expo/vector-icons/Ionicons';
import type { ComponentProps } from 'react';

import { useTheme } from '@/theme/theme-provider';
import type { ColorToken } from '@/theme/tokens';

export type IconName = ComponentProps<typeof Ionicons>['name'];

export type IconProps = {
  name: IconName;
  size?: number;
  /** A semantic color token, or a raw color (e.g. a service tag). */
  color?: ColorToken | (string & {});
};

/** Decorative by default; give the parent control the accessibility label. */
export function Icon({ name, size = 22, color = 'foreground' }: IconProps) {
  const { colors } = useTheme();
  const resolved = color in colors ? colors[color as ColorToken] : color;
  return (
    <Ionicons
      name={name}
      size={size}
      color={resolved}
      accessibilityElementsHidden
      importantForAccessibility="no"
    />
  );
}
