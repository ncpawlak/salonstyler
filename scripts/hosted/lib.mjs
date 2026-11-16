// Shared helpers for the hosted go-live scripts (scripts/hosted/*.mjs). Node only, no shell, so the
// same commands work from Windows PowerShell and macOS. Nothing here prints a secret value.
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FUNCTIONS_DIR = join(ROOT, 'supabase', 'functions');
export const MIGRATIONS_DIR = join(ROOT, 'supabase', 'migrations');
export const CONFIG_TOML = join(ROOT, 'supabase', 'config.toml');
export const DEFAULT_ENV_FILE = '.env.hosted';

/** `--flag`, `--key value`, `--key=value`. Everything after a bare `--` is passed through. */
export function parseArgs(argv = process.argv.slice(2)) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith('--')) {
      rest.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq > 0) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else if (
      ['env-file', 'only', 'ref', 'out'].includes(arg.slice(2)) &&
      argv[i + 1] !== undefined &&
      !argv[i + 1].startsWith('--')
    ) {
      flags[arg.slice(2)] = argv[++i];
    } else {
      flags[arg.slice(2)] = true;
    }
  }
  return { flags, rest };
}

/** Minimal .env parser: KEY=VALUE, optional `export `, # comments, single/double quotes. */
export function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2];
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.lastIndexOf(quote) > 0) {
      value = value.slice(1, value.lastIndexOf(quote));
      if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    out[m[1]] = value;
  }
  return out;
}

/** Loads .env.hosted (or --env-file). Tooling keys fall back to the process environment. */
export function loadHostedEnv(flags = {}) {
  const file = resolve(
    ROOT,
    typeof flags['env-file'] === 'string' ? flags['env-file'] : DEFAULT_ENV_FILE,
  );
  const exists = existsSync(file);
  const env = exists ? parseEnv(readFileSync(file, 'utf8')) : {};
  for (const key of [
    'SUPABASE_PROJECT_REF',
    'SUPABASE_ACCESS_TOKEN',
    'SUPABASE_DB_PASSWORD',
    'SUPABASE_DB_URL',
  ]) {
    if (!env[key] && process.env[key]) env[key] = process.env[key];
  }
  return { file, exists, env };
}

/** --ref, then SUPABASE_PROJECT_REF, then the ref `supabase link` stored. */
export function projectRef(env, flags = {}) {
  const linked = join(ROOT, 'supabase', '.temp', 'project-ref');
  const ref =
    (typeof flags.ref === 'string' && flags.ref) ||
    env.SUPABASE_PROJECT_REF ||
    (existsSync(linked) ? readFileSync(linked, 'utf8').trim() : '');
  return ref && /^[a-z0-9]{20}$/.test(ref) ? ref : null;
}

/** [functions.<name>] verify_jwt from supabase/config.toml: the single source of truth for deploys. */
export function functionsConfig() {
  const text = readFileSync(CONFIG_TOML, 'utf8');
  const map = new Map();
  const re = /^\[functions\.([A-Za-z0-9_-]+)\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/gm;
  for (const m of text.matchAll(re)) {
    const jwt = /^\s*verify_jwt\s*=\s*(true|false)\s*$/m.exec(m[2]);
    map.set(m[1], { verifyJwt: jwt ? jwt[1] === 'true' : null });
  }
  return map;
}

/** Function directories (the ones with an index.ts). */
export function functionDirs() {
  return readdirSync(FUNCTIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(FUNCTIONS_DIR, d.name, 'index.ts')))
    .map((d) => d.name)
    .sort();
}

/** Functions to deploy, in config.toml order, plus any mismatch with the directories. */
export function deployPlan() {
  const config = functionsConfig();
  const dirs = functionDirs();
  const problems = [];
  for (const dir of dirs) {
    if (!config.has(dir)) {
      problems.push(
        `supabase/functions/${dir} has no [functions.${dir}] entry in supabase/config.toml`,
      );
    }
  }
  for (const [name, { verifyJwt }] of config) {
    if (!dirs.includes(name)) {
      problems.push(
        `[functions.${name}] in supabase/config.toml has no supabase/functions/${name}/index.ts`,
      );
    } else if (verifyJwt === null) {
      problems.push(`[functions.${name}] must set verify_jwt = true or false explicitly`);
    }
  }
  const functions = [...config]
    .filter(([name]) => dirs.includes(name))
    .map(([name, { verifyJwt }]) => ({ name, verifyJwt: verifyJwt !== false }));
  return { functions, problems };
}

/** Extensions, pg_cron jobs, storage buckets and Vault secret names the migrations expect. */
export function migrationFacts() {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const extensions = new Set();
  const cron = new Map();
  const buckets = new Set();
  const vault = new Set();
  const versions = [];
  for (const file of files) {
    versions.push(file.split('_')[0]);
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    for (const m of sql.matchAll(/create extension if not exists\s+"?([a-z_]+)"?/gi)) {
      extensions.add(m[1]);
    }
    for (const m of sql.matchAll(
      /cron\.(schedule|unschedule)\(\s*'([^']+)'(?:\s*,\s*'([^']+)')?/g,
    )) {
      if (m[1] === 'schedule') cron.set(m[2], { schedule: m[3] ?? null, file });
      else cron.delete(m[2]);
    }
    for (const m of sql.matchAll(/insert into storage\.buckets[\s\S]*?values\s*\(\s*'([^']+)'/gi)) {
      buckets.add(m[1]);
    }
    for (const line of sql.split('\n')) {
      if (!line.includes('decrypted_secrets')) continue;
      for (const m of line.matchAll(/name\s*=\s*'([a-z0-9_]+)'/g)) vault.add(m[1]);
    }
  }
  return {
    extensions: [...extensions].sort(),
    cron,
    buckets: [...buckets].sort(),
    vault,
    versions,
  };
}

