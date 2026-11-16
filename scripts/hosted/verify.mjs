#!/usr/bin/env node
// Preflight / smoke test for the hosted project. Prints a PASS/FAIL list and exits 1 on any failure.
// Read-only: it never changes the project and never prints a secret value.
//
//   npm run hosted:verify
//   npm run hosted:verify -- --skip-db        skip the SQL checks (no DB password / token)
//   npm run hosted:verify -- --skip-stripe    skip the Stripe webhook checks
//
// Uses SUPABASE_ACCESS_TOKEN (Management API) when set, otherwise the logged-in Supabase CLI.
import { createHash } from 'node:crypto';
import {
  cliError,
  createReport,
  dbRemote,
  deployPlan,
  loadHostedEnv,
  managementApi,
  migrationFacts,
  parseArgs,
  parseCliJson,
  queryRows,
  requireRef,
  sqlLiteral,
  supabase,
} from './lib.mjs';
import {
  FUNCTION_SECRETS,
  LOCAL_ONLY_ENV,
  STRIPE_WEBHOOK_EVENTS,
  functionsBase,
  trimSlash,
} from './manifest.mjs';

const { flags } = parseArgs();
const { env } = loadHostedEnv(flags);
const ref = requireRef(env, flags);
const token = env.SUPABASE_ACCESS_TOKEN;
// --db-url points the SQL checks at another Postgres (used to test this script locally).
const testDb = typeof flags['db-url'] === 'string' ? flags['db-url'] : null;
const dbTarget = testDb ?? dbRemote(env, ref);
const projectUrl = `https://${ref}.supabase.co`;
const report = createReport(`Hosted preflight for ${ref}`);

// ---------- helpers -------------------------------------------------------------------------------

async function sql(query) {
  if (token && !testDb) {
    const res = await managementApi(token, `/projects/${ref}/database/query`, {
      method: 'POST',
      body: { query },
    });
    if (!res.ok) throw new Error(res.json?.message ?? `HTTP ${res.status}`);
    return queryRows(res.json);
  }
  const res = supabase(
    ['db', 'query', query, `--remote=${dbTarget}`, '--read-only', '--output-format', 'json'],
    {
      env,
      capture: true,
    },
  );
  if (res.status !== 0) throw new Error(cliError(res));
  return queryRows(parseCliJson(res.stdout));
}

async function list(apiPath, cliArgs) {
  if (token) {
    const res = await managementApi(token, apiPath);
    if (!res.ok) throw new Error(res.json?.message ?? `HTTP ${res.status}`);
    return Array.isArray(res.json) ? res.json : [];
  }
  const res = supabase([...cliArgs, `--remote=${ref}`, '--output-format', 'json'], {
    env,
    capture: true,
  });
  if (res.status !== 0) throw new Error(cliError(res));
  const parsed = parseCliJson(res.stdout);
  return Array.isArray(parsed) ? parsed : queryRows(parsed);
}

const pick = (obj, ...keys) => {
  for (const k of keys) if (obj?.[k] !== undefined) return obj[k];
  return undefined;
};
const sha256 = (v) => createHash('sha256').update(v, 'utf8').digest('hex');

// ---------- 1. repo -------------------------------------------------------------------------------

report.section('Repo');
const plan = deployPlan();
if (plan.problems.length) for (const p of plan.problems) report.fail('config.toml', p);
else report.pass('Function list', `${plan.functions.length} functions in supabase/config.toml`);
const facts = migrationFacts();

// ---------- 2. database ---------------------------------------------------------------------------

let notifierSecretDigest = env.NOTIFIER_SECRET ? sha256(env.NOTIFIER_SECRET) : null;
let secretNames = null;
let secretDigests = new Map();

