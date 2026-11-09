/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import tailwindConfig from '../../tailwind.config.js';
import { AA_LARGE, AA_TEXT, contrastRatio } from './contrast';
import {
  COLOR_TOKENS,
  SERVICE_TAGS,
  hexToRgbChannels,
  palettes,
  resolvePalette,
  serviceTags,
  toCssVariables,
  type ColorScheme,
  type ColorToken,
} from './tokens';

const schemes: ColorScheme[] = ['light', 'dark'];

const textPairs: [fg: ColorToken, bg: ColorToken][] = [
  ['foreground', 'background'],
  ['foreground', 'muted'],
  ['card-foreground', 'card'],
  ['muted-foreground', 'background'],
  ['muted-foreground', 'card'],
  ['muted-foreground', 'muted'],
  ['subtle-foreground', 'card'],
  ['primary', 'background'],
  ['primary', 'card'],
  ['primary-foreground', 'primary'],
  ['primary-soft-foreground', 'primary-soft'],
  ['success-foreground', 'success'],
  ['warning-foreground', 'warning'],
  ['destructive-foreground', 'destructive'],
  ['destructive', 'card'],
];

describe.each(schemes)('%s palette', (scheme) => {
  const p = palettes[scheme];

  it.each(textPairs)('%s on %s meets WCAG AA (4.5:1)', (fg, bg) => {
    expect(contrastRatio(p[fg], p[bg])).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it('subtle text and focus ring meet 3:1 against the background', () => {
    expect(contrastRatio(p['subtle-foreground'], p.background)).toBeGreaterThanOrEqual(AA_LARGE);
    expect(contrastRatio(p.ring, p.background)).toBeGreaterThanOrEqual(AA_LARGE);
  });

  it.each(SERVICE_TAGS)('service tag %s is readable', (tag) => {
    const c = serviceTags[scheme][tag];
    expect(contrastRatio(c.text, c.soft)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrastRatio(c.solid, p.card)).toBeGreaterThanOrEqual(AA_TEXT);
  });
});

describe('token plumbing', () => {
  it('converts hex to rgb channels', () => {
    expect(hexToRgbChannels('#4F46E5')).toBe('79 70 229');
    expect(hexToRgbChannels('#fff')).toBe('255 255 255');
  });

  it('applies runtime overrides on top of the base palette', () => {
    const p = resolvePalette('light', { light: { primary: '#BE185D' } });
    expect(p.primary).toBe('#BE185D');
    expect(p.background).toBe(palettes.light.background);
    expect(toCssVariables(p)['--color-primary']).toBe('190 24 93');
  });

  it('exposes every color token as a Tailwind color', () => {
    const colors = (tailwindConfig as { theme: { extend: { colors: Record<string, string> } } })
      .theme.extend.colors;
    for (const token of COLOR_TOKENS) {
      expect(colors[token]).toBe(`rgb(var(--color-${token}) / <alpha-value>)`);
    }
  });

  it('keeps global.css defaults in sync with tokens', () => {
    const css = readFileSync(fileURLToPath(new URL('../global.css', import.meta.url)), 'utf8');
    const [lightBlock, darkBlock] = css.split('.dark');
    for (const [scheme, block] of [
      ['light', lightBlock],
      ['dark', darkBlock],
    ] as const) {
      for (const [name, value] of Object.entries(toCssVariables(palettes[scheme]))) {
        expect(block, `${scheme} ${name}`).toContain(`${name}: ${value};`);
      }
    }
  });
});
