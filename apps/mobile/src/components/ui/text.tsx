import { Text as RNText, type TextProps as RNTextProps } from 'react-native';

import { cn } from '@/lib/cn';
import type { TypeVariant } from '@/theme/tokens';

export type TextTone =
  'default' | 'muted' | 'subtle' | 'primary' | 'success' | 'warning' | 'destructive' | 'inverse';

const variantClass: Record<TypeVariant, string> = {
  display: 'text-display font-bold tracking-tight',
  title1: 'text-title1 font-bold tracking-tight',
  title2: 'text-title2 font-bold',
  title3: 'text-title3 font-semibold',
  headline: 'text-headline font-semibold',
  body: 'text-body',
  callout: 'text-callout',
  subhead: 'text-subhead',
  footnote: 'text-footnote',
  caption: 'text-caption font-medium',
};

const toneClass: Record<TextTone, string> = {
  default: 'text-foreground',
  muted: 'text-muted-foreground',
  subtle: 'text-subtle-foreground',
  primary: 'text-primary',
  success: 'text-success',
  warning: 'text-warning',
  destructive: 'text-destructive',
  inverse: 'text-primary-foreground',
};

const headingVariants = new Set<TypeVariant>(['display', 'title1', 'title2', 'title3']);

export type TextProps = RNTextProps & {
  variant?: TypeVariant;
  tone?: TextTone;
  /** Tabular, bold numerals for times, counts and money. */
  numeric?: boolean;
  className?: string;
};

export function Text({
  variant = 'body',
  tone = 'default',
  numeric,
  className,
  style,
  accessibilityRole,
  ...props
}: TextProps) {
  return (
    <RNText
      accessibilityRole={accessibilityRole ?? (headingVariants.has(variant) ? 'header' : undefined)}
      maxFontSizeMultiplier={headingVariants.has(variant) ? 1.6 : 2.2}
      className={cn(variantClass[variant], toneClass[tone], className)}
      style={[numeric ? { fontVariant: ['tabular-nums'] } : null, style]}
      {...props}
    />
  );
}
