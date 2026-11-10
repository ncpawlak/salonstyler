import { Card, Text } from '@/components/ui';

import { ManualBarcodeEntry } from './manual-entry';

export type BarcodeScannerProps = {
  onScan: (barcode: string) => void;
  /** Stop reporting scans (e.g. while the last one is being saved). */
  paused?: boolean;
};

/** Web (and the default platform): no camera scanning, so barcodes are typed or keyboard-wedged. */
export function BarcodeScanner({ onScan, paused }: BarcodeScannerProps) {
  return (
    <Card className="gap-3">
      <Text variant="footnote" tone="muted">
        Camera scanning is on the phone app. Here, type the barcode or use a USB scanner.
      </Text>
      <ManualBarcodeEntry onScan={onScan} disabled={paused} autoFocus />
    </Card>
  );
}
