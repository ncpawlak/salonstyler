import { useMemo } from 'react';
import Svg, { Path, Rect } from 'react-native-svg';

import { qrPath } from './qr-path';

export { qrSvg } from './qr-path';

export function QrCode({ value, size = 200 }: { value: string; size?: number }) {
  const qr = useMemo(() => qrPath(value), [value]);
  return (
    <Svg
      width={size}
      height={size}
      viewBox={`0 0 ${qr.size} ${qr.size}`}
      accessibilityRole="image"
      accessibilityLabel="QR code"
      testID="station-qr"
    >
      <Rect width={qr.size} height={qr.size} fill="#ffffff" />
      <Path d={qr.path} fill="#000000" />
    </Svg>
  );
}
