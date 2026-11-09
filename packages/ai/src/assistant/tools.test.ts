import { findSlots, toSalonDate } from '@chairside/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { createFakePort, CUT, COLOR, type FakePort, KARINA, MENU, NOW, TZ } from './fake-salon.ts';
import { resolveItems } from './menu.ts';
import { cancelDraft, confirmDraft, proposeBooking, runTool, type ToolContext } from './tools.ts';
import type { DraftCard, SlotsCard } from './types.ts';

let port: FakePort;
let ctx: ToolContext;

beforeEach(() => {
  port = createFakePort();
  ctx = { port, now: () => NOW };
});

const slotsFor = async (args: Record<string, unknown>) => {
  const out = await runTool(ctx, 'find_slots', args);
  expect(out.ok).toBe(true);
  return out.card as SlotsCard;
};

describe('find_client', () => {
  it('finds Karina by first name with her usual color service', async () => {
    const out = await runTool(ctx, 'find_client', { query: 'karina' });
    expect(out.ok).toBe(true);
    expect(out.card).toBeUndefined();
    const { matches } = out.result as { matches: Record<string, unknown>[] };
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      id: KARINA,
      name: 'Karina Lopez',
      usualServices: [{ serviceId: COLOR, variantId: null }],
      usualSummary: expect.stringContaining('All-over Color'),
    });
  });

  it('tolerates typos', async () => {
    const out = await runTool(ctx, 'find_client', { query: 'Karinna' });
    const { matches } = out.result as { matches: { id: string }[] };
    expect(matches[0]!.id).toBe(KARINA);
  });

  it('returns a quick-create card for unknown names', async () => {
    const out = await runTool(ctx, 'find_client', { query: 'Jessica' });
    expect(out.ok).toBe(true);
    expect(out.card).toEqual({ type: 'client_not_found', query: 'Jessica', suggestions: [] });
  });
});

describe('find_slots', () => {
  it('returns engine slots on the requested day and the surrounding open days', async () => {
    const card = await slotsFor({ clientId: KARINA, date: '2026-12-18' });
    expect(card.client).toEqual({ id: KARINA, name: 'Karina Lopez' });
    expect(card.items).toEqual([{ serviceId: COLOR, variantId: null }]);
    expect(card.requestedDate).toBe('2026-12-18');

    const dates = card.days.map((d) => d.date);
    expect(dates).toContain('2026-12-18');
    // Tue–Thu before and Sat after are open; Sun 20 / Mon 21 are closed.
    expect(dates).toEqual(['2026-12-15', '2026-12-16', '2026-12-17', '2026-12-18', '2026-12-19']);
    const dec18 = card.days.find((d) => d.date === '2026-12-18')!;
    expect(dec18.label).toBe('Fri, Dec 18');
    expect(dec18.slots.length).toBeGreaterThan(0);
    for (const day of card.days) expect(day.slots.length).toBeLessThanOrEqual(3);

    // Every suggestion is exactly an engine candidate (the assistant never invents times).
    const schedule = await port.getSchedule({ from: '2026-12-15', to: '2026-12-21' });
    const engine = findSlots({
      service: resolveItems(MENU, card.items).service,
      hours: schedule.hours,
      requestedDate: '2026-12-18',
      searchRadiusDays: 3,
      existing: port.appointments.map((a) => ({ id: a.id, segments: a.segments })),
      rules: schedule.rules,
      now: NOW,
    });
    const starts = new Set(engine.map((c) => c.start));
    for (const day of card.days) {
      for (const slot of day.slots) {
        expect(starts.has(slot.start)).toBe(true);
        expect(toSalonDate(slot.start, TZ)).toBe(day.date);
      }
    }
    // Dec 18 is mostly booked: color fits only at 12:30 (busy 12:30–1:15, done by Karen at 2:30).
    expect(dec18.slots.map((s) => s.time)).toEqual(['12:30 PM']);
  });

  it('notes when the requested day is closed and still offers nearby days', async () => {
    const out = await runTool(ctx, 'find_slots', {
      clientId: KARINA,
      date: '2026-12-20',
      services: [{ serviceId: CUT }],
    });
    const result = out.result as { requestedNote: string; days: { date: string }[] };
    expect(result.requestedNote).toBe('Closed on Sun, Dec 20.');
    expect(result.days.length).toBeGreaterThan(1);
  });

  it('asks for a service when the client has no history', async () => {
    const created = await port.createClient({ name: 'Jessica Day' });
    const out = await runTool(ctx, 'find_slots', { clientId: created.id, date: '2026-12-18' });
    expect(out.ok).toBe(false);
    expect(out.result).toEqual({ error: expect.objectContaining({ code: 'service_required' }) });
  });

  it('honours a time-of-day preference', async () => {
    const card = await slotsFor({
      clientId: KARINA,
      date: '2026-12-16',
      services: [{ serviceId: CUT }],
      timeOfDay: 'afternoon',
    });
    for (const day of card.days) {
      for (const s of day.slots) expect(s.time).toMatch(/PM$/);
    }
  });

  it('rejects malformed arguments without throwing', async () => {
    const out = await runTool(ctx, 'find_slots', { date: 'December 18' });
    expect(out.ok).toBe(false);
    expect(out.result).toEqual({ error: expect.objectContaining({ code: 'invalid_arguments' }) });
    expect((await runTool(ctx, 'drop_tables', {})).ok).toBe(false);
  });
});

