/**
 * Chairside design tokens: the single source of truth for color, type, spacing, radius,
 * elevation and motion. Components never hard-code colors; they use the semantic Tailwind
 * classes (`bg-card`, `text-muted-foreground`, ...) backed by CSS variables, or `useTheme()`
 * for props that need a raw value (icons, SVG, navigation).
 *
 * Colors are swappable at runtime (custom themes / salon branding, see #47): pass partial
 * overrides to `ThemeProvider` and every component updates.
 */

export type ColorScheme = 'light' | 'dark';

export const COLOR_TOKENS = [
  'background',
  'foreground',
  'card',
  'card-foreground',
  'muted',
  'muted-foreground',
  'subtle-foreground',
  'border',
  'input',
  'ring',
  'primary',
  'primary-foreground',
  'primary-soft',
  'primary-soft-foreground',
  'success',
  'success-foreground',
  'warning',
  'warning-foreground',
  'destructive',
  'destructive-foreground',
  'overlay',
] as const;

export type ColorToken = (typeof COLOR_TOKENS)[number];
export type ColorPalette = Record<ColorToken, string>;

export const palettes: Record<ColorScheme, ColorPalette> = {
  light: {
    background: '#F7F7F5',
    foreground: '#111113',
    card: '#FFFFFF',
    'card-foreground': '#111113',
    muted: '#EEEEEB',
    'muted-foreground': '#5C5C66',
    'subtle-foreground': '#71717A',
    border: '#E3E3DF',
    input: '#D4D4CF',
    ring: '#4F46E5',
    primary: '#4F46E5',
    'primary-foreground': '#FFFFFF',
    'primary-soft': '#EEF0FF',
    'primary-soft-foreground': '#3730A3',
    success: '#15803D',
    'success-foreground': '#FFFFFF',
    warning: '#B45309',
    'warning-foreground': '#FFFFFF',
    destructive: '#DC2626',
    'destructive-foreground': '#FFFFFF',
    overlay: '#000000',
  },
  dark: {
    background: '#0A0A0B',
    foreground: '#F4F4F5',
    card: '#161618',
    'card-foreground': '#F4F4F5',
    muted: '#212124',
    'muted-foreground': '#A1A1AA',
    'subtle-foreground': '#8E8E98',
    border: '#2A2A2E',
    input: '#3A3A40',
    ring: '#818CF8',
    primary: '#818CF8',
    'primary-foreground': '#0A0A0B',
    'primary-soft': '#1F1D47',
    'primary-soft-foreground': '#C7D2FE',
    success: '#4ADE80',
    'success-foreground': '#0A0A0B',
    warning: '#FBBF24',
    'warning-foreground': '#0A0A0B',
    destructive: '#F87171',
    'destructive-foreground': '#0A0A0B',
    overlay: '#000000',
  },
};

/**
 * Service color tags: `solid` for bars/dots (`card` text on it passes AA), `soft` + `text`
 * for chips and calendar blocks.
 */
export const SERVICE_TAGS = [
  'rose',
  'amber',
  'emerald',
  'sky',
  'violet',
  'fuchsia',
  'teal',
  'slate',
] as const;

export type ServiceTag = (typeof SERVICE_TAGS)[number];
export type ServiceTagColors = { solid: string; soft: string; text: string };

