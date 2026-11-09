import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { validateSegments } from '../availability/segments.ts';
import { applyAddons, applyVariant, formatDuration, totalMinutes } from './resolve.ts';
import { STARTER_CATEGORIES, STARTER_MENU } from './starter-menu.ts';
import { SERVICE_COLOR_TAGS } from './types.ts';

const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));

/** The latest migration that defines private.starter_menu(), parsed. */
function migrationStarterMenu(): unknown {
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .reverse();
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS, f), 'utf8');
    if (!sql.includes('function private.starter_menu()')) continue;
    const m = /\$json\$([\s\S]*?)\$json\$/.exec(sql);
    if (!m) throw new Error(`${f}: private.starter_menu() has no $json$ block`);
    return JSON.parse(m[1]!);
  }
  throw new Error('No migration defines private.starter_menu()');
}

describe('STARTER_MENU (Appendix A)', () => {
  it('matches the JSON seeded by the Supabase migration', () => {
    expect(migrationStarterMenu()).toEqual(JSON.parse(JSON.stringify(STARTER_MENU)));
  });

  it('has the Appendix A totals', () => {
    const totals = Object.fromEntries(
      STARTER_MENU.services.map((s) => [s.name, formatDuration(totalMinutes(s.segments))]),
    );
    expect(totals).toEqual({
      "Women's cut & style": '45m',
      "Men's cut": '30m',
      "Kids' cut (≤12)": '20m',
      'Bang/fringe trim': '10m',
      'Beard trim': '15m',
      Blowout: '45m',
      'Updo / special occasion': '1h00',
      'Bridal trial': '1h30',
      'Root touch-up': '1h35',
      'All-over color': '1h45',
      'Toner / gloss': '45m',
      'Partial highlights': '2h15',
      'Full highlights': '2h45',
      Balayage: '2h50',
      'Color correction': '3h00',
      'Deep conditioning': '25m',
      'Keratin / smoothing': '2h30',
      Perm: '1h45',
      Consultation: '15m',
      Extensions: '2h30',
    });
  });

  it('add-ons are Toner +20, Deep conditioning +25, Bond +15, Blowout finish +15', () => {
    expect(STARTER_MENU.addons.map((a) => [a.name, totalMinutes(a.segments), a.placement])).toEqual(
      [
        ['Toner', 20, 'before_finish'],
        ['Deep conditioning', 25, 'before_finish'],
        ['Bond treatment (Olaplex)', 15, 'before_finish'],
        ['Blowout finish', 15, 'end'],
      ],
    );
  });

  it('every service is valid and works with every variant and add-on', () => {
    const names = new Set<string>();
    for (const s of STARTER_MENU.services) {
      expect(names.has(s.name), s.name).toBe(false);
      names.add(s.name);
      expect(STARTER_CATEGORIES).toContain(s.category);
      expect(SERVICE_COLOR_TAGS).toContain(s.colorTag);
      validateSegments(s.segments);
      for (const v of s.variants) applyVariant(s.segments, v.deltaMinutes);
      if (s.segments[s.segments.length - 1]!.kind === 'style')
        expect(() => applyAddons(s.segments, STARTER_MENU.addons)).not.toThrow();
    }
  });

  it('consult-first services are flagged and not bookable online', () => {
    const consult = STARTER_MENU.services.filter((s) => s.consultationRequired).map((s) => s.name);
    expect(consult).toEqual(['Color correction', 'Extensions']);
    for (const s of STARTER_MENU.services) expect(s.bookableOnline).toBe(!s.consultationRequired);
  });

  it('combos reference starter services', () => {
    const names = new Set(STARTER_MENU.services.map((s) => s.name));
    for (const c of STARTER_MENU.combos)
      for (const i of c.items) expect(names.has(i.service), i.service).toBe(true);
  });
});