report.section('Function secrets (names only)');
try {
  const rows = await list(`/projects/${ref}/secrets`, ['secrets', 'list']);
  secretNames = new Set(rows.map((r) => pick(r, 'name', 'Name')).filter(Boolean));
  for (const r of rows) {
    const digest = pick(r, 'value', 'Value', 'digest', 'Digest');
    if (typeof digest === 'string' && /^[a-f0-9]{64}$/i.test(digest))
      secretDigests.set(pick(r, 'name', 'Name'), digest.toLowerCase());
  }
  for (const s of FUNCTION_SECRETS) {
    const has = secretNames.has(s.name);
    if (has) report.pass(s.name, 'set');
    else if (s.derive && s.need !== 'required')
      report.skip(s.name, 'not set; the function uses its default');
    else if (s.need === 'required') report.fail(s.name, `missing — ${s.about}`);
    else if (s.need === 'recommended') report.warn(s.name, `missing — ${s.about}`);
    else report.skip(s.name, 'not set (optional)');
  }
  const email =
    ['EMAIL_FROM', 'PUBLIC_APP_URL'].every((k) => secretNames.has(k)) &&
    (secretNames.has('RESEND_API_KEY') || secretNames.has('SMTP_HOST'));
  if (email) report.pass('Client email', 'sender, app URL and provider set');
  else
    report.warn('Client email', 'incomplete: client emails stay queued (npm run hosted:secrets)');
  const stripe = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'].filter((k) =>
    secretNames.has(k),
  ).length;
  if (stripe === 1)
    report.fail('Stripe', 'set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET together');
  for (const k of LOCAL_ONLY_ENV)
    if (secretNames.has(k)) report.fail(k, 'local-only; unset it: npx supabase secrets unset ' + k);
  if (!notifierSecretDigest && secretDigests.has('NOTIFIER_SECRET'))
    notifierSecretDigest = secretDigests.get('NOTIFIER_SECRET');
  else if (notifierSecretDigest && secretDigests.has('NOTIFIER_SECRET')) {
    if (secretDigests.get('NOTIFIER_SECRET') === notifierSecretDigest)
      report.pass('NOTIFIER_SECRET', 'matches .env.hosted');
    else
      report.warn(
        'NOTIFIER_SECRET',
        'digest differs from .env.hosted: re-run npm run hosted:secrets if you changed it',
      );
  }
} catch (e) {
  report.fail(
    'Function secrets',
    `could not list (${e.message}). Set SUPABASE_ACCESS_TOKEN or run npx supabase login.`,
  );
}

if (flags['skip-db']) {
  report.section('Database');
  report.skip('Database checks', '--skip-db');
} else {
  report.section('Database');
  const check = async (label, query, fn) => {
    try {
      fn(await sql(query));
    } catch (e) {
      report.fail(label, `query failed: ${e.message}`);
    }
  };

  await check('Extensions', 'select extname from pg_extension', (rows) => {
    const have = new Set(rows.map((r) => r.extname));
    const missing = facts.extensions.filter((x) => !have.has(x));
    if (missing.length)
      report.fail(
        'Extensions',
        `missing ${missing.join(', ')} (npm run hosted:deploy runs the migrations)`,
      );
    else report.pass('Extensions', facts.extensions.join(', '));
  });

  await check('Migrations', 'select version from supabase_migrations.schema_migrations', (rows) => {
    const have = new Set(rows.map((r) => String(r.version)));
    const pending = facts.versions.filter((v) => !have.has(v));
    const extra = [...have].filter((v) => !facts.versions.includes(v));
    if (pending.length)
      report.fail(
        'Migrations',
        `${pending.length} not applied (first ${pending[0]}): npm run hosted:deploy`,
      );
    else report.pass('Migrations', `all ${facts.versions.length} applied`);
    if (extra.length)
      report.warn(
        'Migrations',
        `${extra.length} applied remotely but not in this checkout (${extra[0]}…)`,
      );
  });

  await check(
    'Cron jobs',
    `select j.jobname, j.schedule, j.active,
            (select count(*) from cron.job_run_details d
              where d.jobid = j.jobid and d.status = 'failed' and d.start_time > now() - interval '1 hour') as failed_1h,
            (select max(d.start_time) from cron.job_run_details d where d.jobid = j.jobid) as last_run
       from cron.job j`,
    (rows) => {
      const byName = new Map(rows.map((r) => [r.jobname, r]));
      for (const [name, { schedule }] of facts.cron) {
        const job = byName.get(name);
        if (!job) report.fail(`cron ${name}`, 'not scheduled (migrations not applied?)');
        else if (!job.active) report.fail(`cron ${name}`, 'inactive');
        else if (schedule && job.schedule !== schedule)
          report.warn(`cron ${name}`, `schedule ${job.schedule}, expected ${schedule}`);
        else if (Number(job.failed_1h) > 0)
          report.warn(
            `cron ${name}`,
            `${job.failed_1h} failed runs in the last hour (see cron.job_run_details)`,
          );
        else report.pass(`cron ${name}`, `${job.schedule}${job.last_run ? '' : ', not run yet'}`);
      }
      for (const name of byName.keys())
        if (!facts.cron.has(name))
          report.info(`cron ${name}`, 'extra job, not from the migrations');
    },
  );

  const secretCheck = notifierSecretDigest
    ? `, (select encode(sha256(convert_to(decrypted_secret, 'utf8')), 'hex') = ${sqlLiteral(notifierSecretDigest)}
           from vault.decrypted_secrets where name = 'notifier_secret') as secret_matches`
    : '';
  await check(
    'Vault',
    `select (select coalesce(json_agg(name), '[]'::json) from vault.secrets) as names,
            (select decrypted_secret from vault.decrypted_secrets where name = 'notifier_url') as notifier_url${secretCheck}`,
    ([row]) => {
      const names = new Set(
        typeof row.names === 'string' ? JSON.parse(row.names) : (row.names ?? []),
      );
      for (const n of ['notifier_url', 'notifier_secret']) {
        if (names.has(n)) report.pass(`Vault ${n}`, 'present');
        else report.fail(`Vault ${n}`, 'missing: npm run hosted:vault -- --apply');
      }
      const expected = `${functionsBase(ref)}/notifier`;
      if (row.notifier_url && trimSlash(row.notifier_url) !== expected) {
        report.fail('Vault notifier_url', `points elsewhere; expected ${expected}`);
      }
      if (secretCheck) {
        if (row.secret_matches === true || row.secret_matches === 't')
          report.pass('Vault notifier_secret', 'matches NOTIFIER_SECRET');
        else if (names.has('notifier_secret'))
          report.fail(
            'Vault notifier_secret',
            'differs from NOTIFIER_SECRET: npm run hosted:vault -- --apply',
          );
      } else {
        report.skip('Vault notifier_secret value', 'no NOTIFIER_SECRET in .env.hosted to compare');
      }
      for (const n of ['waitlist_url', 'marketing_url']) {
        if (names.has(n))
          report.warn(`Vault ${n}`, 'set explicitly; normally derived from notifier_url');
      }
    },
  );

  await check('Storage buckets', 'select id, public from storage.buckets', (rows) => {
    const have = new Map(rows.map((r) => [r.id, r.public]));
    for (const b of facts.buckets) {
      if (!have.has(b)) report.fail(`bucket ${b}`, 'missing');
      else if (have.get(b) === true || have.get(b) === 't')
        report.fail(`bucket ${b}`, 'is public; must be private');
      else report.pass(`bucket ${b}`, 'private');
    }
  });
}

