import { View } from 'react-native';

import { cn } from '@/lib/cn';

import { Text } from './text';

export type BadgeTone = 'neutral' | 'primary' | 'success' | 'warning' | 'destructive';

const toneClass: Record<BadgeTone, { box: string; text: string }> = {
  neutral: { box: 'bg-muted', text: 'text-foreground' },
  primary: { box: 'bg-primary-soft', text: 'text-primary-soft-foreground' },
  success: { box: 'bg-success', text: 'text-success-foreground' },
  warning: { box: 'bg-warning', text: 'text-warning-foreground' },
  destructive: { box: 'bg-destructive', text: 'text-destructive-foreground' },
};

export type BadgeProps = {
  label: string | number;
  tone?: BadgeTone;
  className?: string;
  accessibilityLabel?: string;
};

export function Badge({ label, tone = 'neutral', className, accessibilityLabel }: BadgeProps) {
  const t = toneClass[tone];
  return (
    <View
      accessible
      accessibilityLabel={accessibilityLabel ?? String(label)}
      className={cn('min-w-5 items-center self-start rounded-full px-2 py-0.5', t.box, className)}
    >
      <Text variant="caption" className={cn('font-semibold', t.text)} numeric>
        {label}
      </Text>
    </View>
  );
}
