import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Edge Functions (Deno) import `@chairside/core` and `@chairside/db` straight from source, and
 * Deno's bundler needs explicit file extensions. Keep every relative import ending in `.ts`.
 */
const root = fileURLToPath(new URL('../..', import.meta.url));
const dirs = ['core/src', 'db/src'].map((d) => join(root, d));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('Deno-compatible imports', () => {
  it('relative imports in core and db name their .ts file', () => {
    const offenders: string[] = [];
    for (const file of dirs.flatMap(files)) {
      const source = readFileSync(file, 'utf8');
      for (const m of source.matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
        if (!/\.tsx?$/.test(m[1]!)) offenders.push(`${relative(root, file)}: ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
