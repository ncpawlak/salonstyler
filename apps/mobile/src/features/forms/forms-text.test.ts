import { describe, expect, it } from 'vitest';

import { formsText } from './forms-text';

const TOKEN = 'f'.repeat(64);

describe('forms text', () => {
  it('greets by first name and names the one missing form, with the link', () => {
    const text = formsText(
      {
        clientName: '  Karina  Lopez ',
        startsAt: '2026-12-18T16:00:00Z',
        manageToken: TOKEN,
        missing: ['Color Consent / Patch Test'],
      },
      'Studio K',
      'America/Chicago',
      'https://app.example.com/',
    );
    expect(text.startsWith('Hi Karina! Before your Studio K appointment on ')).toBe(true);
    expect(text).toContain('10:00');
    expect(text).toContain('sign the Color Consent / Patch Test form:');
    expect(text.endsWith(` https://app.example.com/f/${TOKEN}`)).toBe(true);
  });

  it('keeps it short for several forms', () => {
    const text = formsText(
      {
        clientName: null,
        startsAt: '2026-12-18T16:00:00Z',
        manageToken: TOKEN,
        missing: ['A', 'B'],
      },
      'Studio K',
      'America/Chicago',
      'https://x.test',
    );
    expect(text.startsWith('Before your Studio K appointment')).toBe(true);
    expect(text).toContain('a couple of quick forms');
  });
});
