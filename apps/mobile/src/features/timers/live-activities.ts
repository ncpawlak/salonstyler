import type { TimerBoard } from './timers';

/**
 * Mirrors running/finished processing timers as iOS Live Activities (#40). No-op off iOS; see
 * `live-activities.ios.ts`.
 */
export async function syncLiveActivities(
  _board: Pick<TimerBoard, 'running' | 'finished'>,
  _enabled: boolean,
  _now: number,
): Promise<void> {}
