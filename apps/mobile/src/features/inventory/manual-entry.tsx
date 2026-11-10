import { useState } from 'react';
import { View } from 'react-native';

import { Button, Input } from '@/components/ui';

import { normalizeBarcode } from './stock';

/**
 * Type (or "keyboard-wedge" scan with a USB / Bluetooth scanner) a barcode. The only way to scan on
 * web, and a fallback on phones for worn labels.
 */
export function ManualBarcodeEntry({
  onScan,
  disabled,
  autoFocus,
}: {
  onScan: (barcode: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const [value, setValue] = useState('');
  const barcode = normalizeBarcode(value);
  const submit = () => {
    if (!barcode || disabled) return;
    onScan(barcode);
    setValue('');
  };

  return (
    <View className="flex-row items-end gap-2">
      <View className="flex-1">
        <Input
          label="Barcode"
          accessibilityLabel="Barcode"
          testID="barcode-input"
          placeholder="Type or scan a barcode"
          icon="barcode-outline"
          value={value}
          onChangeText={setValue}
          onSubmitEditing={submit}
          autoFocus={autoFocus}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="go"
          blurOnSubmit={false}
        />
      </View>
      <Button label="Enter" disabled={!barcode || disabled} onPress={submit} />
    </View>
  );
}
