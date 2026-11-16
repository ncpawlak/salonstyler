#!/usr/bin/env node
// Applies migrations and deploys EVERY Edge Function with the right JWT setting. The function list
// and verify_jwt flags come from supabase/config.toml ([functions.*]); a function directory without
// an entry stops the deploy (and fails CI via npm run check:hosted).
//
//   npm run hosted:deploy -- --dry-run            db push --dry-run + print the deploy commands
//   npm run hosted:deploy                         db push, then deploy all functions
//   npm run hosted:deploy -- --skip-db            functions only
//   npm run hosted:deploy -- --skip-functions     migrations only
//   npm run hosted:deploy -- --only ai,notifier   just these functions
//   npm run hosted:deploy -- --use-api            bundle on Supabase's side (no Docker/Podman needed)
import {
  dbRemote,
  deployPlan,
  die,
  loadHostedEnv,
  maskUrl,
  parseArgs,
  requireRef,
  supabase,
} from './lib.mjs';

const { flags } = parseArgs();
const dryRun = Boolean(flags['dry-run']);
const { env } = loadHostedEnv(flags);
const ref = requireRef(env, flags);

const { functions, problems } = deployPlan();
if (problems.length) {
  die(`supabase/config.toml and supabase/functions disagree:\n  - ${problems.join('\n  - ')}`);
}
let targets = functions;
if (typeof flags.only === 'string') {
  const wanted = flags.only
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const unknown = wanted.filter((n) => !functions.some((f) => f.name === n));
  if (unknown.length) die(`Unknown function(s): ${unknown.join(', ')}`);
  targets = functions.filter((f) => wanted.includes(f.name));
}

const confirm = flags.yes ? ['--yes'] : [];
const results = [];

if (!flags['skip-db']) {
  console.log(`\n== Database migrations → ${ref}${dryRun ? ' (dry run)' : ''}`);
  const args = [
    'db',
    'push',
    `--remote=${dbRemote(env, ref)}`,
    ...(dryRun ? ['--dry-run'] : confirm),
  ];
  console.log(`$ supabase ${maskUrl(args.join(' '))}`);
  const res = supabase(args, { env });
  results.push({ step: dryRun ? 'db push --dry-run' : 'db push', ok: res.status === 0 });
  if (res.status !== 0 && !dryRun) {
    die('db push failed; functions were not deployed. Fix the error above and run again.');
  }
}

if (!flags['skip-functions']) {
  console.log(
    `\n== Edge Functions (${targets.length}) → ${ref}${dryRun ? ' (dry run: commands only)' : ''}`,
  );
  for (const fn of targets) {
    const args = [
      'functions',
      'deploy',
      fn.name,
      `--remote=${ref}`,
      ...(fn.verifyJwt ? [] : ['--no-verify-jwt']),
      ...(flags['use-api'] ? ['--use-api'] : []),
      ...confirm,
    ];
    console.log(`$ supabase ${args.join(' ')}`);
    if (dryRun) {
      results.push({ step: `${fn.name} (verify_jwt=${fn.verifyJwt})`, ok: true, planned: true });
      continue;
    }
    const res = supabase(args, { env });
    results.push({ step: `${fn.name} (verify_jwt=${fn.verifyJwt})`, ok: res.status === 0 });
  }
}

console.log('\nSummary');
for (const r of results)
  console.log(`  [${r.planned ? 'PLAN' : r.ok ? 'PASS' : 'FAIL'}] ${r.step}`);
const failed = results.filter((r) => !r.ok);
if (failed.length) die(`${failed.length} step(s) failed.`);
console.log(
  dryRun
    ? '\nDry run only: nothing was deployed.'
    : '\nDone. Next: npm run hosted:vault -- --apply, then npm run hosted:verify',
);
