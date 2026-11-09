import { View, type ViewProps } from 'react-native';

import { cn } from '@/lib/cn';
import { elevation as elevationTokens, type Elevation } from '@/theme/tokens';

import { Text } from './text';

export type CardProps = ViewProps & {
  elevation?: Elevation;
  padded?: boolean;
  className?: string;
};

export function Card({ elevation = 'sm', padded = true, className, style, ...props }: CardProps) {
  return (
    <View
      className={cn('rounded-xl border border-border bg-card', padded && 'p-4', className)}
      style={[{ boxShadow: elevationTokens[elevation] }, style]}
      {...props}
    />
  );
}

export function SectionHeader({
  title,
  action,
  className,
}: {
  title: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <View className={cn('flex-row items-center justify-between px-1 pb-2 pt-6', className)}>
      <Text variant="footnote" tone="muted" className="font-semibold uppercase tracking-wide">
        {title}
      </Text>
      {action}
    </View>
  );
}
