import AsyncStorage from '@react-native-async-storage/async-storage';
import { after, type LiveActivity } from 'expo-widgets';

import ProcessingActivity from '@/widgets/processing-activity';

import {
  activityProps,
  planActivities,
  type ActiveActivity,
  type ProcessingActivityProps,
  type TimerBoard,
} from './timers';

const STORAGE_KEY = 'chairside.liveActivities.v1';
/** How long a "Done" activity lingers on the Lock Screen if nobody dismisses it. */
const DONE_LINGER_MS = 15 * 60_000;

interface Entry extends ActiveActivity {
  id: string;
}

let entries: Entry[] | null = null;
let queue: Promise<void> = Promise.resolve();

async function load(): Promise<Entry[]> {
  if (entries) return entries;
  let stored: Entry[] = [];
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    stored = raw ? (JSON.parse(raw) as Entry[]) : [];
  } catch {
    stored = [];
  }
  // Forget activities the system already ended (or the user swiped away).
  try {
    const live = new Set(ProcessingActivity.getInstances().map((a) => a.getId()));
    stored = stored.filter((e) => live.has(e.id));
  } catch {
    // Live Activities unavailable (older iOS); keep what we have and fail softly below.
  }
  entries = stored;
  return stored;
}

function instance(id: string): LiveActivity<ProcessingActivityProps> | undefined {
  return ProcessingActivity.getInstances().find((a) => a.getId() === id);
}

async function run(
  board: Pick<TimerBoard, 'running' | 'finished'>,
  enabled: boolean,
  now: number,
): Promise<void> {
  const list = await load();
  const plan = planActivities(board, list, enabled);
  if (!plan.start.length && !plan.update.length && !plan.finish.length && !plan.remove.length)
    return;
  const byKey = new Map(list.map((e) => [e.key, e]));

  for (const key of plan.remove) {
    const e = byKey.get(key);
    byKey.delete(key);
    if (!e) continue;
    try {
      await instance(e.id)?.end('immediate');
    } catch {
      // Already gone.
    }
  }
  for (const t of plan.update) {
    const e = byKey.get(t.key);
    if (!e) continue;
    try {
      await instance(e.id)?.update(activityProps(t, now));
      byKey.set(t.key, { ...e, start: t.start, end: t.end });
    } catch {
      byKey.delete(t.key);
    }
  }
  for (const t of plan.finish) {
    const e = byKey.get(t.key);
    if (!e) continue;
    try {
      await instance(e.id)?.end(
        after(new Date(now + DONE_LINGER_MS)),
        { ...activityProps(t, now), done: true },
        new Date(t.end),
      );
      byKey.set(t.key, { ...e, done: true });
    } catch {
      byKey.delete(t.key);
    }
  }
  for (const t of plan.start) {
    try {
      // The activity's own countdown (timerInterval) keeps ticking without app updates; the
      // stale date dims it if the app never got to end it.
      const activity = ProcessingActivity.start(
        activityProps(t, now),
        'chairside:///',
        new Date(t.end + DONE_LINGER_MS),
      );
      byKey.set(t.key, { key: t.key, id: activity.getId(), start: t.start, end: t.end });
    } catch {
      // Disabled in iOS Settings or the system limit was hit; the in-app timer still runs.
    }
  }

  entries = [...byKey.values()];
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Best effort: worst case a stale activity is left to expire on its own.
  }
}

/** Mirrors running/finished processing timers as Live Activities (one per timer). */
export function syncLiveActivities(
  board: Pick<TimerBoard, 'running' | 'finished'>,
  enabled: boolean,
  now: number,
): Promise<void> {
  queue = queue.then(() => run(board, enabled, now)).catch(() => undefined);
  return queue;
}
