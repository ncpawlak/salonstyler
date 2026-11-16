import { describe, expect, it } from 'vitest';

import { canonicalCategory, categoryCounts, menuCategories, moveCategory } from './category-utils';

const s = (category: string) => ({ category }) as never;

describe('menuCategories', () => {
  it('keeps the saved order and appends categories only services use', () => {
    const menu = {
      categories: ['Color', 'Cuts'],
      services: [s('Cuts'), s('Extensions'), s('Color')],
      combos: [s('Bridal')],
    };
    expect(menuCategories(menu)).toEqual(['Color', 'Cuts', 'Extensions', 'Bridal']);
  });

  it('works without a saved list', () => {
    expect(menuCategories({ services: [s('Cuts'), s('Cuts')], combos: [] })).toEqual(['Cuts']);
  });
});

describe('categoryCounts', () => {
  it('counts services and combos', () => {
    const counts = categoryCounts({ services: [s('Cuts'), s('Color')], combos: [s('Color')] });
    expect(counts.get('Color')).toBe(2);
    expect(counts.get('Cuts')).toBe(1);
  });
});

describe('canonicalCategory', () => {
  it('reuses an existing category typed in another case', () => {
    expect(canonicalCategory(['Color', 'Cuts'], '  color ')).toBe('Color');
  });

  it('cleans up a new name', () => {
    expect(canonicalCategory(['Color'], ' Bridal   party ')).toBe('Bridal party');
  });
});

describe('moveCategory', () => {
  it('moves up and down, clamped', () => {
    expect(moveCategory(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b']);
    expect(moveCategory(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
    expect(moveCategory(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
  });
});
