/**
 * End-to-end check of the first-run flow against a running Supabase stack:
 * magic link -> verify OTP (read from Mailpit) -> create_salon -> listMySalons,
 * plus a second owner to prove cross-salon isolation over the REST API.
 *
 *   npx supabase start
 *   SUPABASE_ANON_KEY=<ANON_KEY from `npx supabase status`> npm run smoke
 *
 * Local defaults: URL http://127.0.0.1:54321, Mailpit http://127.0.0.1:54324.
 */
import { createChairsideClient, type ChairsideClient } from '../src/index.ts';
import { createSalon, isSalonSlugAvailable, listMySalons, toSalonSlug } from '../src/salons.ts';

const url = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
const anonKey = process.env.SUPABASE_ANON_KEY ?? '';
const mailpit = process.env.MAILPIT_URL ?? 'http://127.0.0.1:54324';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log(`ok - ${msg}`);
}

async function latestOtp(email: string): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const res = await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`);
    const { messages } = (await res.json()) as { messages: { ID: string }[] };
    const id = messages[0]?.ID;
    if (id) {
      const msg = (await (await fetch(`${mailpit}/api/v1/message/${id}`)).json()) as {
        Text: string;
      };
      const code = /\b(\d{6})\b/.exec(msg.Text)?.[1];
      if (code) return code;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`No OTP email for ${email}`);
}

async function signIn(email: string): Promise<ChairsideClient> {
  const client = createChairsideClient(url, anonKey, { auth: { persistSession: false } });
  const { error } = await client.auth.signInWithOtp({ email });
  if (error) throw error;
  const { error: verifyError } = await client.auth.verifyOtp({
    email,
    token: await latestOtp(email),
    type: 'email',
  });
  if (verifyError) throw verifyError;
  return client;
}

const run = Date.now().toString(36);

const owner = await signIn(`owner-${run}@chairside.test`);
assert(
  (await listMySalons(owner)).length === 0,
  'new user has no salons (show create-salon screen)',
);

const name = `Karina's Studio ${run}`;
const slug = toSalonSlug(name);
assert(await isSalonSlugAvailable(owner, slug), `slug "${slug}" is available`);
const salon = await createSalon(owner, { name, slug, timezone: 'America/Chicago' });
assert(salon.slug === slug, 'create_salon returns the salon');

const mine = await listMySalons(owner);
assert(mine.length === 1 && mine[0]?.role === 'owner', 'owner lands on home with one owned salon');

const { data: settings } = await owner
  .from('settings')
  .select('*')
  .eq('salon_id', salon.id)
  .single();
assert(settings?.autonomy === 'draft', 'default settings were created');

const other = await signIn(`other-${run}@chairside.test`);
await createSalon(other, { name: 'Other', slug: `other-${run}`, timezone: 'UTC' });
const { data: leaked } = await other.from('salons').select('id').eq('id', salon.id);
assert(leaked?.length === 0, 'second owner cannot read the first salon via REST');

const anon = createChairsideClient(url, anonKey, { auth: { persistSession: false } });
const { error: anonError } = await anon.from('salons').select('id');
assert(anonError !== null, 'anonymous REST access to salons is denied');

console.log('first-run smoke test passed');
