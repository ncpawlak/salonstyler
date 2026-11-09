import { BRIDGE_SHORTCUT_VERSION, type BridgeHealth, bridgeHealth } from '@chairside/ai/shortcut';
import type { InboxBridge as InboxBridgeRow } from '@chairside/db';
import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';

import { Badge, type BadgeTone, Icon, Text } from '@/components/ui';
import { formatDay, formatTime } from '@/features/appointments/format';
import { cn } from '@/lib/cn';

import { useInboxBridge } from './api';

type InboxBridge = Omit<InboxBridgeRow, 'token_hash'>;

export function healthOf(bridge: InboxBridge | null | undefined): BridgeHealth | null {
  return bridge
    ? bridgeHealth({
        lastReceivedAt: bridge.last_received_at,
        lastBridgeVersion: bridge.last_bridge_version,
      })
    : null;
}

const STATE_COPY: Record<BridgeHealth['state'], { badge: string; tone: BadgeTone }> = {
  ok: { badge: 'Working', tone: 'success' },
  stale: { badge: 'Check it', tone: 'warning' },
  never: { badge: 'Not tested', tone: 'neutral' },
};

/** Settings: when the Shortcut last fired, and whether it looks stopped or outdated. */
export function BridgeHealthSummary({
  bridge,
  timeZone,
}: {
  bridge: InboxBridge;
  timeZone: string;
}) {
  const health = healthOf(bridge)!;
  const last = bridge.last_received_at ? Date.parse(bridge.last_received_at) : null;
  const tested = bridge.last_test_at ? Date.parse(bridge.last_test_at) : null;
  const copy = STATE_COPY[health.state];
  return (
    <View className="gap-1" testID="bridge-health">
      <View className="flex-row items-center justify-between gap-2">
        <Text variant="subhead" className="flex-1">
          {last
            ? `Last fired ${formatDay(last, timeZone)} · ${formatTime(last, timeZone)}`
            : 'The Shortcut hasn’t fired yet.'}
        </Text>
        <Badge label={copy.badge} tone={copy.tone} />
      </View>
      {tested ? (
        <Text variant="footnote" tone="muted">
          Last test {formatDay(tested, timeZone)} · {formatTime(tested, timeZone)}
        </Text>
      ) : null}
      {health.state === 'stale' ? (
        <Text variant="footnote" tone="warning">
          No texts for {health.daysSince} days. If clients have texted your keyword since, the
          automation may be off: run setup again to check it.
        </Text>
      ) : null}
      {health.outdated ? (
        <Text variant="footnote" tone="warning">
          Your Shortcut is v{bridge.last_bridge_version}; v{BRIDGE_SHORTCUT_VERSION} is available.
          Run setup to update it.
        </Text>
      ) : null}
    </View>
  );
}

/** Inbox tab: a nudge when the bridge looks stopped or the Shortcut is outdated. */
export function BridgeHealthBanner() {
  const bridge = useInboxBridge();
  const health = healthOf(bridge.data);
  if (!health || (health.state !== 'stale' && !health.outdated)) return null;
  const message =
    health.state === 'stale'
      ? `No booking texts for ${health.daysSince} days. Check that your Shortcut is still on.`
      : 'A newer version of the Chairside Shortcut is available.';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint="Opens text bridge setup"
      onPress={() => router.push('/settings/text-bridge-setup')}
      className="mb-3 flex-row items-center gap-3 rounded-xl bg-warning/10 px-4 py-3"
      testID="bridge-health-banner"
    >
      <Icon name="warning-outline" color="warning" />
      <Text variant="subhead" className="flex-1">
        {message}
      </Text>
      <Icon name="chevron-forward" size={18} color="muted-foreground" />
    </Pressable>
  );
}

/** Copy to the clipboard and flash "Copied" for a moment. */
export function useCopy() {
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => (timer.current ? clearTimeout(timer.current) : undefined), []);
  const copy = useCallback(async (key: string, text: string) => {
    await Clipboard.setStringAsync(text);
    setCopied(key);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(null), 2000);
  }, []);
  return { copied, copy };
}

export type MockRow = { label: string; value?: string; toggle?: boolean; highlight?: boolean };

/** A drawn stand-in for an iOS settings screenshot: the rows to look for and how to set them. */
export function MockPhoneScreen({ title, rows }: { title: string; rows: MockRow[] }) {
  return (
    <View
      accessibilityLabel={`${title}: ${rows
        .map(
          (r) => `${r.label} ${r.toggle === undefined ? (r.value ?? '') : r.toggle ? 'on' : 'off'}`,
        )
        .join(', ')}`}
      className="overflow-hidden rounded-2xl border border-border bg-background"
    >
      <View className="border-b border-border bg-card px-4 py-2">
        <Text variant="footnote" className="text-center font-semibold">
          {title}
        </Text>
      </View>
      {rows.map((row, i) => (
        <View
          key={row.label}
          className={cn(
            'flex-row items-center justify-between gap-3 px-4 py-2.5',
            i < rows.length - 1 && 'border-b border-border',
            row.highlight && 'bg-primary/10',
          )}
        >
          <Text variant="subhead" className="flex-1">
            {row.label}
          </Text>
          {row.toggle === undefined ? (
            row.value ? (
              <Text variant="subhead" tone={row.highlight ? 'primary' : 'muted'}>
                {row.value}
              </Text>
            ) : null
          ) : (
            <View
              className={cn(
                'h-6 w-10 justify-center rounded-full px-0.5',
                row.toggle ? 'items-end bg-success' : 'items-start bg-border',
              )}
            >
              <View className="h-5 w-5 rounded-full bg-white" />
            </View>
          )}
        </View>
      ))}
    </View>
  );
}
