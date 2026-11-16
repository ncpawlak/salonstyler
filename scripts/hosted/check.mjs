#!/usr/bin/env node
// Offline consistency check for the hosted setup (runs in CI, no network):
//   - every supabase/functions/<name> has a [functions.<name>] verify_jwt entry in config.toml
//   - every env var the functions read is in scripts/hosted/manifest.mjs and .env.hosted.example
//   - every Vault secret the migrations read is in the manifest
//   - the Stripe events in the manifest match what stripe-webhook handles
//
//   npm run check:hosted
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { deployPlan, FUNCTIONS_DIR, migrationFacts, parseEnv, ROOT } from './lib.mjs';
import {
  FUNCTION_SECRETS,
  LOCAL_ONLY_ENV,
  PLATFORM_ENV,
  STRIPE_WEBHOOK_EVENTS,
  TOOLING_ENV,
  VAULT_SECRETS,
} from './manifest.mjs';

const problems = [];
const rel = (p) => relative(ROOT, p).split(sep).join('/');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) out.push(path);
  }
  return out;
}

// 1. Functions ↔ config.toml
const { functions, problems: planProblems } = deployPlan();
problems.push(...planProblems);

// 2. Env vars read by functions (directly, or through packages/*/src/server via an env object)
const known = new Set([...FUNCTION_SECRETS.map((s) => s.name), ...PLATFORM_ENV, ...LOCAL_ONLY_ENV]);
const read = new Map();
const note = (name, file) => {
  if (!read.has(name)) read.set(name, rel(file));
};
for (const file of walk(FUNCTIONS_DIR)) {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(/Deno\.env\.get\(\s*['"]([A-Z0-9_]+)['"]/g)) note(m[1], file);
}
const packagesDir = join(ROOT, 'packages');
for (const pkg of readdirSync(packagesDir)) {
  const src = join(packagesDir, pkg, 'src');
  let files = [];
  try {
    files = walk(src);
  } catch {
    continue;
  }
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    if (!/FromEnv\b|Deno\.env/.test(text)) continue;
    for (const m of text.matchAll(/(?<![.\w])env\.([A-Z][A-Z0-9_]{2,})\b/g)) note(m[1], file);
    for (const m of text.matchAll(/Deno\.env\.get\(\s*['"]([A-Z0-9_]+)['"]/g)) note(m[1], file);
  }
}
for (const [name, file] of read) {
  if (!known.has(name)) {
    problems.push(
      `${file} reads ${name}, which isn't in scripts/hosted/manifest.mjs (FUNCTION_SECRETS, PLATFORM_ENV or LOCAL_ONLY_ENV)`,
    );
  }
}

// 3. .env.hosted.example lists every function secret and tooling key
const example = readFileSync(join(ROOT, '.env.hosted.example'), 'utf8');
const exampleKeys = new Set([
  ...Object.keys(parseEnv(example)),
  ...[...example.matchAll(/^#\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]),
]);
for (const name of [...FUNCTION_SECRETS.map((s) => s.name), ...TOOLING_ENV]) {
  if (!exampleKeys.has(name)) problems.push(`.env.hosted.example doesn't list ${name}`);
}

// 4. Vault secrets the migrations read
const facts = migrationFacts();
const vaultKnown = new Set(VAULT_SECRETS.map((v) => v.name));
for (const name of facts.vault) {
  if (!vaultKnown.has(name)) {
    problems.push(
      `a migration reads Vault secret '${name}', which isn't in VAULT_SECRETS (scripts/hosted/manifest.mjs)`,
    );
  }
}

// 5. Stripe webhook events
const webhookSrc = readFileSync(
  join(ROOT, 'packages', 'payments', 'src', 'server', 'webhook.ts'),
  'utf8',
);
const block =
  /PAYMENT_INTENT_EVENTS[\s\S]*?HANDLED_STRIPE_EVENTS[\s\S]*?\]\s*as const/.exec(webhookSrc)?.[0] ??
  '';
const handled = new Set([...block.matchAll(/'([a-z_]+\.[a-z_.]+)'/g)].map((m) => m[1]));
const listed = new Set(STRIPE_WEBHOOK_EVENTS);
if (!handled.size)
  problems.push(
    'could not read HANDLED_STRIPE_EVENTS from packages/payments/src/server/webhook.ts',
  );
for (const e of handled)
  if (!listed.has(e)) problems.push(`stripe-webhook handles ${e}; add it to STRIPE_WEBHOOK_EVENTS`);
for (const e of listed)
  if (!handled.has(e))
    problems.push(`STRIPE_WEBHOOK_EVENTS lists ${e}, which stripe-webhook doesn't handle`);

if (problems.length) {
  console.error('\n✗ Hosted setup manifest is out of date:');
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    '\nUpdate supabase/config.toml, scripts/hosted/manifest.mjs, .env.hosted.example and docs/pilot-cutover.md.',
  );
  process.exit(1);
}
console.log(
  `Hosted manifest OK: ${functions.length} functions, ${read.size} env vars, ${facts.vault.size} Vault secrets, ` +
    `${facts.cron.size} cron jobs, ${facts.extensions.length} extensions, ${facts.buckets.length} buckets.`,
);
