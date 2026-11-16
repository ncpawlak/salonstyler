import type { SuggestionReason, SuggestionReasonKind } from '@chairside/core/scheduling';
import { ActivityIndicator, Pressable, View } from 'react-native';

import { Badge, type BadgeTone, Icon, Text } from '@/components/ui';
import { cn } from '@/lib/cn';

export interface SuggestionItem {
  key: string;
  /** "Tue, Dec 8 · 10:00 AM". */
  label: string;
  /** Extra line under the time ("2h00 · $180"). */
  detail?: string | null;
  tentative: boolean;
  reasons: readonly SuggestionReason[];
}

const REASON_TONE: Record<SuggestionReasonKind, BadgeTone> = {
  requested: 'success',
  nearest: 'warning',
  usual: 'primary',
  due: 'primary',
  popular: 'neutral',
  soonest: 'neutral',
  tentative: 'warning',
};

/**
 * Shared AI slot list (#84 Auto-Schedule, #88 Auto-Find): engine-checked times with chips
 * saying why each one was picked. Tentative hours are labeled; picking one is the stylist's call.
 */
export function SuggestionList({
  items,
  fits,
  windowLabel,
  loading,
  error,
  pickingKey,
  emptyMessage = 'No openings in the next six weeks.',
  onPick,
  testID = 'suggestion-list',
}: {
  items: readonly SuggestionItem[];
  /** With a request: false shows "doesn't fit" above the nearest alternatives. */
  fits?: boolean | null;
  /** What the client asked for ("Next week · mornings"). */
  windowLabel?: string | null;
  loading?: boolean;
  error?: string | null;
  /** The item being booked (shows a spinner and disables the rest). */
  pickingKey?: string | null;
  emptyMessage?: string;
  onPick: (item: SuggestionItem) => void;
  testID?: string;
}) {
  if (loading) {
    return (
      <View className="flex-row items-center gap-2 py-2" testID={`${testID}-loading`}>
        <ActivityIndicator />
        <Text variant="subhead" tone="muted">
          Finding times that work…
        </Text>
      </View>
    );
  }
  if (error) {
    return (
      <View accessibilityRole="alert" className="rounded-lg bg-destructive/10 px-3 py-2">
        <Text variant="subhead" tone="destructive">
          {error}
        </Text>
      </View>
    );
  }

  return (
    <View className="gap-2" testID={testID}>
      {windowLabel ? (
        <View className="flex-row items-center gap-2">
          <Icon name="sparkles" size={14} color="primary" />
          <Text variant="footnote" tone="muted" className="flex-1">
            Asked for: {windowLabel}
          </Text>
        </View>
      ) : null}
      {fits === false ? (
        <View
          className="flex-row items-start gap-2 rounded-lg bg-muted px-3 py-2"
          testID={`${testID}-no-fit`}
        >
          <Icon name="alert-circle-outline" size={16} color="warning" />
          <Text variant="footnote" className="flex-1">
            {items.length
              ? "That doesn't fit your book. The closest openings:"
              : "That doesn't fit your book, and nothing nearby is open."}
          </Text>
        </View>
      ) : null}
      {!items.length && fits !== false ? (
        <Text variant="subhead" tone="muted">
          {emptyMessage}
        </Text>
      ) : null}
      {items.map((item) => {
        const picking = pickingKey === item.key;
        const reasons = item.reasons.map((r) => r.label).join(', ');
        return (
          <Pressable
            key={item.key}
            accessibilityRole="button"
            accessibilityLabel={`${item.label}${reasons ? `. ${reasons}` : ''}`}
            accessibilityState={{ disabled: !!pickingKey, busy: picking }}
            disabled={!!pickingKey}
            onPress={() => onPick(item)}
            className={cn(
              'gap-1.5 rounded-xl border px-3 py-2.5 active:opacity-70',
              item.tentative ? 'border-warning' : 'border-border',
              pickingKey && !picking ? 'opacity-50' : null,
            )}
            testID={`${testID}-item`}
          >
            <View className="flex-row items-center gap-2">
              <Text variant="subhead" numeric className="flex-1 font-semibold">
                {item.label}
              </Text>
              {picking ? (
                <ActivityIndicator />
              ) : (
                <Icon name="chevron-forward" size={16} color="muted-foreground" />
              )}
            </View>
            {item.detail ? (
              <Text variant="footnote" tone="muted" numeric>
                {item.detail}
              </Text>
            ) : null}
            {item.reasons.length ? (
              <View className="flex-row flex-wrap gap-1.5">
                {item.reasons.map((r) => (
                  <Badge key={`${r.kind}-${r.label}`} label={r.label} tone={REASON_TONE[r.kind]} />
                ))}
              </View>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}
