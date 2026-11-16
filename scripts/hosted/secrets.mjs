#!/usr/bin/env node
// Sets the Edge Function secrets from .env.hosted (gitignored; template: .env.hosted.example).
// Validates them first and prints names only, never values.
//
//   npm run hosted:secrets -- --dry-run          validate and show what would be set
//   npm run hosted:secrets                       set them on the project (supabase secrets set)
//   npm run hosted:secrets -- --env-file <path>  use another file (e.g. .env.hosted.live)
import {
  createReport,
  die,
  loadHostedEnv,
  parseArgs,
  privateTempFile,
  requireRef,
  supabase,
} from './lib.mjs';
import {
  FUNCTION_SECRETS,
  LOCAL_ONLY_ENV,
  PLATFORM_ENV,
  TOOLING_ENV,
  trimSlash,
} from './manifest.mjs';

const { flags } = parseArgs();
const dryRun = Boolean(flags['dry-run']);
const { file, exists, env } = loadHostedEnv(flags);
if (!exists) {
  die(`${file} not found. Copy .env.hosted.example to .env.hosted and fill it in.`);
}
const ref = requireRef(env, flags);

const report = createReport(`Function secrets for ${ref}${dryRun ? ' (dry run)' : ''}`);
const values = {};
const PLACEHOLDER = /yourdomain\.com|<ref>|\.\.\.$/i;

for (const secret of FUNCTION_SECRETS) {
  let value = (env[secret.name] ?? '').trim();
  let how = 'from file';
  if (value && PLACEHOLDER.test(value)) {
    report.fail(secret.name, 'still the placeholder from .env.hosted.example');
    continue;
  }
  if (!value && secret.derive) {
    value = secret.derive(env, ref);
    how = 'derived default';
  }
  if (!value) {
    const msg = `empty, not set (${secret.need}) — ${secret.about}`;
    if (secret.need === 'required') report.fail(secret.name, msg);
    else if (secret.need === 'recommended') report.warn(secret.name, msg);
    else report.skip(secret.name, msg);
    continue;
  }
  if (/_URL$/.test(secret.name)) value = trimSlash(value);
  values[secret.name] = value;
  report.pass(secret.name, how);
}

report.section('Checks');
const isHttps = (v) => /^https:\/\/[^\s/]+/.test(v);
for (const name of [
  'PUBLIC_APP_URL',
  'PAYMENTS_RETURN_URL',
  'PUBLIC_WEB_URL',
  'PUBLIC_FUNCTIONS_URL',
]) {
  if (values[name] && !isHttps(values[name])) report.fail(name, 'must be an https:// URL');
}
if (values.NOTIFIER_SECRET && values.NOTIFIER_SECRET.length < 24) {
  report.fail('NOTIFIER_SECRET', 'use at least 24 random characters');
}
const emailBits = ['EMAIL_FROM', 'PUBLIC_APP_URL'].filter((k) => values[k]);
const provider = values.RESEND_API_KEY ? 'resend' : values.SMTP_HOST ? 'smtp' : null;
if (emailBits.length === 2 && provider) {
  report.pass('Client email', `configured via ${provider}`);
} else if (emailBits.length || provider) {
  report.fail(
    'Client email',
    'needs EMAIL_FROM, PUBLIC_APP_URL and RESEND_API_KEY (or SMTP_HOST…) together',
  );
} else {
  report.warn('Client email', 'off: confirmations, reminders, offers and campaigns stay queued');
}
if (values.RESEND_API_KEY && !values.RESEND_API_KEY.startsWith('re_')) {
  report.warn('RESEND_API_KEY', "doesn't look like a Resend key (re_…)");
}
const sk = values.STRIPE_SECRET_KEY;
const wh = values.STRIPE_WEBHOOK_SECRET;
if (sk || wh) {
  if (sk && !/^(sk|rk)_(test|live)_/.test(sk))
    report.fail('STRIPE_SECRET_KEY', 'expected sk_test_… / sk_live_… (or rk_…)');
  if (!sk || !wh) report.fail('Stripe', 'set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET together');
  if (wh) {
    const parts = wh.split(',').map((s) => s.trim());
    if (parts.some((p) => !p.startsWith('whsec_')))
      report.fail('STRIPE_WEBHOOK_SECRET', 'each part must start with whsec_');
    else if (parts.length < 2)
      report.warn(
        'STRIPE_WEBHOOK_SECRET',
        'one secret: register both destinations (your account + connected accounts) and list both',
      );
    else report.pass('STRIPE_WEBHOOK_SECRET', `${parts.length} signing secrets`);
  }
  if (sk) report.info('Stripe mode', /_live_/.test(sk) ? 'LIVE keys' : 'test keys');
} else {
  report.warn(
    'Stripe',
    'off: card payments, deposits and onboarding return 503 stripe_not_configured',
  );
}

const knownKeys = new Set([...FUNCTION_SECRETS.map((s) => s.name), ...TOOLING_ENV]);
for (const key of Object.keys(env)) {
  if (knownKeys.has(key) || !env[key]) continue;
  if (LOCAL_ONLY_ENV.includes(key)) report.warn(key, 'local-only; not sent to the hosted project');
  else if (PLATFORM_ENV.includes(key) || key.startsWith('SUPABASE_'))
    report.warn(key, 'provided by the platform; ignored');
  else report.warn(key, 'unknown key (not in scripts/hosted/manifest.mjs); ignored');
}

const code = report.finish();
if (code) die('Fix the failures above (in .env.hosted), then run again.');
if (dryRun) {
  console.log(
    `\nDry run: would set ${Object.keys(values).length} secrets: ${Object.keys(values).join(', ')}`,
  );
  process.exit(0);
}

const quote = (v) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
const tmp = privateTempFile(
  'secrets.env',
  Object.entries(values)
    .map(([k, v]) => `${k}=${quote(v)}`)
    .join('\n') + '\n',
);
try {
  console.log(`\nSetting ${Object.keys(values).length} secrets on ${ref}…`);
  const res = supabase(['secrets', 'set', '--env-file', tmp.path, `--remote=${ref}`], { env });
  if (res.status !== 0) die('supabase secrets set failed (see above).');
} finally {
  tmp.cleanup();
}
console.log('Done. Check with: npm run hosted:verify');
