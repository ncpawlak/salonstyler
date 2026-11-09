/**
 * Starter service menu seeded for every new salon (docs/PLAN.md Appendix A). Typical US timings and
 * low-end placeholder prices; the stylist edits them.
 *
 * supabase/migrations/*_service_builder.sql embeds this exact data as JSON in
 * `private.starter_menu()`; `starter-menu.test.ts` keeps the two in sync.
 */
import type { ServiceSegment } from '../availability/types';
import type { ServiceAddon, ServiceDefinition, ServiceVariant } from './types';

export interface StarterComboItem {
  /** Name of a service in `StarterMenu.services`. */
  service: string;
  replacesPreviousFinish: boolean;
}

export type StarterService = Omit<ServiceDefinition, 'id'>;
export type StarterAddon = Omit<ServiceAddon, 'id'>;
export interface StarterCombo extends Omit<StarterService, 'segments'> {
  items: StarterComboItem[];
}

export interface StarterMenu {
  services: StarterService[];
  addons: StarterAddon[];
  combos: StarterCombo[];
}

/** Hair-length variants: applied to the busy and style segments. */
export const HAIR_LENGTH_VARIANTS: readonly ServiceVariant[] = [
  { name: 'Short', deltaMinutes: 0 },
  { name: 'Medium', deltaMinutes: 15 },
  { name: 'Long/thick', deltaMinutes: 30 },
];

export const STARTER_CATEGORIES = ['Cuts', 'Styling', 'Color', 'Treatments', 'Other'] as const;

const B = (minutes: number, label?: string): ServiceSegment =>
  label ? { kind: 'busy', minutes, label } : { kind: 'busy', minutes };
const P = (minutes: number, label = 'Process'): ServiceSegment => ({
  kind: 'processing',
  minutes,
  label,
});
const S = (minutes: number, label = 'Rinse & style'): ServiceSegment => ({
  kind: 'style',
  minutes,
  label,
});

const lengths = (): ServiceVariant[] => HAIR_LENGTH_VARIANTS.map((v) => ({ ...v }));

function svc(
  category: StarterService['category'],
  colorTag: StarterService['colorTag'],
  name: string,
  segments: ServiceSegment[],
  priceCents: number | null,
  extra: Partial<StarterService> = {},
): StarterService {
  return {
    name,
    category,
    description: null,
    priceCents,
    colorTag,
    segments,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    consultationRequired: false,
    bookableOnline: true,
    newClientsOnly: false,
    variants: [],
    ...extra,
  };
}

const COLOR_CLEANUP = { bufferAfterMinutes: 10 };

export const STARTER_MENU: StarterMenu = {
  services: [
    svc('Cuts', 'blue', "Women's cut & style", [B(45, 'Cut & style')], 4500, {
      variants: lengths(),
    }),
    svc('Cuts', 'blue', "Men's cut", [B(30, 'Cut')], 2500),
    svc('Cuts', 'blue', "Kids' cut (≤12)", [B(20, 'Cut')], 2000),
    svc('Cuts', 'blue', 'Bang/fringe trim', [B(10, 'Trim')], 1000),
    svc('Cuts', 'blue', 'Beard trim', [B(15, 'Trim')], 1500),

    svc('Styling', 'pink', 'Blowout', [B(45, 'Blowout')], 4000, { variants: lengths() }),
    svc('Styling', 'pink', 'Updo / special occasion', [B(60, 'Style')], 7500, {
      variants: lengths(),
    }),
    svc('Styling', 'pink', 'Bridal trial', [B(90, 'Style')], 10000, { variants: lengths() }),

    svc('Color', 'purple', 'Root touch-up', [B(30, 'Apply'), P(35), S(30)], 6500, {
      ...COLOR_CLEANUP,
      variants: lengths(),
    }),
    svc('Color', 'purple', 'All-over color', [B(40, 'Apply'), P(35), S(30)], 8500, {
      ...COLOR_CLEANUP,
      variants: lengths(),
    }),
    svc('Color', 'purple', 'Toner / gloss', [B(10, 'Apply'), P(20), S(15)], 3500, {
      ...COLOR_CLEANUP,
      variants: lengths(),
    }),
    svc(
      'Color',
      'purple',
      'Partial highlights',
      [B(60, 'Foils'), P(30), B(15, 'Tone'), S(30)],
      11000,
      { ...COLOR_CLEANUP, variants: lengths() },
    ),
    svc(
      'Color',
      'purple',
      'Full highlights',
      [B(90, 'Foils'), P(30), B(15, 'Tone'), S(30)],
      15000,
      {
        ...COLOR_CLEANUP,
        variants: lengths(),
      },
    ),
    svc('Color', 'purple', 'Balayage', [B(75, 'Paint'), P(40), B(20, 'Tone'), S(35)], 18000, {
      ...COLOR_CLEANUP,
      variants: lengths(),
    }),
    svc(
      'Color',
      'purple',
      'Color correction',
      [B(60, 'Apply'), P(30), B(60, 'Correct'), S(30)],
      25000,
      {
        ...COLOR_CLEANUP,
        description: 'Consultation required. Set the time per booking (typically 3–6h).',
        consultationRequired: true,
        bookableOnline: false,
      },
    ),

    svc('Treatments', 'green', 'Deep conditioning', [B(5, 'Apply'), P(15), B(5, 'Rinse')], 2000),
    svc(
      'Treatments',
      'green',
      'Keratin / smoothing',
      [B(60, 'Apply'), P(30), B(60, 'Blow-dry & flat iron')],
      20000,
      { ...COLOR_CLEANUP, variants: lengths() },
    ),
    svc('Treatments', 'green', 'Perm', [B(45, 'Wrap'), P(30), S(30)], 9000, {
      ...COLOR_CLEANUP,
      variants: lengths(),
    }),

    svc('Other', 'gray', 'Consultation', [B(15, 'Consult')], 0),
    svc('Other', 'gray', 'Extensions', [B(120, 'Install'), S(30, 'Blend & style')], 30000, {
      description: 'Consultation required first. Typically 2–4h.',
      consultationRequired: true,
      bookableOnline: false,
    }),
  ],
  addons: [
    {
      name: 'Toner',
      segments: [B(5, 'Apply toner'), P(15)],
      placement: 'before_finish',
      priceCents: 3500,
    },
    {
      name: 'Deep conditioning',
      segments: [B(5, 'Apply treatment'), P(15), B(5, 'Rinse')],
      placement: 'before_finish',
      priceCents: 2000,
    },
    {
      name: 'Bond treatment (Olaplex)',
      segments: [B(5, 'Apply bond treatment'), P(10)],
      placement: 'before_finish',
      priceCents: 3000,
    },
    {
      name: 'Blowout finish',
      segments: [S(15, 'Blowout')],
      placement: 'end',
      priceCents: 2000,
    },
  ],
  combos: [
    {
      name: "Balayage + Women's cut",
      category: 'Color',
      description: 'Balayage, then the cut replaces the rinse & style.',
      priceCents: null,
      colorTag: 'purple',
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      consultationRequired: false,
      bookableOnline: true,
      newClientsOnly: false,
      variants: lengths(),
      items: [
        { service: 'Balayage', replacesPreviousFinish: false },
        { service: "Women's cut & style", replacesPreviousFinish: true },
      ],
    },
  ],
};
