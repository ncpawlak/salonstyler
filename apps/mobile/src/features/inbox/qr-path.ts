import { create } from 'qrcode';

const QUIET_ZONE = 2;

/** SVG path of the dark modules, one unit per module, offset by the quiet zone. */
export function qrPath(value: string): { path: string; size: number } {
  const { modules } = create(value, { errorCorrectionLevel: 'M' });
  let path = '';
  for (let y = 0; y < modules.size; y++) {
    for (let x = 0; x < modules.size; x++) {
      if (modules.get(y, x)) path += `M${x + QUIET_ZONE} ${y + QUIET_ZONE}h1v1h-1z`;
    }
  }
  return { path, size: modules.size + QUIET_ZONE * 2 };
}

/** Standalone SVG markup, for the printable station card. */
export function qrSvg(value: string, pixels: number): string {
  const { path, size } = qrPath(value);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${pixels}" height="${pixels}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}
