import type { ReactNode } from 'react';
import { Pressable, View } from 'react-native';

import { cn } from '@/lib/cn';
import { haptics } from '@/lib/haptics';

import { Icon } from './icon';
import { Text } from './text';

export type ListRowProps = {
  title: string;
  subtitle?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  /** Shows a disclosure chevron; implied when `onPress` is set unless `trailing` is given. */
  chevron?: boolean;
  onPress?: () => void;
  destructive?: boolean;
  accessibilityHint?: string;
  className?: string;
  /** Hide the bottom separator (last row in a group). */
  last?: boolean;
};

export function ListRow({
  title,
  subtitle,
  leading,
  trailing,
  chevron,
  onPress,
  destructive,
  accessibilityHint,
  className,
  last,
}: ListRowProps) {
  const showChevron = chevron ?? (!!onPress && !trailing);
  const content = (
    <View className={cn('min-h-[56px] flex-row items-center gap-3 px-4 py-2', className)}>
      {leading}
      <View className={cn('flex-1 justify-center gap-0.5 py-1', !last && 'border-b border-border')}>
        <Text variant="body" tone={destructive ? 'destructive' : 'default'} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text variant="subhead" tone="muted" numberOfLines={2}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {trailing}
      {showChevron ? <Icon name="chevron-forward" size={18} color="subtle-foreground" /> : null}
    </View>
  );

  if (!onPress) return content;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title}
      accessibilityHint={accessibilityHint}
      onPress={() => {
        haptics.selection();
        onPress();
      }}
      className="active:bg-muted"
    >
      {content}
    </Pressable>
  );
}

/** Inset grouped container for ListRows (iOS Settings style). */
export function ListGroup({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <View className={cn('overflow-hidden rounded-xl border border-border bg-card', className)}>
      {children}
    </View>
  );
}
