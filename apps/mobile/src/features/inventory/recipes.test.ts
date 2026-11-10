import { describe, expect, it } from 'vitest';

import { parseRecipe, recipeSummary } from './recipes';

const products = [
  { id: 'tube', name: '6N', brand: 'Shades EQ', unit: 'tube' },
  { id: 'dev', name: 'Processing Solution', brand: null, unit: 'ml' },
  { id: 'foil', name: 'Foil sheets', brand: null, unit: 'each' },
];

describe('recipeSummary', () => {
  it('lists each line in the product unit', () => {
    expect(
      recipeSummary(
        [
          { productId: 'tube', quantity: 1 },
          { productId: 'dev', quantity: 60 },
          { productId: 'foil', quantity: 12.5 },
        ],
        products,
      ),
    ).toBe('1 tube Shades EQ 6N · 60 ml Processing Solution · 12.5 Foil sheets');
  });

  it('is null without a recipe and skips unknown products', () => {
    expect(recipeSummary(undefined, products)).toBeNull();
    expect(recipeSummary([], products)).toBeNull();
    expect(recipeSummary([{ productId: 'gone', quantity: 1 }], products)).toBe('');
  });
});

describe('parseRecipe', () => {
  it('parses typed amounts', () => {
    expect(
      parseRecipe([
        { productId: 'tube', quantity: '1' },
        { productId: 'dev', quantity: ' 0.06 ' },
      ]),
    ).toEqual({
      lines: [
        { productId: 'tube', quantity: 1 },
        { productId: 'dev', quantity: 0.06 },
      ],
    });
    expect(parseRecipe([])).toEqual({ lines: [] });
  });

  it('rejects empty, zero, negative and over-precise amounts', () => {
    for (const quantity of ['', '0', '-1', '1.005', 'abc']) {
      expect(parseRecipe([{ productId: 'tube', quantity }])).toHaveProperty('error');
    }
  });
});
