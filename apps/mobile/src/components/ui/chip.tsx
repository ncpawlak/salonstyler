import { Pressable, View } from 'react-native';

import { cn } from '@/lib/cn';
import { haptics } from '@/lib/haptics';
import { useTheme } from '@/theme/theme-provider';
import type { ServiceTag } from '@/theme/tokens';

import { Icon, type IconName } from './icon';
import { Text } from './text';

export type ChipProps = {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  /** Service color tag: renders a colored dot and tinted fill. */
  tag?: ServiceTag;
  icon?: IconName;
  className?: string;
};

export function Chip({ label, selected, onPress, tag, icon, className }: ChipProps) {
  const { tag: tagColors } = useTheme();
  const colors = tag ? tagColors(tag) : undefined;
  const tinted = colors && !onPress;

  const body = (
    <View
      className={cn(
        'h-9 flex-row items-center gap-1.5 self-start rounded-full border px-3',
        selected ? 'border-primary bg-primary-soft' : 'border-border bg-card',
        className,
      )}
      style={tinted ? { backgroundColor: colors.soft, borderColor: colors.soft } : undefined}
    >
      {colors ? (
        <View className="h-2 w-2 rounded-full" style={{ backgroundColor: colors.solid }} />
      ) : null}
      {icon ? (
        <Icon name={icon} size={16} color={selected ? 'primary-soft-foreground' : 'foreground'} />
      ) : null}
      <Text
        variant="subhead"
        className="font-medium"
        tone={selected ? 'primary' : 'default'}
        style={tinted ? { color: colors.text } : undefined}
        numberOfLines={1}
      >
        {label}
      </Text>
    </View>
  );

  if (!onPress) return body;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: !!selected }}
      hitSlop={4}
      onPress={() => {
        haptics.selection();
        onPress();
      }}
    >
      {body}
    </Pressable>
  );
}
