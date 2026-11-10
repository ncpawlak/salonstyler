import { describe, expect, it } from 'vitest';

import {
  captureSummary,
  channelLabel,
  dataUriToImage,
  MAX_CAPTURE_IMAGE_CHARS,
  senderFields,
  sharedText,
  toCaptureImage,
} from './capture';

describe('channelLabel', () => {
  it('keeps the Shortcut wording for texts and names the app for captures', () => {
    expect(channelLabel('sms', '+15550101')).toBe('Text from +15550101');
    expect(channelLabel(null, null)).toBe('Text');
    expect(channelLabel('instagram', null)).toBe('Instagram DM');
    expect(channelLabel('whatsapp', '+15550101')).toBe('WhatsApp · +15550101');
    expect(channelLabel('paste', null)).toBe('Pasted');
    expect(channelLabel('screenshot', null)).toBe('Screenshot');
  });
});

describe('dataUriToImage', () => {
  it('splits a data URI into type and base64', () => {
    expect(dataUriToImage('data:image/png;base64,iVBORw0')).toEqual({
      mimeType: 'image/png',
      data: 'iVBORw0',
    });
    expect(dataUriToImage('file:///tmp/a.png')).toBeNull();
  });

  it('rejects types and sizes the server would reject', () => {
    expect(() => dataUriToImage('data:image/heic;base64,AAAA')).toThrow(/PNG, JPEG/);
    expect(() => toCaptureImage('image/jpeg', 'a'.repeat(MAX_CAPTURE_IMAGE_CHARS + 1))).toThrow(
      /too large/,
    );
  });
});

describe('sharedText', () => {
  it('keeps a shared link once and caps the length', () => {
    expect(sharedText(' hi ', 'https://x.test')).toBe('hi\nhttps://x.test');
    expect(sharedText('see https://x.test', 'https://x.test')).toBe('see https://x.test');
    expect(sharedText('a'.repeat(5000))).toHaveLength(4000);
  });
});

describe('senderFields', () => {
  it('treats numbers as phones and anything else as a name', () => {
    expect(senderFields('')).toEqual({});
    expect(senderFields('(555) 010-1234')).toEqual({ senderPhone: '(555) 010-1234' });
    expect(senderFields('Karina Lopez')).toEqual({ sender: 'Karina Lopez' });
    expect(senderFields('@karina.l')).toEqual({ sender: '@karina.l' });
  });
});

describe('captureSummary', () => {
  it('sends captured requests to the Inbox and explains ignored ones', () => {
    expect(
      captureSummary({
        ok: true,
        status: 'captured',
        requestId: 'r',
        intent: 'booking',
        appointmentId: 'a',
        clientCreated: false,
        source: 'screenshot',
      }),
    ).toMatchObject({ title: 'Added to your Inbox', toInbox: true });
    expect(
      captureSummary({ ok: true, status: 'ignored', reason: 'not_a_request', source: 'paste' }),
    ).toMatchObject({ toInbox: false });
  });
});
