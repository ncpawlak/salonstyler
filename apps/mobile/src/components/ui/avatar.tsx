import { View } from 'react-native';

import { cn } from '@/lib/cn';
import { useTheme } from '@/theme/theme-provider';
import type { ServiceTag } from '@/theme/tokens';

import { Text } from './text';

export type AvatarProps = {
  name: string;
  size?: number;
  tag?: ServiceTag;
  className?: string;
};

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('');
}

export function Avatar({ name, size = 40, tag, className }: AvatarProps) {
  const { tag: tagColors } = useTheme();
  const c = tag ? tagColors(tag) : undefined;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className={cn('items-center justify-center rounded-full bg-primary-soft', className)}
      style={[{ width: size, height: size }, c ? { backgroundColor: c.soft } : null]}
    >
      <Text
        className="font-semibold text-primary-soft-foreground"
        style={[{ fontSize: size * 0.38, lineHeight: size * 0.5 }, c ? { color: c.text } : null]}
        maxFontSizeMultiplier={1}
      >
        {initials(name)}
      </Text>
    </View>
  );
}
