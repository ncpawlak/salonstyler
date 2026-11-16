#!/usr/bin/env node
// Applies the Auth settings the app needs to the hosted project through the Management API
// (needs SUPABASE_ACCESS_TOKEN): site URL + redirect allow-list, the 6-digit sign-in code email,
// custom SMTP (so client booking codes reach people outside your Supabase team) and, with --apple,
// the Sign in with Apple client IDs. Only keys the API returns are changed; everything else is kept.
//
//   npm run hosted:auth -- --dry-run   show the changes (SMTP password masked)
//   npm run hosted:auth                apply them
//   npm run hosted:auth -- --apple     also enable Apple with the app's bundle IDs
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createReport,
  die,
  loadHostedEnv,
  managementApi,
  parseArgs,
  requireRef,
  ROOT,
} from './lib.mjs';
import { trimSlash } from './manifest.mjs';

const { flags } = parseArgs();
const dryRun = Boolean(flags['dry-run']);
const { env } = loadHostedEnv(flags);
const ref = requireRef(env, flags);
const token = env.SUPABASE_ACCESS_TOKEN;
if (!token)
  die(
    'hosted:auth needs SUPABASE_ACCESS_TOKEN (supabase.com/dashboard/account/tokens) in .env.hosted.',
  );
if (!env.PUBLIC_APP_URL) die('Set PUBLIC_APP_URL in .env.hosted (the hosted web app origin).');

const appUrl = trimSlash(env.PUBLIC_APP_URL);
const configToml = readFileSync(join(ROOT, 'supabase', 'config.toml'), 'utf8');
const subject = /\[auth\.email\.template\.magic_link\][\s\S]*?subject\s*=\s*"([^"]+)"/.exec(
  configToml,
)?.[1];
const template = readFileSync(join(ROOT, 'supabase', 'templates', 'magic_link.html'), 'utf8');
if (!template.includes('{{ .Token }}'))
  die('supabase/templates/magic_link.html must contain {{ .Token }}.');

const current = await managementApi(token, `/projects/${ref}/config/auth`);
if (!current.ok || !current.json)
  die(`GET auth config failed (HTTP ${current.status}). Check the token and ref.`);
const cfg = current.json;

const desired = {};
desired.site_url = appUrl;
const allow = new Set(
  String(cfg.uri_allow_list ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);
for (const url of ['chairside://**', `${appUrl}/**`]) allow.add(url);
desired.uri_allow_list = [...allow].join(',');
if (subject) desired.mailer_subjects_magic_link = subject;
desired.mailer_templates_magic_link_content = template;
desired.mailer_otp_length = 6;
desired.mailer_otp_exp = 3600;

const from = /^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/.exec(env.EMAIL_FROM ?? '') ?? [
  null,
  '',
  env.EMAIL_FROM,
];
const senderName = (from[1] || 'Chairside').trim();
const adminEmail = (from[2] || '').trim();
if (env.RESEND_API_KEY || env.SMTP_HOST) {
  if (!adminEmail)
    die('Set EMAIL_FROM (e.g. "Studio K <hello@yourdomain.com>") for the Auth SMTP sender.');
  Object.assign(
    desired,
    env.RESEND_API_KEY
      ? {
          smtp_host: 'smtp.resend.com',
          smtp_port: '465',
          smtp_user: 'resend',
          smtp_pass: env.RESEND_API_KEY,
        }
      : {
          smtp_host: env.SMTP_HOST,
          smtp_port: String(env.SMTP_PORT || '587'),
          smtp_user: env.SMTP_USER ?? '',
          smtp_pass: env.SMTP_PASS ?? '',
        },
    { smtp_admin_email: adminEmail, smtp_sender_name: senderName },
  );
}

if (flags.apple) {
  const appJson = JSON.parse(readFileSync(join(ROOT, 'apps', 'mobile', 'app.json'), 'utf8'));
  const base = appJson.expo?.ios?.bundleIdentifier ?? 'com.chairside.app';
  const ids = new Set(
    String(cfg.external_apple_client_id ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  for (const id of [base, `${base}.preview`, `${base}.dev`]) ids.add(id);
  desired.external_apple_enabled = true;
  desired.external_apple_client_id = [...ids].join(',');
}

const SECRET_KEYS = new Set(['smtp_pass']);
const patch = {};
const report = createReport(`Auth settings for ${ref}${dryRun ? ' (dry run)' : ''}`);
for (const [key, value] of Object.entries(desired)) {
  if (!(key in cfg)) {
    report.warn(key, 'not in this project’s auth config API; set it in the dashboard');
    continue;
  }
  const same = SECRET_KEYS.has(key) ? false : String(cfg[key] ?? '') === String(value);
  const shown = SECRET_KEYS.has(key)
    ? '(secret)'
    : key === 'mailer_templates_magic_link_content'
      ? 'supabase/templates/magic_link.html'
      : String(value);
  if (same) report.pass(key, 'already set');
  else {
    patch[key] = value;
    report.info(key, `→ ${shown}`);
  }
}
if (!desired.smtp_host) {
  report.warn(
    'SMTP',
    'no RESEND_API_KEY/SMTP_HOST: the built-in sender only emails your Supabase team, so client booking codes won’t arrive',
  );
}
if (!flags.apple)
  report.skip('Apple', 'pass --apple to enable Sign in with Apple with the app’s bundle IDs');

report.finish();
if (!Object.keys(patch).length) {
  console.log('\nNothing to change.');
  process.exit(0);
}
if (dryRun) {
  console.log(`\nDry run: would update ${Object.keys(patch).join(', ')}.`);
  process.exit(0);
}
const res = await managementApi(token, `/projects/${ref}/config/auth`, {
  method: 'PATCH',
  body: patch,
});
if (!res.ok)
  die(`PATCH auth config failed (HTTP ${res.status}): ${res.json?.message ?? 'see the dashboard'}`);
console.log(`\nUpdated ${Object.keys(patch).length} auth settings.`);
