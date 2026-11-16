import type { UtilizationState } from '@chairside/core';

import { useTheme } from '@/theme/theme-provider';

export type UtilizationPalette = Record<UtilizationState, string> & {
  /** Stripe color drawn over `tentative`. */
  tentativeStripe: string;
  /** Heatmap tints for levels 0–4 (a closed day gets no tint). */
  heat: readonly [string, string, string, string, string];
};

/** `#RRGGBB` + alpha → `#RRGGBBAA`; other formats pass through unchanged. */
export function withAlpha(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color)?.[1];
  if (!hex) return color;
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
  const a = Math.round(Math.min(1, Math.max(0, alpha)) * 255);
  return `#${full}${a.toString(16).padStart(2, '0')}`;
}

/** One accent: booked is the primary color, open is a soft green, tentative is striped amber. */
export function useUtilizationPalette(): UtilizationPalette {
  const { colors, scheme } = useTheme();
  const dark = scheme === 'dark';
  return {
    booked: colors.primary,
    open: dark ? '#166534' : '#BBF7D0',
    tentative: dark ? '#451A03' : '#FEF3C7',
    tentativeStripe: colors.warning,
    closed: colors.muted,
    heat: [
      'transparent',
      withAlpha(colors.primary, 0.1),
      withAlpha(colors.primary, 0.2),
      withAlpha(colors.primary, 0.35),
      withAlpha(colors.primary, 0.55),
    ],
  };
}

export const stateLabel: Record<UtilizationState, string> = {
  booked: 'Booked',
  open: 'Open',
  tentative: 'Tentative',
  closed: 'Off',
};

export { formatMinutes } from './format';

/** Formats a local `YYYY-MM-DD` (no time zone shift), e.g. `{ weekday: 'short' }` → `Tue`. */
export function formatDate(date: string, options: Intl.DateTimeFormatOptions): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...options }).format(
    Date.UTC(y!, m! - 1, d!),
  );
}
