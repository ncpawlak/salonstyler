/**
 * End-to-end check of Ask Chairside against a running local stack and served functions:
 * sign in (OTP via Mailpit) -> create a salon with hours, a service and a client -> talk to the
 * `ai-assistant` Edge Function -> hold a draft -> confirm it.
 *
 *   npx supabase start
 *   npx supabase functions serve --env-file <file with CHAIRSIDE_AI_DEMO=1>   # demo provider
 *   SUPABASE_ANON_KEY=<ANON_KEY> npm run smoke:assistant -w @chairside/ai
 *
 * Without the demo flag (and no saved key) only the "not configured" path is checked.
 * Local defaults: URL http://127.0.0.1:54321, Mailpit http://127.0.0.1:54324.
 */
import {
  addClient,
  createChairsideClient,
  createSalon,
  saveService,
  saveWorkHoursTemplate,
  type ChairsideClient,
} from '@chairside/db';

import type { AssistantCard, DraftCard, SlotsCard } from '../src/assistant/types.ts';

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
const owner = await signIn(`assistant-${run}@chairside.test`);
const salon = await createSalon(owner, {
  name: `Studio K ${run}`,
  slug: `studio-k-${run}`,
  timezone: 'America/Chicago',
});
await saveWorkHoursTemplate(
  owner,
  salon.id,
  [2, 3, 4, 5, 6].map((weekday) => ({
    weekday,
    blocks: [{ start: '09:00', end: '17:00', type: 'open' }],
    breaks: [{ start: '12:00', end: '12:30' }],
  })),
);
await saveService(owner, salon.id, {
  name: 'All-over Color',
  category: 'Color',
  priceCents: 12000,
  colorTag: 'purple',
  segments: [
    { kind: 'busy', minutes: 45, label: 'Apply' },
    { kind: 'processing', minutes: 45, label: 'Process' },
    { kind: 'style', minutes: 30, label: 'Blow-dry' },
  ],
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
  consultationRequired: false,
  bookableOnline: true,
  newClientsOnly: false,
  variants: [],
});
await addClient(owner, salon.id, { name: 'Karina Lopez' });
console.log(`seeded salon ${salon.id}`);

const { data: session } = await owner.auth.getSession();
async function call<T>(body: Record<string, unknown>): Promise<{ status: number; body: T }> {
  const res = await fetch(`${url}/functions/v1/ai-assistant`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: anonKey,
      authorization: `Bearer ${session.session!.access_token}`,
    },
    body: JSON.stringify({ salonId: salon.id, ...body }),
  });
  return { status: res.status, body: (await res.json()) as T };
}

const outsider = createChairsideClient(url, anonKey, { auth: { persistSession: false } });
const anon = await fetch(`${url}/functions/v1/ai-assistant`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', apikey: anonKey },
  body: JSON.stringify({ action: 'status', salonId: salon.id }),
});
assert(anon.status === 401, 'rejects requests without a user JWT');
void outsider;

const status = await call<{ configured: boolean; demo: boolean }>({ action: 'status' });
assert(status.status === 200, 'status responds');

if (!status.body.demo) {
  assert(!status.body.configured, 'a new salon is not configured');
  const msg = await call<{ error: { code: string } }>({
    action: 'message',
    text: 'schedule karina for december 18th',
  });
  assert(
    msg.status === 409 && msg.body.error.code === 'not_configured',
    'message without a key -> 409 not_configured',
  );
  console.log('demo flag off: skipping the booking flow');
  process.exit(0);
}

type Turn = { reply: string; cards: AssistantCard[]; messages: unknown[] };
let history: unknown[] = [];
async function say(text: string): Promise<Turn> {
  const res = await call<Turn>({ action: 'message', history, text });
  assert(res.status === 200, `"${text}" -> ${res.body.reply}`);
  history = [...history, ...res.body.messages];
  return res.body;
}

await say('schedule karina for december 18th');
const picked = await say('color');
const slots = picked.cards.find((c): c is SlotsCard => c.type === 'slots');
assert(slots, 'returns a slots card');
assert(slots.client?.name === 'Karina Lopez', 'slots are for Karina');
const dec18 = slots.days.find((d) => d.date.endsWith('-12-18'));
assert(dec18 && dec18.slots.length > 0, `Dec 18 has slots (${dec18?.slots.map((s) => s.time)})`);
assert(
  slots.days.some((d) => d.dayOffset !== 0 && d.slots.length > 0),
  `surrounding days too (${slots.days.map((d) => d.label).join(', ')})`,
);

const proposed = await call<{ card: DraftCard }>({
  action: 'propose',
  clientId: slots.client.id,
  start: dec18.slots[0]!.start,
  services: slots.items,
});
assert(proposed.status === 200 && proposed.body.card.status === 'held', 'slot tap holds a draft');

const confirmed = await call<{ card: DraftCard }>({
  action: 'confirm',
  appointmentId: proposed.body.card.appointmentId,
});
assert(confirmed.body.card?.status === 'confirmed', 'Confirm books it');

const { data: appt } = await owner
  .from('appointments')
  .select('status, client_id')
  .eq('id', proposed.body.card.appointmentId)
  .single();
assert(appt?.status === 'confirmed', 'appointment is confirmed in the database');

const again = await call<{ error: { code: string } }>({
  action: 'confirm',
  appointmentId: proposed.body.card.appointmentId,
});
assert(again.status === 409, 'confirming twice is refused');