// ---------- 3. functions --------------------------------------------------------------------------

report.section('Edge Functions');
let deployed = null;
try {
  const rows = await list(`/projects/${ref}/functions`, ['functions', 'list']);
  deployed = new Map(rows.map((r) => [pick(r, 'slug', 'Slug', 'name', 'Name'), r]));
} catch (e) {
  report.fail('Function list', `could not list (${e.message})`);
}

let anonKey = env.EXPO_PUBLIC_SUPABASE_ANON_KEY || '';
if (!anonKey) {
  try {
    const keys = await list(`/projects/${ref}/api-keys`, ['projects', 'api-keys']);
    const k =
      keys.find((x) => pick(x, 'name', 'Name') === 'anon') ??
      keys.find((x) => String(pick(x, 'type', 'Type') ?? '').includes('publishable'));
    anonKey = pick(k, 'api_key', 'apiKey', 'ApiKey', 'key') ?? '';
  } catch {
    // probes below still run without an apikey (and report it)
  }
}

for (const fn of plan.functions) {
  const label = `${fn.name}`;
  const info = deployed?.get(fn.name);
  if (deployed && !info) {
    report.fail(label, 'not deployed: npm run hosted:deploy');
    continue;
  }
  const problems = [];
  const status = pick(info, 'status', 'Status');
  if (info && status && status !== 'ACTIVE') problems.push(`status ${status}`);
  const vj = pick(info, 'verify_jwt', 'verifyJwt', 'VerifyJwt');
  if (info && typeof vj === 'boolean' && vj !== fn.verifyJwt) {
    problems.push(
      `verify_jwt is ${vj}, config.toml says ${fn.verifyJwt}: npm run hosted:deploy -- --skip-db --only ${fn.name}`,
    );
  }
  let probe = '';
  try {
    const res = await fetch(`${projectUrl}/functions/v1/${fn.name}`, {
      method: 'OPTIONS',
      headers: anonKey ? { apikey: anonKey, Authorization: `Bearer ${anonKey}` } : {},
      signal: AbortSignal.timeout(20000),
    });
    const body = res.status >= 400 ? await res.text().catch(() => '') : '';
    if (res.status === 404) problems.push('HTTP 404 (not deployed?)');
    else if (res.status >= 500)
      problems.push(
        `HTTP ${res.status}${/BOOT_ERROR/.test(body) ? ' BOOT_ERROR (see function logs)' : ''}`,
      );
    else probe = `HTTP ${res.status}`;
  } catch (e) {
    problems.push(`unreachable (${e.name === 'TimeoutError' ? 'timeout' : e.message})`);
  }
  if (problems.length) report.fail(label, problems.join('; '));
  else
    report.pass(
      label,
      [status ?? 'deployed', `verify_jwt=${fn.verifyJwt}`, probe].filter(Boolean).join(', '),
    );
}
if (deployed) {
  for (const name of deployed.keys()) {
    if (!plan.functions.some((f) => f.name === name))
      report.warn(name, 'deployed but not in this repo');
  }
}

// ---------- 4. auth -------------------------------------------------------------------------------

