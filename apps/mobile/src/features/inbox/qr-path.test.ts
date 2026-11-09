import { describe, expect, it } from 'vitest';

import { qrPath, qrSvg } from './qr-path';

describe('station card QR code', () => {
  it('draws a version-sized grid with a quiet zone', () => {
    const { path, size } = qrPath('sms:+15550100199?&body=Chairside%20');
    // Versions are 21 + 4n modules wide; 2 modules of quiet zone on each side.
    expect((size - 4 - 21) % 4).toBe(0);
    expect(path.startsWith('M2 2h1v1h-1z')).toBe(true); // top-left finder pattern
  });

  it('renders standalone SVG for printing', () => {
    const svg = qrSvg('sms:5550100199?&body=Chairside%20', 240);
    expect(svg).toMatch(/^<svg [^>]*width="240"/);
    expect(svg).toContain('<path d="M2 2h1v1h-1z');
  });
});
