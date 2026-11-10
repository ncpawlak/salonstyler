import { type Point, signatureViewBox, strokesToPath } from '@chairside/core/forms';
import { useRef, useState } from 'react';
import { View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { Button, Text } from '@/components/ui';
import { useTheme } from '@/theme/theme-provider';

const PAD_HEIGHT = 160;

/**
 * Draw-with-your-finger signature for the client's forms page. Reports SVG path data (what
 * form_submissions stores), or null once cleared.
 */
export function SignaturePad({
  label,
  value,
  onChange,
  testID,
}: {
  label: string;
  value: string | null;
  onChange: (path: string | null) => void;
  testID?: string;
}) {
  const { colors } = useTheme();
  const strokes = useRef<Point[][]>([]);
  const [path, setPath] = useState(value ?? '');
  type TouchEvent = { nativeEvent: { locationX: number; locationY: number } };
  const begin = (e: TouchEvent) => {
    const { locationX: x, locationY: y } = e.nativeEvent;
    strokes.current = [...strokes.current, [{ x, y }]];
    setPath(strokesToPath(strokes.current));
  };
  const extend = (e: TouchEvent) => {
    const { locationX: x, locationY: y } = e.nativeEvent;
    const last = strokes.current[strokes.current.length - 1];
    if (!last) return;
    last.push({ x, y });
    setPath(strokesToPath(strokes.current));
  };
  const end = () => {
    const next = strokesToPath(strokes.current);
    setPath(next);
    onChange(next || null);
  };
  const clear = () => {
    strokes.current = [];
    setPath('');
    onChange(null);
  };

  return (
    <View className="gap-1.5">
      <View className="flex-row items-center justify-between">
        <Text variant="footnote" tone="muted" className="font-medium">
          {label}
        </Text>
        {path ? <Button variant="ghost" size="sm" label="Clear" onPress={clear} /> : null}
      </View>
      <View
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        // Keep the page from scrolling while signing.
        onResponderTerminationRequest={() => false}
        onResponderGrant={begin}
        onResponderMove={extend}
        onResponderRelease={end}
        testID={testID}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={`${label}: sign with your finger`}
        accessibilityValue={{ text: path ? 'Signed' : 'Not signed' }}
        className="overflow-hidden rounded-lg border border-input bg-card"
        style={{ height: PAD_HEIGHT, touchAction: 'none' } as object}
      >
        <Svg width="100%" height={PAD_HEIGHT} pointerEvents="none">
          {path ? (
            <Path
              d={path}
              stroke={colors.foreground}
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
            />
          ) : null}
        </Svg>
        {!path ? (
          <View pointerEvents="none" className="absolute inset-x-0 bottom-4 items-center">
            <Text variant="footnote" tone="subtle">
              Sign here
            </Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

/** A stored signature, scaled to fit. */
export function SignatureView({ path, height = 72 }: { path: string; height?: number }) {
  const { colors } = useTheme();
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel="Signature"
      className="rounded-md border border-border bg-card"
      style={{ height }}
    >
      <Svg width="100%" height={height} viewBox={signatureViewBox(path)}>
        <Path
          d={path}
          stroke={colors.foreground}
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </Svg>
    </View>
  );
}
