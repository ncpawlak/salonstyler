import type { Json } from './database.types.ts';
import type {
  ChairsideClient,
  SalonSettings,
  WorkHoursOverride,
  WorkHoursOverrideKind,
  WorkHoursTemplate,
} from './index.ts';

export type BookingRulesSettings = Pick<
  SalonSettings,
  'min_notice_minutes' | 'booking_window_days' | 'slot_grid_minutes' | 'hold_expiry_hours'
>;

export interface WorkHoursData {
  /** `salons.timezone`; every wall-clock time below is in this zone. */
  timeZone: string;
  template: WorkHoursTemplate[];
  overrides: WorkHoursOverride[];
  bookingRules: BookingRulesSettings;
}

/**
 * Everything needed to resolve work hours (pass to `buildWorkHours` in `@chairside/core`).
 * `range` limits overrides to those touching `[from, to]` (local `YYYY-MM-DD`).
 */
export async function getWorkHours(
  client: ChairsideClient,
  salonId: string,
  range?: { from: string; to: string },
): Promise<WorkHoursData> {
  let overrides = client.from('work_hours_override').select('*').eq('salon_id', salonId);
  if (range) overrides = overrides.lte('start_date', range.to).gte('end_date', range.from);

  const [salon, template, override, settings] = await Promise.all([
    client.from('salons').select('timezone').eq('id', salonId).single(),
    client.from('work_hours_template').select('*').eq('salon_id', salonId).order('weekday'),
    overrides.order('start_date'),
    client
      .from('settings')
      .select('min_notice_minutes, booking_window_days, slot_grid_minutes, hold_expiry_hours')
      .eq('salon_id', salonId)
      .single(),
  ]);
  for (const r of [salon, template, override, settings]) if (r.error) throw r.error;
  return {
    timeZone: salon.data!.timezone,
    template: template.data!,
    overrides: override.data!,
    bookingRules: settings.data!,
  };
}

export interface WorkHoursTemplateInput {
  weekday: number;
  blocks: NonNullable<Json>;
  breaks: NonNullable<Json>;
}

/** Replaces the blanket weekly schedule (owners only). */
export async function saveWorkHoursTemplate(
  client: ChairsideClient,
  salonId: string,
  days: WorkHoursTemplateInput[],
): Promise<WorkHoursTemplate[]> {
  const { data, error } = await client
    .from('work_hours_template')
    .upsert(
      days.map((d) => ({ ...d, salon_id: salonId })),
      { onConflict: 'salon_id,weekday' },
    )
    .select();
  if (error) throw error;
  return data;
}

export interface WorkHoursOverrideInput {
  start_date: string;
  end_date: string;
  kind: WorkHoursOverrideKind;
  blocks: NonNullable<Json>;
  breaks: NonNullable<Json>;
  note?: string | null;
}

/** Paints a date or range; re-painting the same range replaces it (owners only). */
export async function upsertWorkHoursOverride(
  client: ChairsideClient,
  salonId: string,
  override: WorkHoursOverrideInput,
): Promise<WorkHoursOverride> {
  const { data, error } = await client
    .from('work_hours_override')
    .upsert({ ...override, salon_id: salonId }, { onConflict: 'salon_id,start_date,end_date' })
    .select()
    .single();
  if (error) throw error;
  return data;
}

/** Removes an override so the date falls back to the weekly template. */
export async function deleteWorkHoursOverride(client: ChairsideClient, id: string): Promise<void> {
  const { error } = await client.from('work_hours_override').delete().eq('id', id);
  if (error) throw error;
}

export async function updateBookingRules(
  client: ChairsideClient,
  salonId: string,
  rules: Partial<BookingRulesSettings>,
): Promise<BookingRulesSettings> {
  const { data, error } = await client
    .from('settings')
    .update(rules)
    .eq('salon_id', salonId)
    .select('min_notice_minutes, booking_window_days, slot_grid_minutes, hold_expiry_hours')
    .single();
  if (error) throw error;
  return data;
}
