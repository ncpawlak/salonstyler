/**
 * The installable iOS Shortcut ("Chairside Bridge"): version, trigger phrases, the replies it can
 * text back, and bridge health. Dependency-free so the app can import it too.
 * See docs/shortcut-bridge.md.
 */

export const BRIDGE_SHORTCUT_NAME = 'Chairside Bridge';
/**
 * Version the published Shortcut sends as `bridgeVersion`. Bump it (and re-publish the iCloud
 * link) whenever the Shortcut changes. v1 = the spike recipe; v2 adds auto-reply (Send Message).
 */
export const BRIDGE_SHORTCUT_VERSION = 2;
export const DEFAULT_BRIDGE_KEYWORD = 'Chairside';
/** No texts for this long while a bridge is set up: the automation may have stopped. */
export const BRIDGE_STALE_DAYS = 7;

const CHAIRSIDE = /^chair[\s-]*sides?$/i;

/**
 * The "Message Contains" phrases to set up, one automation each. Autocorrect splits "Chairside"
 * into "Chair side", so the default keyword gets a second trigger; a custom multi-word keyword
 * also gets its joined spelling.
 */
export function triggerPhrases(keyword: string | null | undefined): string[] {
  const k = keyword?.trim().replace(/\s+/g, ' ') || DEFAULT_BRIDGE_KEYWORD;
  if (CHAIRSIDE.test(k)) return ['Chairside', 'Chair side'];
  const joined = k.replace(/\s+/g, '');
  return joined !== k ? [k, joined] : [k];
}

/** "<keyword> test" (or a hand run with no message) checks the bridge without a booking. */
export function isTestMessage(strippedText: string): boolean {
  return /^(test|testing|test message)[\s.!?]*$/i.test(strippedText.trim());
}

const salonLabel = (salonName?: string | null) => salonName?.trim() || 'the salon';

export function teachingLine(keyword: string | null | undefined): string {
  return `Next time just text “${keyword?.trim() || DEFAULT_BRIDGE_KEYWORD}” + what you need ✂️`;
}

/** Reply to a message that was only the keyword. */
export function helpReply(keyword: string | null | undefined, salonName?: string | null): string {
  const k = keyword?.trim() || DEFAULT_BRIDGE_KEYWORD;
  return `Hi! This is ${salonLabel(salonName)}’s booking line. Text “${k}” + what you need, e.g. “${k} cut Friday afternoon”, and we’ll find you a time ✂️`;
}

/** Reply once a request is in the Inbox. The stylist still approves the time. */
export function receivedReply(keyword: string | null | undefined, salonName?: string | null) {
  return `Got it! ${salonLabel(salonName)} will confirm your time shortly. ${teachingLine(keyword)}`;
}

export const TEST_REPLY = '✅ Chairside text bridge is connected.';

/** The confirmation the stylist sends after approving a texted request. */
export function confirmationText(input: {
  clientName?: string | null;
  when: string;
  salonName?: string | null;
  keyword?: string | null;
}): string {
  const first = input.clientName?.trim().split(/\s+/)[0];
  return `Hi${first ? ` ${first}` : ''}! You’re confirmed for ${input.when} at ${salonLabel(input.salonName)}. ${teachingLine(input.keyword)}`;
}

/** `sms:` link for the station card QR code: opens Messages with the keyword typed in. */
export function stationCardSmsUrl(phone: string, keyword: string | null | undefined): string {
  const trimmed = phone.trim();
  const digits = trimmed.replace(/\D/g, '');
  const number = trimmed.startsWith('+') ? `+${digits}` : digits;
  // `?&body=` works on both iOS and Android.
  return `sms:${number}?&body=${encodeURIComponent(`${keyword?.trim() || DEFAULT_BRIDGE_KEYWORD} `)}`;
}

/** Integer version from `bridgeVersion` ("2", 2, "2.1"); null when missing or unreadable. */
export function parseBridgeVersion(version: string | number | null | undefined): number | null {
  if (version === null || version === undefined) return null;
  const n = Number.parseInt(String(version), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export type BridgeHealthState = 'never' | 'ok' | 'stale';

export interface BridgeHealth {
  state: BridgeHealthState;
  /** Days since the bridge last fired (rounded down). */
  daysSince: number | null;
  /** The Shortcut that last fired is older than the published one. */
  outdated: boolean;
}

/** Whether the Shortcut is firing: never, recently, or not for BRIDGE_STALE_DAYS. */
export function bridgeHealth(input: {
  lastReceivedAt: string | null | undefined;
  lastBridgeVersion?: string | null;
  now?: number;
}): BridgeHealth {
  const version = parseBridgeVersion(input.lastBridgeVersion);
  const outdated = version !== null && version < BRIDGE_SHORTCUT_VERSION;
  const last = input.lastReceivedAt ? Date.parse(input.lastReceivedAt) : NaN;
  if (Number.isNaN(last)) return { state: 'never', daysSince: null, outdated };
  const daysSince = Math.max(0, Math.floor(((input.now ?? Date.now()) - last) / 86_400_000));
  return { state: daysSince >= BRIDGE_STALE_DAYS ? 'stale' : 'ok', daysSince, outdated };
}
