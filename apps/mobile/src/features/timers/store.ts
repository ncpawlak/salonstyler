import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

import {
  DEFAULT_TIMER_PREFS,
  pruneOverrides,
  type TimerOverride,
  type TimerOverrides,
  type TimerPrefs,
} from './timers';

/**
 * Device-local timer state: the stylist's manual starts / extensions / dismissals and the timer
 * preferences. Timers are a per-device convenience (the stylist's own phone), so nothing here
 * goes to the database.
 */
const STORAGE_KEY = 'chairside.processingTimers.v1';

export interface TimerState {
  overrides: TimerOverrides;
  prefs: TimerPrefs;
  /** False until the stored state has been read (avoids flashing auto-started timers). */
  loaded: boolean;
}

let state: TimerState = { overrides: {}, prefs: DEFAULT_TIMER_PREFS, loaded: false };
const listeners = new Set<() => void>();
let loading: Promise<void> | null = null;

function emit() {
  for (const l of listeners) l();
}

// Prefs changed before the stored state finished loading win over the stored ones.
let changedPrefs: Partial<TimerPrefs> = {};

function load(): Promise<void> {
  loading ??= AsyncStorage.getItem(STORAGE_KEY)
    .then((raw) => {
      const saved = raw
        ? (JSON.parse(raw) as Partial<Pick<TimerState, 'overrides' | 'prefs'>>)
        : {};
      state = {
        overrides: pruneOverrides({ ...saved.overrides, ...state.overrides }, Date.now()),
        prefs: { ...DEFAULT_TIMER_PREFS, ...saved.prefs, ...changedPrefs },
        loaded: true,
      };
    })
    .catch(() => {
      state = { ...state, loaded: true };
    })
    .finally(emit);
  return loading;
}

/** Writes only after the stored state has been read and merged, so it's never clobbered. */
function persist() {
  void load().then(() => {
    const { overrides, prefs } = state;
    return AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ overrides, prefs })).catch(() => {});
  });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  void load();
  return () => listeners.delete(listener);
}

const getState = () => state;

export function useTimerState(): TimerState {
  return useSyncExternalStore(subscribe, getState, getState);
}

export function setTimerOverride(key: string, override: TimerOverride): void {
  state = {
    ...state,
    overrides: pruneOverrides({ ...state.overrides, [key]: override }, Date.now()),
  };
  persist();
  emit();
}

export function setTimerPrefs(patch: Partial<TimerPrefs>): void {
  if (!state.loaded) changedPrefs = { ...changedPrefs, ...patch };
  state = { ...state, prefs: { ...state.prefs, ...patch } };
  persist();
  emit();
}