function cliEntry() {
  try {
    const require = createRequire(join(ROOT, 'package.json'));
    const pkgPath = require.resolve('supabase/package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.supabase;
    if (bin) return join(dirname(pkgPath), bin);
  } catch {
    // fall back to npx below
  }
  return null;
}

/**
 * Runs the Supabase CLI from node_modules (no shell, so arguments are never re-parsed).
 * `capture` returns stdout/stderr instead of streaming them. SUPABASE_ACCESS_TOKEN and
 * SUPABASE_DB_PASSWORD from .env.hosted go through the environment, never the command line.
 */
export function supabase(args, { env = {}, capture = false } = {}) {
  const childEnv = { ...process.env };
  for (const key of ['SUPABASE_ACCESS_TOKEN', 'SUPABASE_DB_PASSWORD']) {
    if (env[key]) childEnv[key] = env[key];
  }
  const entry = cliEntry();
  const [cmd, cmdArgs, shell] = entry
    ? [process.execPath, [entry, ...args], false]
    : ['npx', ['--yes', 'supabase', ...args], process.platform === 'win32'];
  const res = spawnSync(cmd, cmdArgs, {
    cwd: ROOT,
    env: childEnv,
    shell,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) throw res.error;
  return { status: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/** A one-line error from a failed CLI run (the CLI prints `{"_tag":"Error","error":{...}}`). */
export function cliError(res) {
  const text = `${res.stdout}\n${res.stderr}`;
  for (const line of text.split('\n')) {
    if (!line.includes('"_tag":"Error"')) continue;
    try {
      const { error } = JSON.parse(line.slice(line.indexOf('{')));
      return [error?.message, error?.suggestion].filter(Boolean).join(' ');
    } catch {
      // not JSON after all
    }
  }
  return (
    text
      .split('\n')
      .find((l) => /error|fail/i.test(l))
      ?.trim() ?? 'unknown error'
  );
}

/** Parses JSON a CLI printed, tolerating log lines before it. */
export function parseCliJson(stdout) {
  const text = stdout.trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.search(/[[{]/);
    if (start < 0) throw new Error('no JSON in CLI output');
    return JSON.parse(text.slice(start));
  }
}

/** Rows from `supabase db query -o json`, whichever envelope the CLI version uses. */
export function queryRows(parsed) {
  if (Array.isArray(parsed)) return parsed;
  for (const key of ['rows', 'data', 'result', 'results']) {
    if (Array.isArray(parsed?.[key])) return parsed[key];
  }
  return [];
}

/** Writes a file only the current user can read, in a fresh temp dir. Call cleanup() after use. */
export function privateTempFile(name, contents) {
  const dir = mkdtempSync(join(tmpdir(), 'chairside-hosted-'));
  const path = join(dir, name);
  writeFileSync(path, contents, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows: the temp dir is already per-user.
  }
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export const sqlLiteral = (value) => `'${String(value).replace(/'/g, "''")}'`;

/** Calls the Supabase Management API (needs SUPABASE_ACCESS_TOKEN). */
export async function managementApi(token, path, { method = 'GET', body } = {}) {
  const res = await fetch(`https://api.supabase.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // keep null
  }
  return { ok: res.ok, status: res.status, json };
}

/** Pass / fail / warn / skip list with a summary and exit code. */
export function createReport(title) {
  const rows = [];
  const add = (level, label, detail) => {
    rows.push({ level, label, detail });
    const tag = { pass: 'PASS', fail: 'FAIL', warn: 'WARN', skip: 'SKIP', info: 'INFO' }[level];
    console.log(`  [${tag}] ${label}${detail ? ` — ${detail}` : ''}`);
  };
  console.log(`\n${title}`);
  return {
    section: (name) => console.log(`\n${name}`),
    pass: (l, d) => add('pass', l, d),
    fail: (l, d) => add('fail', l, d),
    warn: (l, d) => add('warn', l, d),
    skip: (l, d) => add('skip', l, d),
    info: (l, d) => add('info', l, d),
    finish() {
      const count = (lvl) => rows.filter((r) => r.level === lvl).length;
      console.log(
        `\n${count('pass')} passed, ${count('fail')} failed, ${count('warn')} warnings, ${count('skip')} skipped.`,
      );
      if (count('fail')) {
        console.log('Failed:');
        for (const r of rows.filter((x) => x.level === 'fail')) console.log(`  - ${r.label}`);
      }
      return count('fail') ? 1 : 0;
    },
  };
}

export function die(message) {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

export function requireRef(env, flags) {
  const ref = projectRef(env, flags);
  if (!ref) {
    die(
      'No project ref. Set SUPABASE_PROJECT_REF in .env.hosted (copy .env.hosted.example), pass --ref <ref>, or run `npx supabase link`.',
    );
  }
  return ref;
}

/**
 * What to pass as `--remote=` for database commands: the session pooler URL (SUPABASE_DB_URL, IPv4)
 * when set, else the project ref (direct connection, which needs IPv6). `[YOUR-PASSWORD]` in the URL
 * is filled from SUPABASE_DB_PASSWORD.
 */
export function dbRemote(env, ref) {
  const url = (env.SUPABASE_DB_URL ?? '').trim();
  if (!url) return ref;
  return url.replace(/\[YOUR-PASSWORD\]/g, () =>
    encodeURIComponent(env.SUPABASE_DB_PASSWORD ?? ''),
  );
}

/** Hides the password in a postgres URL (for printing commands). */
export const maskUrl = (s) => s.replace(/(postgres(?:ql)?:\/\/[^:/@]+:)[^@]*@/g, '$1***@');
