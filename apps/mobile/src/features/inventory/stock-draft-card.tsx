import type { StockAdjustmentCard } from '@chairside/ai/assistant';
import { useState } from 'react';
import { View } from 'react-native';

import { Badge, Button, Card, Text } from '@/components/ui';
import { errorMessage } from '@/features/appointments/api';
import { haptics } from '@/lib/haptics';

import { useChangeStock } from './api';
import { formatQuantity } from './stock';

const VERB: Record<StockAdjustmentCard['reason'], string> = {
  use: 'Used',
  receive: 'Received',
  adjust: 'Removed',
};

/**
 * The assistant's drafted stock change ("used 2 tubes of 6N"). Nothing moves until Apply, which
 * calls adjust_stock: the database does the math and sends any low-stock push.
 */
export function StockDraftCardView({ card }: { card: StockAdjustmentCard }) {
  const change = useChangeStock();
  const [state, setState] = useState<'pending' | 'applied' | 'dismissed'>('pending');
  const [onHand, setOnHand] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const apply = () => {
    setError(null);
    change.mutate(
      {
        productId: card.productId,
        kind: 'adjust',
        delta: card.delta,
        reason: card.reason,
        note: card.note ?? 'Via Ask Chairside',
      },
      {
        onSuccess: (movement) => {
          haptics.success();
          setOnHand(Number(movement.on_hand_after));
          setState('applied');
        },
        onError: (e) => {
          haptics.error();
          setError(errorMessage(e));
        },
      },
    );
  };

  return (
    <Card className="gap-3" testID="stock-draft-card">
      <View className="gap-0.5">
        <Text variant="headline">
          {VERB[card.reason]} {formatQuantity(Math.abs(card.delta), card.unit)}
        </Text>
        <Text variant="footnote" tone="muted">
          {card.productName}
          {card.note ? ` · ${card.note}` : ''}
        </Text>
      </View>
      <Text variant="subhead">
        On hand {formatQuantity(card.onHandBefore, card.unit)} →{' '}
        {formatQuantity(onHand ?? card.onHandAfter, card.unit)}
      </Text>
      {error ? (
        <Text variant="footnote" tone="destructive">
          {error}
        </Text>
      ) : null}
      {state === 'applied' ? (
        <Badge label="Stock updated" tone="success" />
      ) : state === 'dismissed' ? (
        <Badge label="Not applied" />
      ) : (
        <View className="flex-row gap-2">
          <Button
            icon="checkmark"
            label="Apply"
            className="flex-1"
            loading={change.isPending}
            onPress={apply}
          />
          <Button
            variant="outline"
            label="Dismiss"
            disabled={change.isPending}
            onPress={() => setState('dismissed')}
          />
        </View>
      )}
    </Card>
  );
}
