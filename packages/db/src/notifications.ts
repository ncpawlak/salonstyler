import type { AppointmentServiceSnapshot, AppointmentWithDetails } from './appointments';
import { parseTstzRange } from './appointments';
import type { ChairsideClient, Enums, SalonSettings, Tables } from './index';

export type NotificationOutboxRow = Tables<'notifications_outbox'>;
export type NotificationKind = Enums<'notification_kind'>;
export type PushPlatform = Enums<'push_platform'>;

/** Push notification settings (Settings → Notifications). Hold expiry is shared with Work hours. */
export type NotificationSettings = Pick<
  SalonSettings,
  | 'followup_nudge_hours'
  | 'hold_expiry_hours'
  | 'quiet_hours_enabled'
  | 'quiet_hours_start'
  | 'quiet_hours_end'
  | 'daily_agenda_enabled'
>;

const NOTIFICATION_SETTINGS_COLUMNS =
  'followup_nudge_hours, hold_expiry_hours, quiet_hours_enabled, quiet_hours_start, quiet_hours_end, daily_agenda_enabled';

export async function getNotificationSettings(
  client: ChairsideClient,
  salonId: string,
): Promise<NotificationSettings> {
  const { data, error } = await client
    .from('settings')
    .select(NOTIFICATION_SETTINGS_COLUMNS)
    .eq('salon_id', salonId)
    .single();
  if (error) throw error;
  return data;
}

/** Owners only (RLS). Quiet hours are `HH:MM` wall-clock times in the salon timezone. */
export async function updateNotificationSettings(
  client: ChairsideClient,
  salonId: string,
  changes: Partial<NotificationSettings>,
): Promise<NotificationSettings> {
  const { data, error } = await client
    .from('settings')
    .update(changes)
    .eq('salon_id', salonId)
    .select(NOTIFICATION_SETTINGS_COLUMNS)
    .single();
  if (error) throw error;
  return data;
}

/** Saves this device's Expo push token for the signed-in member (call on sign-in). */
export async function registerPushToken(
  client: ChairsideClient,
  salonId: string,
  token: string,
  platform: PushPlatform,
): Promise<void> {
  const { error } = await client.rpc('register_push_token', {
    p_salon_id: salonId,
    p_token: token,
    p_platform: platform,
  });
  if (error) throw error;
}

/** Stops pushes to this device (call before signing out). */
export async function unregisterPushToken(client: ChairsideClient, token: string): Promise<void> {
  const { error } = await client.from('push_tokens').delete().eq('token', token);
  if (error) throw error;
}

/** One appointment with client and segments (e.g. opened from a push), or null if not visible. */
export async function getAppointment(
  client: ChairsideClient,
  appointmentId: string,
): Promise<AppointmentWithDetails | null> {
  const { data, error } = await client
    .from('appointments')
    .select(
      `*,
       client:clients(id, name, phone),
       segments:appointment_segments(kind, label, range, position)`,
    )
    .eq('id', appointmentId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const { segments, services, ...row } = data;
  return {
    ...row,
    services: (Array.isArray(services) ? services : []) as unknown as AppointmentServiceSnapshot[],
    segments: [...segments]
      .sort((a, b) => a.position - b.position)
      .map((s) => ({ kind: s.kind, label: s.label, ...parseTstzRange(s.range) })),
  };
}
