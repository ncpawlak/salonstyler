import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { SettingsRow } from './row';

describe('settings rows', () => {
  it('each section has unique orders', async () => {
    const dir = join(__dirname, 'rows');
    const rows = await Promise.all(
      readdirSync(dir).map(
        async (f) => ((await import(`./rows/${f}`)) as { default: SettingsRow }).default,
      ),
    );
    const keys = rows.map((r) => `${r.section}:${r.order}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
