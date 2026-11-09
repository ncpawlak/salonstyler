import { DEFAULT_BRIDGE_KEYWORD, stationCardSmsUrl } from '@chairside/ai/shortcut';
import * as Print from 'expo-print';
import { useState } from 'react';
import { Platform, View } from 'react-native';

import { DetailScreen } from '@/components/shell/screen';
import { Button, Card, EmptyState, Input, SectionHeader, SkeletonRow, Text } from '@/components/ui';
import { errorMessage } from '@/features/appointments/api';
import { useInboxBridge, useUpdateBridgeSettings } from '@/features/inbox/api';
import { QrCode, qrSvg } from '@/features/inbox/qr';
import { useCurrentSalon } from '@/providers/session-provider';

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function cardHtml(salonName: string, phone: string, keyword: string): string {
  const qr = qrSvg(stationCardSmsUrl(phone, keyword), 260);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escape(salonName)} station card</title>
<style>body{font-family:-apple-system,Helvetica,Arial,sans-serif;display:flex;justify-content:center;padding:40px;color:#111}
.card{border:2px solid #111;border-radius:24px;padding:32px 40px;text-align:center;width:360px}
h1{font-size:22px;margin:0 0 4px}.big{font-size:30px;font-weight:700;margin:16px 0 4px}
p{margin:6px 0;font-size:15px}.muted{color:#555;font-size:13px}</style></head>
<body><div class="card"><h1>${escape(salonName)}</h1><p>Book by text</p>
<div class="big">“${escape(keyword)}”</div><p>+ what you need, to <b>${escape(phone)}</b></p>
${qr}<p class="muted">Scan to start the text, e.g. “${escape(keyword)} cut Friday afternoon”</p></div></body></html>`;
}

async function printCard(html: string) {
  if (Platform.OS === 'web') {
    const w = window.open('', '_blank');
    if (!w) throw new Error('Allow pop-ups to print the card');
    w.document.write(html);
    w.document.close();
    w.focus();
    w.print();
    return;
  }
  await Print.printAsync({ html });
}

/** Settings → Text bridge → Station card: a printable "text Chairside" card with a QR code. */
export default function StationCardScreen() {
  const salon = useCurrentSalon();
  const isOwner = salon.role === 'owner';
  const bridge = useInboxBridge();
  const save = useUpdateBridgeSettings();
  const [phone, setPhone] = useState('');
  const [failure, setFailure] = useState<string | null>(null);

  const saved = bridge.data ?? null;
  const [loaded, setLoaded] = useState(saved);
  if (saved !== loaded) {
    setLoaded(saved);
    setPhone(saved?.phone ?? '');
  }
  const keyword = saved?.keyword?.trim() || DEFAULT_BRIDGE_KEYWORD;
  const trimmed = phone.trim();
  const digits = trimmed.replace(/\D/g, '').length;
  const valid = digits >= 7;

  return (
    <DetailScreen title="Station card">
      {bridge.isPending ? (
        <SkeletonRow />
      ) : !saved ? (
        <EmptyState
          icon="qr-code-outline"
          title="Set up the text bridge first"
          message="The card tells clients to text your keyword, so the Shortcut needs to be running."
        />
      ) : (
        <View className="gap-1">
          <Text variant="footnote" tone="muted" className="px-1">
            Put it at your station or mirror. Clients scan it and Messages opens with “{keyword}”
            already typed, so every booking text reaches your Inbox.
          </Text>
          <SectionHeader title="Your number" />
          <Input
            accessibilityLabel="Phone number clients text"
            value={phone}
            onChangeText={setPhone}
            keyboardType="phone-pad"
            textContentType="telephoneNumber"
            autoComplete="tel"
            editable={isOwner}
            placeholder="(555) 010-0199"
            helper="The iPhone that runs the Shortcut."
          />
          {isOwner && valid && trimmed !== (saved.phone ?? '') ? (
            <Button
              variant="outline"
              label="Save number"
              fullWidth
              className="mt-2"
              loading={save.isPending}
              onPress={() =>
                save.mutate(
                  { phone: trimmed },
                  {
                    onSuccess: () => setFailure(null),
                    onError: (e) => setFailure(errorMessage(e)),
                  },
                )
              }
            />
          ) : null}

          {valid ? (
            <>
              <SectionHeader title="Preview" />
              <Card className="items-center gap-2 py-6" testID="station-card">
                <Text variant="headline">{salon.name}</Text>
                <Text variant="footnote" tone="muted">
                  Book by text
                </Text>
                <Text variant="title2">“{keyword}”</Text>
                <Text variant="subhead">+ what you need, to {trimmed}</Text>
                <View className="mt-2">
                  <QrCode value={stationCardSmsUrl(trimmed, keyword)} size={180} />
                </View>
              </Card>
              <Button
                label="Print card"
                icon="print-outline"
                fullWidth
                className="mt-4"
                onPress={() =>
                  void printCard(cardHtml(salon.name, trimmed, keyword)).catch((e: unknown) =>
                    setFailure(errorMessage(e)),
                  )
                }
              />
            </>
          ) : null}
          {failure ? (
            <Text variant="footnote" tone="destructive" className="px-1 pt-4">
              {failure}
            </Text>
          ) : null}
        </View>
      )}
    </DetailScreen>
  );
}