export const serviceTags: Record<ColorScheme, Record<ServiceTag, ServiceTagColors>> = {
  light: {
    rose: { solid: '#E11D48', soft: '#FFE4E8', text: '#9F1239' },
    amber: { solid: '#B45309', soft: '#FEF3C7', text: '#92400E' },
    emerald: { solid: '#047857', soft: '#D1FAE5', text: '#065F46' },
    sky: { solid: '#0369A1', soft: '#E0F2FE', text: '#075985' },
    violet: { solid: '#7C3AED', soft: '#EDE9FE', text: '#5B21B6' },
    fuchsia: { solid: '#A21CAF', soft: '#FAE8FF', text: '#86198F' },
    teal: { solid: '#0F766E', soft: '#CCFBF1', text: '#115E59' },
    slate: { solid: '#475569', soft: '#E2E8F0', text: '#1E293B' },
  },
  dark: {
    rose: { solid: '#FB7185', soft: '#3B1520', text: '#FECDD3' },
    amber: { solid: '#FBBF24', soft: '#3A2A0B', text: '#FDE68A' },
    emerald: { solid: '#34D399', soft: '#0B3326', text: '#A7F3D0' },
    sky: { solid: '#38BDF8', soft: '#0B2C40', text: '#BAE6FD' },
    violet: { solid: '#A78BFA', soft: '#2A1A4D', text: '#DDD6FE' },
    fuchsia: { solid: '#E879F9', soft: '#3A1240', text: '#F5D0FE' },
    teal: { solid: '#2DD4BF', soft: '#0A3330', text: '#99F6E4' },
    slate: { solid: '#94A3B8', soft: '#1E2633', text: '#E2E8F0' },
  },
};

/** iOS-style type ramp (pt). Text scales with the OS Dynamic Type setting. */
export const typography = {
  display: { fontSize: 34, lineHeight: 41, fontWeight: '700' },
  title1: { fontSize: 28, lineHeight: 34, fontWeight: '700' },
  title2: { fontSize: 22, lineHeight: 28, fontWeight: '700' },
  title3: { fontSize: 20, lineHeight: 25, fontWeight: '600' },
  headline: { fontSize: 17, lineHeight: 22, fontWeight: '600' },
  body: { fontSize: 17, lineHeight: 22, fontWeight: '400' },
  callout: { fontSize: 16, lineHeight: 21, fontWeight: '400' },
  subhead: { fontSize: 15, lineHeight: 20, fontWeight: '400' },
  footnote: { fontSize: 13, lineHeight: 18, fontWeight: '400' },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: '500' },
} as const;

export type TypeVariant = keyof typeof typography;

/** 8-pt grid. Tailwind's 4px scale maps onto it (`p-2` = 8, `p-4` = 16, `gap-6` = 24). */
export const spacing = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32, xxl: 48 } as const;

export const radius = { sm: 8, md: 12, lg: 16, xl: 24, full: 9999 } as const;

/** Minimum tap target (Apple HIG). */
export const MIN_TAP_TARGET = 44;

export const elevation = {
  none: 'none',
  sm: '0px 1px 2px rgba(0, 0, 0, 0.06)',
  md: '0px 4px 12px rgba(0, 0, 0, 0.08)',
  lg: '0px 12px 32px rgba(0, 0, 0, 0.18)',
} as const;

export type Elevation = keyof typeof elevation;

/** Motion conventions; honor Reduce Motion via Reanimated's `useReducedMotion()`. */
export const motion = {
  duration: { fast: 120, base: 200, slow: 320 },
  spring: { damping: 18, stiffness: 260, mass: 1 },
  pressScale: 0.97,
} as const;

export function hexToRgbChannels(hex: string): string {
  const value = hex.replace('#', '');
  const full =
    value.length === 3
      ? value
          .split('')
          .map((c) => c + c)
          .join('')
      : value;
  const n = parseInt(full, 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

/** CSS variables consumed by `tailwind.config.js` (`rgb(var(--color-x) / <alpha-value>)`). */
export function toCssVariables(palette: ColorPalette): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const token of COLOR_TOKENS) {
    vars[`--color-${token}`] = hexToRgbChannels(palette[token]);
  }
  return vars;
}

export type ThemeOverrides = Partial<Record<ColorScheme, Partial<ColorPalette>>>;

export function resolvePalette(scheme: ColorScheme, overrides?: ThemeOverrides): ColorPalette {
  return { ...palettes[scheme], ...overrides?.[scheme] };
}
