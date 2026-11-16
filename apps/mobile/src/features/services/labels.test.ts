import { describe, expect, it } from 'vitest';

import { filterLabels, segmentLabels } from './labels';

const svc = (...labels: (string | undefined)[]) => ({
  segments: labels.map((label) => ({ kind: 'busy' as const, minutes: 10, label })),
});

describe('segmentLabels', () => {
  it('lists distinct labels from services and add-ons, most used first', () => {
    const menu = {
      services: [
        svc('Apply', 'Process', 'Rinse & style'),
        svc('Apply', 'Process', 'Rinse & style'),
        svc('Cut', undefined),
      ],
      addons: [svc('Apply', ' ')],
    };
    expect(segmentLabels(menu as never)).toEqual(['Apply', 'Process', 'Rinse & style', 'Cut']);
  });

  it('merges case and spacing variants under the most common spelling', () => {
    const menu = {
      services: [svc('Rinse & style', 'rinse  & style', 'Rinse & style')],
      addons: [],
    };
    expect(segmentLabels(menu as never)).toEqual(['Rinse & style']);
  });
});

describe('filterLabels', () => {
  const labels = ['Process', 'Apply', 'Rinse & style', 'Blow-dry & style', 'Cut'];

  it('shows everything for an empty field', () => {
    expect(filterLabels(labels, '')).toEqual(labels);
  });

  it('filters as you type, prefix matches first', () => {
    expect(filterLabels(labels, 'st')).toEqual(['Rinse & style', 'Blow-dry & style']);
    expect(filterLabels(labels, 'r')).toEqual(['Rinse & style', 'Process', 'Blow-dry & style']);
  });

  it('hides the label already typed', () => {
    expect(filterLabels(labels, 'apply')).toEqual([]);
  });
});
