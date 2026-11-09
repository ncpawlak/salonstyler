import {
  buildWorkHours,
  diffOverrides,
  templateToRows,
  type WorkHours,
  type WorkHoursOverrideRow,
} from '@chairside/core';
import {
  deleteWorkHoursOverride,
  getWorkHours,
  saveWorkHoursTemplate,
  updateBookingRules,
  upsertWorkHoursOverride,
  type WorkHoursOverride as WorkHoursOverrideDbRow,
} from '@chairside/db';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { supabase } from '@/lib/supabase';

export interface BookingRulesState {
  minNoticeMinutes: number;
  bookingWindowDays: number;
  slotGridMinutes: number;
  /** How long a held slot stays reserved before it is released automatically. */
  holdExpiryHours: number;
}

/** Saved state for one salon, as the editor starts from it. */
export interface SavedWorkHours {
  hours: WorkHours;
  rules: BookingRulesState;
  /** Raw override rows (with ids), so saving can diff against them. */
  overrideRows: WorkHoursOverrideDbRow[];
}

const workHoursKey = (salonId: string) => ['work-hours', salonId] as const;

async function loadWorkHours(salonId: string): Promise<SavedWorkHours> {
  const data = await getWorkHours(supabase, salonId);
  return {
    hours: buildWorkHours({
      timeZone: data.timeZone,
      template: data.template,
      overrides: data.overrides as WorkHoursOverrideRow[],
    }),
    rules: {
      minNoticeMinutes: data.bookingRules.min_notice_minutes,
      bookingWindowDays: data.bookingRules.booking_window_days,
      slotGridMinutes: data.bookingRules.slot_grid_minutes,
      holdExpiryHours: data.bookingRules.hold_expiry_hours,
    },
    overrideRows: data.overrides,
  };
}

export function useWorkHours(salonId: string) {
  return useQuery({ queryKey: workHoursKey(salonId), queryFn: () => loadWorkHours(salonId) });
}

/** Writes the edited template, overrides and rules, then reloads them from the database. */
export function useSaveWorkHours(salonId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      saved,
      hours,
      rules,
    }: {
      saved: SavedWorkHours;
      hours: WorkHours;
      rules: BookingRulesState;
    }) => {
      // Deletes first: a range being re-painted may reuse a deleted row's dates.
      const { upserts, deletes } = diffOverrides(
        saved.overrideRows as (WorkHoursOverrideRow & { id: string })[],
        hours.overrides ?? [],
      );
      for (const id of deletes) await deleteWorkHoursOverride(supabase, id);
      for (const row of upserts) {
        await upsertWorkHoursOverride(supabase, salonId, {
          start_date: row.start_date,
          end_date: row.end_date,
          kind: row.kind,
          blocks: row.blocks as NonNullable<WorkHoursOverrideDbRow['blocks']>,
          breaks: row.breaks as NonNullable<WorkHoursOverrideDbRow['breaks']>,
          note: row.note ?? null,
        });
      }
      await saveWorkHoursTemplate(
        supabase,
        salonId,
        templateToRows(hours.weekly).map((r) => ({
          weekday: r.weekday,
          blocks: r.blocks as NonNullable<WorkHoursOverrideDbRow['blocks']>,
          breaks: r.breaks as NonNullable<WorkHoursOverrideDbRow['breaks']>,
        })),
      );
      await updateBookingRules(supabase, salonId, {
        min_notice_minutes: rules.minNoticeMinutes,
        booking_window_days: rules.bookingWindowDays,
        slot_grid_minutes: rules.slotGridMinutes,
        hold_expiry_hours: rules.holdExpiryHours,
      });
    },
    // Only reload on success: after a failure the edits stay on screen and Save can be retried
    // (deletes and upserts are idempotent).
    onSuccess: () => queryClient.invalidateQueries({ queryKey: workHoursKey(salonId) }),
  });
}
