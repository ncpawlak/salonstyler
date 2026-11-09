import { useSyncExternalStore } from 'react';

import { bookingRequests, type BookingRequest } from './data';

/** Tiny in-memory store so the Inbox tab badge reacts to approve/decline in the mockups. */
let requests: BookingRequest[] = bookingRequests;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const inboxStore = {
  resolve(id: string) {
    requests = requests.filter((r) => r.id !== id);
    emit();
  },
  reset() {
    requests = bookingRequests;
    emit();
  },
};

export function usePendingRequests(): BookingRequest[] {
  return useSyncExternalStore(
    subscribe,
    () => requests,
    () => requests,
  );
}
