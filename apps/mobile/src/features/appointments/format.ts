const cache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${timeZone}|${JSON.stringify(options)}`;
  let f = cache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, ...options });
    cache.set(key, f);
  }
  return f;
}

/** `10:15 AM` in the salon's time zone. */
export function formatTime(ms: number, timeZone: string): string {
  return formatter(timeZone, { hour: 'numeric', minute: '2-digit' }).format(ms);
}

/** `Tue, Dec 1` in the salon's time zone. */
export function formatDay(ms: number, timeZone: string): string {
  return formatter(timeZone, { weekday: 'short', month: 'short', day: 'numeric' }).format(ms);
}

/** `Tuesday, December 1` for a local `YYYY-MM-DD` (no time zone shift). */
export function formatLocalDateLong(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(Date.UTC(y!, m! - 1, d!));
}
