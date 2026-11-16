#!/usr/bin/env node
// Creates or updates the Vault secrets the pg_cron jobs read (notifier_url, notifier_secret).
// notifier_secret is taken from NOTIFIER_SECRET in .env.hosted so the two can't drift.
//
//   npm run hosted:vault                 print the SQL with the secret masked (safe to share)
//   npm run hosted:vault -- --out f.sql  write the full SQL to a file (contains the secret; delete it after)
//   npm run hosted:vault -- --apply      run it on the hosted database (supabase db query)
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  cliError,
  dbRemote,
  die,
  loadHostedEnv,
  managementApi,
  parseArgs,
  privateTempFile,
  requireRef,
  ROOT,
  sqlLiteral,
  supabase,
} from './lib.mjs';
import { VAULT_SECRETS } from './manifest.mjs';

const { flags } = parseArgs();
const { env } = loadHostedEnv(flags);
const ref = requireRef(env, flags);

const entries = [];
for (const v of VAULT_SECRETS) {
  if (!v.value) continue; // optional, derived by the migrations
  const value = v.value(env, ref);
  if (!value) die(`${v.name} has no value. ${v.about} Set it in .env.hosted.`);
  entries.push({ name: v.name, value, secret: Boolean(v.secret) });
}

const sql = (mask) =>
  [
    '-- Chairside Vault secrets for pg_cron (npm run hosted:vault). Safe to re-run.',
    '-- waitlist_url / marketing_url: leave unset; the cron jobs derive them from notifier_url.',
    'do $$',
    'declare',
    '  existing uuid;',
    'begin',
    ...entries.flatMap(({ name, value, secret }) => {
      const v = mask && secret ? "'<NOTIFIER_SECRET from .env.hosted>'" : sqlLiteral(value);
      const n = sqlLiteral(name);
      return [
        `  select id into existing from vault.secrets where name = ${n};`,
        '  if existing is null then',
        `    perform vault.create_secret(${v}, ${n});`,
        '  else',
        `    perform vault.update_secret(existing, ${v});`,
        '  end if;',
      ];
    }),
    'end $$;',
    '',
  ].join('\n');

if (typeof flags.out === 'string') {
  const path = resolve(ROOT, flags.out);
  writeFileSync(path, sql(false), { mode: 0o600 });
  console.log(
    `Wrote ${path}. It contains the notifier secret: run it in the SQL editor, then delete the file.`,
  );
  process.exit(0);
}

if (!flags.apply) {
  console.log(sql(true));
  console.log(
    '-- Apply with: npm run hosted:vault -- --apply   (or --out <file> for the SQL editor)',
  );
  process.exit(0);
}

console.log(`Writing Vault secrets ${entries.map((e) => e.name).join(', ')} on ${ref}…`);
if (env.SUPABASE_ACCESS_TOKEN) {
  const res = await managementApi(env.SUPABASE_ACCESS_TOKEN, `/projects/${ref}/database/query`, {
    method: 'POST',
    body: { query: sql(false) },
  });
  if (!res.ok)
    die(
      `Management API query failed (HTTP ${res.status}): ${res.json?.message ?? 'unknown error'}`,
    );
  console.log('Done. Check with: npm run hosted:verify');
  process.exit(0);
}
const tmp = privateTempFile('vault.sql', sql(false));
try {
  const res = supabase(['db', 'query', '-f', tmp.path, `--remote=${dbRemote(env, ref)}`, '--yes'], {
    env,
    capture: true,
  });
  if (res.status !== 0) {
    // Never echo the CLI output wholesale: it could include the SQL.
    die(`supabase db query failed: ${cliError(res).replace(/'[^']{16,}'/g, "'***'")}`);
  }
} finally {
  tmp.cleanup();
}
console.log('Done. Check with: npm run hosted:verify');
