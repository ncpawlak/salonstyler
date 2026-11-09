import { describe, expect, it } from 'vitest';

import {
  BRIDGE_SHORTCUT_VERSION,
  bridgeHealth,
  confirmationText,
  helpReply,
  isTestMessage,
  parseBridgeVersion,
  stationCardSmsUrl,
  teachingLine,
  triggerPhrases,
} from './shortcut.ts';

const NOW = Date.parse('2026-12-10T12:00:00Z');

describe('shortcut helpers', () => {
  it('sets up a "Chair side" trigger for the default keyword only', () => {
    expect(triggerPhrases('Chairside')).toEqual(['Chairside', 'Chair side']);
    expect(triggerPhrases(' chair side ')).toEqual(['Chairside', 'Chair side']);
    expect(triggerPhrases(null)).toEqual(['Chairside', 'Chair side']);
    expect(triggerPhrases('StudioK')).toEqual(['StudioK']);
    expect(triggerPhrases('Studio  K')).toEqual(['Studio K', 'StudioK']);
  });

  it('recognises test messages', () => {
    expect(isTestMessage('test')).toBe(true);
    expect(isTestMessage('Test!')).toBe(true);
    expect(isTestMessage('test message')).toBe(true);
    expect(isTestMessage('test cut friday')).toBe(false);
  });

  it('teaches the keyword in replies and confirmations', () => {
    expect(teachingLine('StudioK')).toBe('Next time just text “StudioK” + what you need ✂️');
    expect(helpReply('Chairside', 'Studio K')).toContain('“Chairside cut Friday afternoon”');
    expect(
      confirmationText({
        clientName: 'Karina Lopez',
        when: 'Fri, Dec 4 · 1:00 PM',
        salonName: 'Studio K',
        keyword: 'Chairside',
      }),
    ).toBe(
      'Hi Karina! You’re confirmed for Fri, Dec 4 · 1:00 PM at Studio K. Next time just text “Chairside” + what you need ✂️',
    );
  });

  it('builds the station card sms: link with the keyword typed in', () => {
    expect(stationCardSmsUrl('+1 (555) 010-0199', 'Chairside')).toBe(
      'sms:+15550100199?&body=Chairside%20',
    );
    expect(stationCardSmsUrl('555 010 0199', null)).toBe('sms:5550100199?&body=Chairside%20');
  });

  it('parses bridge versions', () => {
    expect(parseBridgeVersion('2')).toBe(2);
    expect(parseBridgeVersion(1)).toBe(1);
    expect(parseBridgeVersion('2.1')).toBe(2);
    expect(parseBridgeVersion('x')).toBeNull();
    expect(parseBridgeVersion(null)).toBeNull();
  });

  it('reports bridge health', () => {
    expect(bridgeHealth({ lastReceivedAt: null, now: NOW })).toEqual({
      state: 'never',
      daysSince: null,
      outdated: false,
    });
    expect(
      bridgeHealth({
        lastReceivedAt: '2026-12-10T08:00:00Z',
        lastBridgeVersion: String(BRIDGE_SHORTCUT_VERSION),
        now: NOW,
      }),
    ).toEqual({ state: 'ok', daysSince: 0, outdated: false });
    expect(
      bridgeHealth({ lastReceivedAt: '2026-12-01T12:00:00Z', lastBridgeVersion: '1', now: NOW }),
    ).toEqual({ state: 'stale', daysSince: 9, outdated: true });
  });
});
