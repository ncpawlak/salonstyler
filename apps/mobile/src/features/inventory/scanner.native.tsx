import { CameraView, useCameraPermissions, type BarcodeType } from 'expo-camera';
import { useRef } from 'react';
import { Linking, View } from 'react-native';

import { Button, Card, Icon, Text } from '@/components/ui';

import { ManualBarcodeEntry } from './manual-entry';
import type { BarcodeScannerProps } from './scanner';
import { normalizeBarcode } from './stock';

/** Retail barcodes plus the common shelf-label symbologies. */
const BARCODE_TYPES: BarcodeType[] = [
  'ean13',
  'ean8',
  'upc_a',
  'upc_e',
  'code128',
  'code39',
  'code93',
  'itf14',
  'qr',
];

/** The camera keeps reporting a code while it's in view; ignore repeats for this long. */
const REPEAT_MS = 1500;

export function BarcodeScanner({ onScan, paused }: BarcodeScannerProps) {
  const [permission, requestPermission] = useCameraPermissions();
  const last = useRef<{ code: string; at: number } | null>(null);

  const handle = (raw: string) => {
    const code = normalizeBarcode(raw);
    if (!code || paused) return;
    const now = Date.now();
    if (last.current && last.current.code === code && now - last.current.at < REPEAT_MS) return;
    last.current = { code, at: now };
    onScan(code);
  };

  return (
    <View className="gap-3">
      {permission?.granted ? (
        <View className="aspect-[4/3] overflow-hidden rounded-2xl bg-black">
          <CameraView
            style={{ flex: 1 }}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: BARCODE_TYPES }}
            onBarcodeScanned={paused ? undefined : (r) => handle(r.data)}
          />
          <View
            pointerEvents="none"
            className="absolute inset-x-8 top-1/2 h-0.5 -translate-y-px bg-red-500/80"
          />
        </View>
      ) : (
        <Card className="items-center gap-3 py-6">
          <Icon name="camera-outline" size={32} color="muted-foreground" />
          <Text variant="body" className="text-center">
            {permission && !permission.canAskAgain
              ? 'Camera access is off. Turn it on in Settings to scan barcodes.'
              : 'Allow the camera to scan product barcodes.'}
          </Text>
          {permission && !permission.canAskAgain ? (
            <Button
              variant="secondary"
              label="Open Settings"
              onPress={() => void Linking.openSettings()}
            />
          ) : (
            <Button label="Allow camera" icon="camera" onPress={() => void requestPermission()} />
          )}
        </Card>
      )}
      <ManualBarcodeEntry onScan={handle} disabled={paused} />
    </View>
  );
}
