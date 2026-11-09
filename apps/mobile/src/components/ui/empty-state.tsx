import { View } from 'react-native';

import { cn } from '@/lib/cn';

import { Button } from './button';
import { Icon, type IconName } from './icon';
import { Text } from './text';

export type EmptyStateProps = {
  icon: IconName;
  title: string;
  message?: string;
  actionLabel?: string;
  onAction?: () => void;
  className?: string;
};

export function EmptyState({
  icon,
  title,
  message,
  actionLabel,
  onAction,
  className,
}: EmptyStateProps) {
  return (
    <View className={cn('items-center gap-3 px-8 py-12', className)}>
      <View className="mb-1 h-16 w-16 items-center justify-center rounded-full bg-primary-soft">
        <Icon name={icon} size={28} color="primary-soft-foreground" />
      </View>
      <Text variant="title3" className="text-center">
        {title}
      </Text>
      {message ? (
        <Text variant="subhead" tone="muted" className="text-center">
          {message}
        </Text>
      ) : null}
      {actionLabel && onAction ? (
        <View className="mt-2">
          <Button label={actionLabel} onPress={onAction} variant="secondary" />
        </View>
      ) : null}
    </View>
  );
}
