/** @type {import('tailwindcss').Config} */

// Semantic colors are CSS variables so themes can be swapped at runtime (see src/theme/tokens.ts).
const colorTokens = [
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
];

const colors = Object.fromEntries(
  colorTokens.map((token) => [token, `rgb(var(--color-${token}) / <alpha-value>)`]),
);

const type = (size, lineHeight, fontWeight) => [
  `${size}px`,
  { lineHeight: `${lineHeight}px`, fontWeight },
];

module.exports = {
  content: ['./src/**/*.{ts,tsx}'],
  presets: [require('nativewind/preset')],
  darkMode: 'class',
  theme: {
    extend: {
      colors,
      fontSize: {
        display: type(34, 41, '700'),
        title1: type(28, 34, '700'),
        title2: type(22, 28, '700'),
        title3: type(20, 25, '600'),
        headline: type(17, 22, '600'),
        body: type(17, 22, '400'),
        callout: type(16, 21, '400'),
        subhead: type(15, 20, '400'),
        footnote: type(13, 18, '400'),
        caption: type(12, 16, '500'),
      },
      borderRadius: {
        sm: '8px',
        md: '12px',
        lg: '16px',
        xl: '24px',
      },
      spacing: {
        tap: '44px',
      },
    },
  },
  plugins: [],
};
