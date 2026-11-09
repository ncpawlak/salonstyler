import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { INDEX_FILE, renderToolIndex } from '../../../scripts/gen-tool-index.ts';
import { TOOL_MODULES } from './index.ts';

describe('assistant tool registry', () => {
  it('index.ts is up to date (run `npm run gen:tools -w @chairside/ai`)', async () => {
    expect(readFileSync(INDEX_FILE, 'utf8').replace(/\r\n/g, '\n')).toBe(await renderToolIndex());
  });

  it('has unique names and orders', () => {
    const names = TOOL_MODULES.map((t) => t.name);
    const orders = TOOL_MODULES.map((t) => t.order);
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(orders).size).toBe(orders.length);
  });
});
