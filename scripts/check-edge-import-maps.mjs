#!/usr/bin/env node
// Verifies that every Supabase Edge Function's deno.json import map covers every bare specifier
// reachable from its entrypoint (index.ts). The edge runtime fails to boot (BOOT_ERROR) when a
// workspace package pulls in a `@chairside/*` subpath its function's import map doesn't list.
//
//   node scripts/check-edge-import-maps.mjs         # report gaps, exit 1 if any
//   node scripts/check-edge-import-maps.mjs --fix   # add missing @chairside/* entries
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const functionsDir = join(root, 'supabase', 'functions');
const fix = process.argv.includes('--fix');

const toPosix = (p) => p.split(sep).join('/');

function specifiersOf(file) {
  const info = ts.preProcessFile(readFileSync(file, 'utf8'), true, true);
  return info.importedFiles.map((f) => f.fileName);
}

/** Resolves a bare specifier through an import map (exact match, then longest "/" prefix). */
function mapSpecifier(spec, imports, mapDir) {
  if (imports[spec] !== undefined) return { target: imports[spec], mapDir };
  let best;
  for (const key of Object.keys(imports)) {
    if (key.endsWith('/') && spec.startsWith(key) && (!best || key.length > best.length)) {
      best = key;
    }
  }
  if (!best) return null;
  return { target: imports[best] + spec.slice(best.length), mapDir };
}

/** Maps `@chairside/<pkg>[/<sub>]` to a file via the package's package.json `exports`. */
function resolveFromWorkspace(spec) {
  const m = /^@chairside\/([^/]+)(?:\/(.+))?$/.exec(spec);
  if (!m) return null;
  const pkgDir = join(root, 'packages', m[1]);
  const pkgJson = join(pkgDir, 'package.json');
  if (!existsSync(pkgJson)) return null;
  const { exports = {} } = JSON.parse(readFileSync(pkgJson, 'utf8'));
  const sub = m[2] ? `./${m[2]}` : '.';
  let target = typeof exports[sub] === 'string' ? exports[sub] : undefined;
  if (!target) {
    for (const [key, value] of Object.entries(exports)) {
      if (!key.includes('*') || typeof value !== 'string') continue;
      const [pre, post] = key.split('*');
      if (sub.startsWith(pre) && sub.endsWith(post)) {
        target = value.replace('*', sub.slice(pre.length, sub.length - post.length));
        break;
      }
    }
  }
  if (!target) return null;
  const file = join(pkgDir, target);
  return existsSync(file) ? file : null;
}

function checkFunction(name) {
  const fnDir = join(functionsDir, name);
  const mapPath = join(fnDir, 'deno.json');
  const entry = join(fnDir, 'index.ts');
  const imports = existsSync(mapPath)
    ? (JSON.parse(readFileSync(mapPath, 'utf8')).imports ?? {})
    : {};
  const missing = new Map(); // specifier -> first importing file
  const broken = [];
  const seen = new Set();
  const queue = [entry];

  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of specifiersOf(file)) {
      if (/^(npm|jsr|node|https?|data):/.test(spec)) continue;
      let target;
      if (spec.startsWith('.') || spec.startsWith('/')) {
        target = resolve(dirname(file), spec);
      } else {
        const mapped = mapSpecifier(spec, imports, fnDir);
        if (!mapped) {
          if (!missing.has(spec)) missing.set(spec, file);
          // Keep walking through the workspace file so transitive gaps surface in one run.
          const ws = resolveFromWorkspace(spec);
          if (ws) queue.push(ws);
          continue;
        }
        if (/^(npm|jsr|node|https?|data):/.test(mapped.target)) continue;
        target = resolve(mapped.mapDir, mapped.target);
      }
      if (!existsSync(target)) {
        broken.push(
          `${spec} -> ${toPosix(relative(root, target))} (from ${toPosix(relative(root, file))})`,
        );
        continue;
      }
      queue.push(target);
    }
  }

  const problems = [...broken.map((b) => `missing file: ${b}`)];
  const additions = {};
  for (const [spec, from] of missing) {
    const ws = resolveFromWorkspace(spec);
    if (fix && ws) {
      additions[spec] = toPosix(relative(fnDir, ws));
    } else {
      problems.push(
        `not in import map: "${spec}" (imported by ${toPosix(relative(root, from))})` +
          (ws ? ` -> add "${spec}": "${toPosix(relative(fnDir, ws))}"` : ''),
      );
    }
  }

  if (Object.keys(additions).length) {
    const json = JSON.parse(readFileSync(mapPath, 'utf8'));
    const merged = { ...json.imports, ...additions };
    const ordered = Object.fromEntries(
      Object.entries(merged).sort(([a], [b]) => {
        const ca = a.startsWith('@chairside/');
        const cb = b.startsWith('@chairside/');
        if (ca !== cb) return ca ? 1 : -1;
        return ca ? (a < b ? -1 : a > b ? 1 : 0) : 0;
      }),
    );
    json.imports = ordered;
    writeFileSync(mapPath, JSON.stringify(json, null, 2) + '\n');
    console.log(`${name}: added ${Object.keys(additions).join(', ')}`);
  }
  return problems;
}

const functions = readdirSync(functionsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(functionsDir, d.name, 'index.ts')))
  .map((d) => d.name)
  .sort();

let failed = 0;
for (const name of functions) {
  const problems = checkFunction(name);
  if (problems.length) {
    failed++;
    console.error(`\n✗ supabase/functions/${name}`);
    for (const p of problems) console.error(`  ${p}`);
  }
}

if (failed) {
  console.error(
    `\n${failed} edge function(s) have incomplete import maps. ` +
      'Run `node scripts/check-edge-import-maps.mjs --fix` to add missing @chairside/* entries.',
  );
  process.exit(1);
}
console.log(`All ${functions.length} edge function import maps cover their import graphs.`);
