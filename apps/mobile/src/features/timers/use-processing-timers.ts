import type { AppointmentWithDetails } from '@chairside/db/appointments';
import { useCallback, useMemo } from 'react';

import { setTimerOverride, useTimerState } from './store';
import {
  dismissOverride,
  extendOverride,
  processingSegments,
  resolveTimers,
  startOverride,
  type ProcessingSegment,
  type ProcessingTimer,
  type TimerBoard,
} from './timers';

const EMPTY: TimerBoard = { running: [], finished: [], startable: [] };

/** Today's processing timers (#40) with the stylist's start / extend / stop actions. */
export function useProcessingTimers(appointments: readonly AppointmentWithDetails[], now: number) {
  const { overrides, prefs, loaded } = useTimerState();
  const segments = useMemo(() => processingSegments(appointments), [appointments]);
  const board = useMemo(
    () => (loaded ? resolveTimers(segments, overrides, now, prefs) : EMPTY),
    [loaded, segments, overrides, now, prefs],
  );

  const start = useCallback(
    (seg: ProcessingSegment) => setTimerOverride(seg.key, startOverride(seg, Date.now())),
    [],
  );
  const extend = useCallback(
    (timer: ProcessingTimer, minutes: number) =>
      setTimerOverride(timer.key, extendOverride(timer, minutes, Date.now())),
    [],
  );
  const dismiss = useCallback(
    (key: string) => setTimerOverride(key, dismissOverride(Date.now())),
    [],
  );

  return { board, prefs, loaded, start, extend, dismiss };
}