describe('get_day_summary', () => {
  it('lists the day’s appointments in salon time', async () => {
    const out = await runTool(ctx, 'get_day_summary', { date: '2026-12-18' });
    expect(out.result).toMatchObject({
      label: 'Fri, Dec 18',
      status: 'open',
      appointments: [
        expect.objectContaining({ client: 'Maria Garcia', time: '9:00 AM–11:30 AM' }),
        expect.objectContaining({ client: 'Karen Smith', time: '2:30 PM–4:00 PM' }),
      ],
    });
  });
});

describe('running_late', () => {
  it('previews the cascade from the next client without moving anything', async () => {
    const lateCtx = { port, now: () => Date.parse('2026-12-18T14:50:00Z') };
    const out = await runTool(lateCtx, 'running_late', { minutes: 30 });
    expect(out.ok).toBe(true);
    expect(out.card).toMatchObject({
      type: 'running_late',
      delayMinutes: 30,
      moves: [
        expect.objectContaining({
          clientName: 'Maria Garcia',
          from: '2026-12-18T15:00:00.000Z',
          to: '2026-12-18T15:30:00.000Z',
          label: '9:00 AM → 9:30 AM',
        }),
      ],
      overtimeMinutes: 0,
    });
    const after = await port.listAppointments({
      from: '2026-12-18T00:00:00Z',
      to: '2026-12-19T00:00:00Z',
    });
    expect(after.find((a) => a.client?.name === 'Maria Garcia')?.starts_at).toBe(
      '2026-12-18T15:00:00Z',
    );
  });

  it('rejects silly delays', async () => {
    const out = await runTool(ctx, 'running_late', { minutes: 0 });
    expect(out.ok).toBe(false);
  });
});

describe('drafts', () => {
  it('propose_booking holds an engine slot; only the owner confirms', async () => {
    const card = await slotsFor({ clientId: KARINA, date: '2026-12-18' });
    const slot = card.days.find((d) => d.date === '2026-12-18')!.slots[0]!;
    const out = await runTool(ctx, 'propose_booking', { clientId: KARINA, start: slot.start });
    expect(out.ok).toBe(true);
    const draft = out.card as DraftCard;
    expect(draft).toMatchObject({
      type: 'draft',
      status: 'held',
      client: { id: KARINA, name: 'Karina Lopez' },
      label: 'Fri, Dec 18 · 12:30 PM',
    });
    const held = port.appointments.find((a) => a.id === draft.appointmentId)!;
    expect(held.status).toBe('held');
    expect(held.notes).toBe('Drafted by Ask Chairside');

    // The model has no confirm tool.
    expect((await runTool(ctx, 'confirm_draft', { appointmentId: draft.appointmentId })).ok).toBe(
      false,
    );
    const confirmed = await confirmDraft(ctx, draft.appointmentId);
    expect(confirmed.card.status).toBe('confirmed');
    expect(held.status).toBe('confirmed');
    await expect(confirmDraft(ctx, draft.appointmentId)).rejects.toThrow(/not a draft/);
  });

  it('refuses times the engine would not offer', async () => {
    // 10:00 AM Dec 18 collides with Maria.
    const out = await runTool(ctx, 'propose_booking', {
      clientId: KARINA,
      start: '2026-12-18T16:00:00Z',
    });
    expect(out.ok).toBe(false);
    expect(out.result).toEqual({ error: expect.objectContaining({ code: 'slot_unavailable' }) });
    // 6:00 AM is outside hours: the owner may book that by hand, the assistant may not.
    const early = await runTool(ctx, 'propose_booking', {
      clientId: KARINA,
      start: '2026-12-17T12:00:00Z',
      services: [{ serviceId: CUT }],
    });
    expect(early.ok).toBe(false);
    expect(port.appointments.filter((a) => a.status === 'held')).toHaveLength(0);
  });

  it('cancel_draft releases only assistant drafts', async () => {
    const draft = await proposeBooking(ctx, {
      clientId: KARINA,
      start: '2026-12-16T16:00:00Z',
      services: [{ serviceId: CUT }],
    });
    const out = await runTool(ctx, 'cancel_draft', { appointmentId: draft.card.appointmentId });
    expect(out.ok).toBe(true);
    expect((out.card as DraftCard).status).toBe('cancelled');

    const manual = port.appointments[0]!;
    manual.status = 'held';
    const refused = await runTool(ctx, 'cancel_draft', { appointmentId: manual.id });
    expect(refused.ok).toBe(false);
    expect(manual.status).toBe('held');
    await expect(cancelDraft(ctx, manual.id)).rejects.toThrow(/Ask Chairside/);
  });
});

