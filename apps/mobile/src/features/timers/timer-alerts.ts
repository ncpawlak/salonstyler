import * as Notifications from 'expo-notifications';

import { pushSupported } from '@/features/notifications/push';

import { alertContent, planAlerts, type ScheduledAlert, type TimerBoard } from './timers';

const TYPE = 'processing_timer';
const id = (key: string) => `${TYPE}:${key}`;

let queue: Promise<void> = Promise.resolve();

async function scheduled(): Promise<ScheduledAlert[]> {
  const all = await Notifications.getAllScheduledNotificationsAsync();
  const out: ScheduledAlert[] = [];
  for (const n of all) {
    const data = n.content.data as { type?: unknown; key?: unknown; at?: unknown } | null;
    if (data?.type === TYPE && typeof data.key === 'string' && typeof data.at === 'number')
      out.push({ key: data.key, at: data.at });
  }
  return out;
}

async function allowed(): Promise<boolean> {
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  if (current.status !== 'undetermined') return false;
  return (await Notifications.requestPermissionsAsync()).granted;
}

async function run(running: TimerBoard['running'], enabled: boolean, now: number): Promise<void> {
  const plan = planAlerts(running, await scheduled(), enabled);
  for (const key of plan.cancel) await Notifications.cancelScheduledNotificationAsync(id(key));
  const due = plan.schedule.filter((t) => t.end > now);
  if (!due.length || !(await allowed())) return;
  for (const t of due) {
    await Notifications.scheduleNotificationAsync({
      identifier: id(t.key),
      content: {
        ...alertContent(t),
        sound: 'default',
        data: { type: TYPE, key: t.key, at: t.end },
      },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: new Date(t.end) },
    });
  }
}

/**
 * Keeps one local "processing done" notification per running timer (#40), so the stylist is
 * alerted at zero even with the app in the background. The in-app buzz covers the foreground.
 */
export function syncTimerAlerts(
  running: TimerBoard['running'],
  enabled: boolean,
  now: number,
): Promise<void> {
  if (!pushSupported) return Promise.resolve();
  queue = queue.then(() => run(running, enabled, now)).catch(() => undefined);
  return queue;
}