report.section('Auth');
if (anonKey) {
  try {
    const res = await fetch(`${projectUrl}/auth/v1/settings`, {
      headers: { apikey: anonKey },
      signal: AbortSignal.timeout(20000),
    });
    const s = await res.json();
    if (s?.external?.email) report.pass('Email sign-in', 'enabled');
    else report.fail('Email sign-in', 'disabled (Auth → Providers → Email)');
    if (s?.disable_signup)
      report.warn('Sign-ups', 'disabled: the stylist and booking clients can’t create accounts');
    if (s?.external?.apple) report.pass('Sign in with Apple', 'enabled');
    else
      report.warn(
        'Sign in with Apple',
        'off (needed before App Store review if any other social login is added)',
      );
  } catch (e) {
    report.fail('Auth settings', `GET /auth/v1/settings failed (${e.message})`);
  }
} else {
  report.skip(
    'Auth settings',
    'no anon key (set SUPABASE_ACCESS_TOKEN or EXPO_PUBLIC_SUPABASE_ANON_KEY)',
  );
}

if (token) {
  const res = await managementApi(token, `/projects/${ref}/config/auth`);
  const c = res.json;
  if (!res.ok || !c) report.fail('Auth config', `Management API HTTP ${res.status}`);
  else {
    const site = String(c.site_url ?? '');
    if (!site || /localhost|127\.0\.0\.1/.test(site))
      report.fail('Site URL', `${site || 'empty'}: npm run hosted:auth`);
    else report.pass('Site URL', site);
    const allow = String(c.uri_allow_list ?? '')
      .split(',')
      .map((x) => x.trim());
    const need = [
      'chairside://**',
      ...(env.PUBLIC_APP_URL ? [`${trimSlash(env.PUBLIC_APP_URL)}/**`] : []),
    ];
    const missing = need.filter((u) => !allow.includes(u));
    if (missing.length)
      report.fail('Redirect URLs', `missing ${missing.join(', ')}: npm run hosted:auth`);
    else report.pass('Redirect URLs', need.join(', '));
    if (String(c.mailer_templates_magic_link_content ?? '').includes('{{ .Token }}'))
      report.pass('Magic link template', 'has the 6-digit code');
    else
      report.fail(
        'Magic link template',
        'no {{ .Token }}: the app can’t sign in with a code (npm run hosted:auth)',
      );
    if (Number(c.mailer_otp_length) && Number(c.mailer_otp_length) !== 6)
      report.fail('OTP length', `${c.mailer_otp_length}; the app expects 6`);
    if (c.smtp_host) report.pass('Auth SMTP', String(c.smtp_host));
    else
      report.fail(
        'Auth SMTP',
        'built-in sender only emails your Supabase team; client booking codes won’t arrive (npm run hosted:auth)',
      );
  }
} else {
  report.skip('Auth config (site URL, redirects, template, SMTP)', 'needs SUPABASE_ACCESS_TOKEN');
}

// ---------- 5. stripe -----------------------------------------------------------------------------

report.section('Stripe');
const sk = env.STRIPE_SECRET_KEY;
if (flags['skip-stripe']) report.skip('Stripe', '--skip-stripe');
else if (!sk) report.skip('Stripe webhooks', 'no STRIPE_SECRET_KEY in .env.hosted');
else {
  report.info('Mode', /_live_/.test(sk) ? 'LIVE keys' : 'test keys');
  try {
    const res = await fetch('https://api.stripe.com/v1/webhook_endpoints?limit=100', {
      headers: { Authorization: `Bearer ${sk}` },
      signal: AbortSignal.timeout(20000),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json?.error?.message ?? `HTTP ${res.status}`);
    const target = `${functionsBase(ref)}/stripe-webhook`;
    const ours = (json.data ?? []).filter(
      (e) => trimSlash(e.url) === target && e.status === 'enabled',
    );
    for (const [label, connect] of [
      ['Webhook (your account)', false],
      ['Webhook (connected accounts)', true],
    ]) {
      const ep = ours.find((e) => Boolean(e.connect) === connect);
      if (!ep) {
        report.fail(label, `no enabled endpoint → ${target}`);
        continue;
      }
      const events = new Set(ep.enabled_events ?? []);
      const missing = events.has('*') ? [] : STRIPE_WEBHOOK_EVENTS.filter((e) => !events.has(e));
      if (missing.length) report.fail(label, `missing events: ${missing.join(', ')}`);
      else report.pass(label, `${events.has('*') ? 'all' : events.size} events`);
    }
    if (secretNames?.has('STRIPE_WEBHOOK_SECRET') === false)
      report.fail('STRIPE_WEBHOOK_SECRET', 'not set on the project');
  } catch (e) {
    report.fail('Stripe webhooks', `could not list (${e.message})`);
  }
}

process.exit(report.finish());
