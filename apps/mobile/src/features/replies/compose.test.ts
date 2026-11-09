import { describe, expect, it } from 'vitest';

import { latestReplyByRequest, replySource, replyStatusLabel, smsUrl } from './compose';

describe('smsUrl', () => {
  it('prefills the body for each platform', () => {
    expect(smsUrl('+1 (312) 555-0199', 'Hi Maya! 1:30 & co', 'ios')).toBe(
      'sms:+13125550199&body=Hi%20Maya!%201%3A30%20%26%20co',
    );
    expect(smsUrl(null, 'Hi', 'android')).toBe('sms:?body=Hi');
  });
});

describe('replySource', () => {
  it('keeps the draft source unless the text changed', () => {
    const draft = { text: 'Hi!', source: 'ai' as const };
    expect(replySource(draft, ' Hi! ')).toBe('ai');
    expect(replySource({ ...draft, source: 'template' }, 'Hi!')).toBe('template');
    expect(replySource(draft, 'Hi there!')).toBe('edited');
    expect(replySource(null, 'Hi')).toBe('edited');
  });
});

describe('replyStatusLabel', () => {
  it('describes the latest reply', () => {
    expect(replyStatusLabel({ kind: 'offer', status: 'sent', channel: 'messages' })).toBe(
      'Offer sent · waiting for a yes',
    );
    expect(replyStatusLabel({ kind: 'confirm', status: 'sent', channel: 'copy' })).toBe(
      'Confirmation copied',
    );
    expect(replyStatusLabel({ kind: 'confirm', status: 'sent', channel: 'bridge' })).toBe(
      'Confirmation sent automatically',
    );
    expect(replyStatusLabel({ kind: 'confirm', status: 'queued', channel: 'bridge' })).toBe(
      'Auto-send queued',
    );
  });

  it('keeps the newest reply per request', () => {
    const map = latestReplyByRequest([
      { id: 'b', captured_request_id: 'r1' },
      { id: 'a', captured_request_id: 'r1' },
      { id: 'c', captured_request_id: null },
    ]);
    expect([...map.entries()]).toEqual([['r1', { id: 'b', captured_request_id: 'r1' }]]);
  });
});