describe('client duration overrides', () => {
  beforeEach(() => {
    // Karina's thick hair: her color takes 20 minutes longer than the menu's 2h.
    port.overrides.set(KARINA, [{ serviceId: COLOR, deltaMinutes: 20 }]);
  });

  it('find_client shows the usual service with her override', async () => {
    const out = await runTool(ctx, 'find_client', { query: 'karina' });
    const { matches } = out.result as { matches: { usualSummary: string }[] };
    expect(matches[0]!.usualSummary).toBe('All-over Color · 2h20 (incl. +20m for this client)');
  });

  it('booking Karina automatically applies her +20m', async () => {
    const card = await slotsFor({ clientId: KARINA, date: '2026-12-16' });
    expect(card.serviceSummary).toContain('2h20');
    const slot = card.days.find((d) => d.date === '2026-12-16')!.slots[0]!;
    const draft = await proposeBooking(ctx, { clientId: KARINA, start: slot.start });
    const held = port.appointments.find((a) => a.id === draft.card.appointmentId)!;
    expect((Date.parse(held.ends_at) - Date.parse(held.starts_at)) / 60_000).toBe(140);
    // Spread over hands-on time: processing stays 45m.
    const processing = held.segments.find((s) => s.kind === 'processing')!;
    expect((Date.parse(processing.end) - Date.parse(processing.start)) / 60_000).toBe(45);
  });

  it('a 2h gap no longer fits her color', async () => {
    // Dec 18 has exactly 12:30–2:30 free; with +20m she doesn't fit.
    const card = await slotsFor({ clientId: KARINA, date: '2026-12-18' });
    expect(card.days.find((d) => d.date === '2026-12-18')!.slots).toEqual([]);
  });

  it('other clients and services are unaffected', () => {
    const cut = resolveItems(MENU, [{ serviceId: CUT }], port.overrides.get(KARINA));
    expect(cut.totalMinutes).toBe(60);
    expect(cut.clientAdjustmentMinutes).toBe(0);
  });
});

describe('add_client_note', () => {
  it('saves a pasted formula to the client and audits it', async () => {
    const out = await runTool(ctx, 'add_client_note', {
      clientId: KARINA,
      kind: 'formula',
      text: '  7N + 7G 1:1, 20 vol, 35 min ',
    });
    expect(out.ok).toBe(true);
    expect(port.notes).toEqual([
      { clientId: KARINA, kind: 'formula', text: '7N + 7G 1:1, 20 vol, 35 min' },
    ]);
    expect(port.audits.at(-1)).toMatchObject({
      action: 'assistant.client_note_added',
      details: { clientId: KARINA, kind: 'formula' },
    });
  });

  it('defaults to a note and rejects unknown clients', async () => {
    await runTool(ctx, 'add_client_note', { clientId: KARINA, text: 'Prefers quiet appts' });
    expect(port.notes[0]!.kind).toBe('note');
    const bad = await runTool(ctx, 'add_client_note', { clientId: 'nope', text: 'x' });
    expect(bad.ok).toBe(false);
    expect(port.notes).toHaveLength(1);
  });
});
