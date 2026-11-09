import { useCallback, useState, type ReactNode } from 'react';
import { View } from 'react-native';

import { Button } from './button';
import { Text } from './text';

export type SheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  subtitle?: string;
  children: ReactNode;
  /** Optional fixed snap points (e.g. ['50%', '90%']); defaults to fit-content. */
  snapPoints?: (string | number)[];
};

export function SheetHeader({
  title,
  subtitle,
  onClose,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
}) {
  return (
    <View className="flex-row items-start gap-3 px-5 pb-3 pt-1">
      <View className="flex-1 gap-0.5">
        <Text variant="title3" accessibilityRole="header">
          {title}
        </Text>
        {subtitle ? (
          <Text variant="subhead" tone="muted">
            {subtitle}
          </Text>
        ) : null}
      </View>
      <Button
        variant="secondary"
        size="icon"
        icon="close"
        accessibilityLabel="Close"
        haptic="selection"
        onPress={onClose}
      />
    </View>
  );
}

export function useSheet(initial = false) {
  const [open, setOpen] = useState(initial);
  return {
    open,
    show: useCallback(() => setOpen(true), []),
    hide: useCallback(() => setOpen(false), []),
    props: { open, onOpenChange: setOpen },
  };
}
