import { router } from 'expo-router';
import { useState } from 'react';
import { Switch, View } from 'react-native';

import { DetailScreen } from '@/components/shell/screen';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Icon,
  Input,
  ListGroup,
  ListRow,
  SectionHeader,
  SkeletonRow,
  Text,
} from '@/components/ui';
import { errorMessage } from '@/features/appointments/api';
import {
  inboxEndpoint,
  useInboxBridge,
  useRemoveBridge,
  useRotateBridgeToken,
  useUpdateBridgeKeyword,
  useUpdateBridgeSettings,
} from '@/features/inbox/api';
import { BridgeHealthSummary } from '@/features/inbox/bridge-ui';
import { useCurrentSalon } from '@/providers/session-provider';

/** Settings → Text bridge: the token and endpoint the salon's iOS Shortcut posts texts to. */
export default function TextBridgeScreen() {
  const salon = useCurrentSalon();
  const isOwner = salon.role === 'owner';
  const bridge = useInboxBridge();
  const rotate = useRotateBridgeToken();
  const updateKeyword = useUpdateBridgeKeyword();
  const remove = useRemoveBridge();
  const settings = useUpdateBridgeSettings();

  const [token, setToken] = useState<string | null>(null);
  const [keyword, setKeyword] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const saved = bridge.data ?? null;
  const [loaded, setLoaded] = useState(saved);
  if (saved !== loaded) {
    setLoaded(saved);
    setKeyword(saved?.keyword ?? '');
  }

  const show = (message: string | null, e: unknown = null) => {
    setNotice(message);
    setFailure(e ? errorMessage(e) : null);
  };
  const busy =
    rotate.isPending || updateKeyword.isPending || remove.isPending || settings.isPending;
  const trimmed = keyword.trim();

  return (
    <DetailScreen title="Text bridge">
      {bridge.isPending ? (
        <View className="gap-3">
          <SkeletonRow />
          <SkeletonRow />
        </View>
      ) : bridge.error ? (
        <EmptyState
          icon="cloud-offline-outline"
          title="Couldn't load the text bridge"
          message={errorMessage(bridge.error)}
          actionLabel="Try again"
          onAction={() => void bridge.refetch()}
        />
      ) : (
        <View className="gap-1">
          <Card className="flex-row items-center gap-3">
            <Icon name="chatbubbles-outline" color="primary" />
            <View className="flex-1 gap-0.5">
              <Text variant="headline">Booking texts → Inbox</Text>
              <Text variant="footnote" tone="muted">
                An iPhone Shortcut forwards texts containing your keyword. Chairside reads them,
                holds a time, and waits for you to approve.
                {saved?.auto_reply
                  ? ' The Shortcut texts the client a short “got it”.'
                  : ' Nothing is sent back to the client.'}
                {
                  ' Confirmations go out when you tap Send, or on their own with auto-send in Client replies.'
                }
              </Text>
            </View>
            {saved ? <Badge label="On" tone="success" /> : <Badge label="Off" />}
          </Card>
          {!isOwner ? (
            <Text variant="footnote" tone="warning" className="px-1 pt-2">
              Only the salon owner can change these.
            </Text>
          ) : null}

          {isOwner ? (
            <Button
              label={saved ? 'Run setup again' : 'Set up in about a minute'}
              icon="phone-portrait-outline"
              variant={saved ? 'outline' : 'primary'}
              fullWidth
              className="mt-4"
              testID="bridge-start-setup"
              onPress={() => router.push('/settings/text-bridge-setup')}
            />
          ) : null}

          {saved ? (
            <>
              <SectionHeader title="Status" />
              <Card>
                <BridgeHealthSummary bridge={saved} timeZone={salon.timezone} />
              </Card>

              <SectionHeader title="Replies" />
              <Card className="flex-row items-center gap-3">
                <View className="flex-1 gap-0.5">
                  <Text variant="body">Auto-reply</Text>
                  <Text variant="footnote" tone="muted">
                    Your Shortcut texts back “Got it, we’ll confirm shortly” and teaches the keyword
                    to anyone who only sends “{saved.keyword}”.
                  </Text>
                </View>
                <Switch
                  accessibilityLabel="Auto-reply"
                  testID="bridge-auto-reply"
                  value={saved.auto_reply}
                  disabled={!isOwner || busy}
                  onValueChange={(autoReply) =>
                    settings.mutate({ autoReply }, { onError: (e) => show(null, e) })
                  }
                />
              </Card>

              <SectionHeader title="Clients" />
              <ListGroup>
                <ListRow
                  title="Station card"
                  subtitle="Printable “text Chairside” card with a QR code"
                  leading={<Icon name="qr-code-outline" color="primary" />}
                  onPress={() => router.push('/settings/station-card')}
                  last
                />
              </ListGroup>
            </>
          ) : null}

          <SectionHeader title="Endpoint" />
          <Card>
            <Text variant="subhead" selectable numberOfLines={2} testID="bridge-endpoint">
              {inboxEndpoint()}
            </Text>
          </Card>

          <SectionHeader title="Token" />
          <Card className="gap-1">
            {token ? (
              <>
                <Text variant="subhead" selectable testID="bridge-token" className="font-semibold">
                  {token}
                </Text>
                <Text variant="footnote" tone="warning">
                  Copy it into your Shortcut now. It won’t be shown again.
                </Text>
              </>
            ) : (
              <Text variant="subhead" tone="muted">
                {saved
                  ? `Token ending in ${saved.token_hint}`
                  : 'No token yet. Generate one to connect your Shortcut.'}
              </Text>
            )}
          </Card>

          {saved ? (
            <>
              <SectionHeader title="Keyword" />
              <Input
                accessibilityLabel="Keyword"
                value={keyword}
                onChangeText={setKeyword}
                autoCapitalize="none"
                autoCorrect={false}
                editable={isOwner}
                helper="Also matched with spaces or dashes, e.g. “chair side”. Your Shortcut filters on it; Chairside strips it."
              />
              {isOwner && trimmed && trimmed !== saved.keyword ? (
                <Button
                  variant="outline"
                  label="Save keyword"
                  fullWidth
                  className="mt-2"
                  loading={updateKeyword.isPending}
                  disabled={busy}
                  onPress={() =>
                    updateKeyword.mutate(trimmed, {
                      onSuccess: () =>
                        show(
                          'Keyword saved. Update your Message triggers to match (Run setup again shows how).',
                        ),
                      onError: (e) => show(null, e),
                    })
                  }
                />
              ) : null}
            </>
          ) : null}

          {notice ? (
            <Text
              variant="footnote"
              tone="success"
              className="px-1 pt-4"
              accessibilityLiveRegion="polite"
            >
              {notice}
            </Text>
          ) : null}
          {failure ? (
            <Text
              variant="footnote"
              tone="destructive"
              className="px-1 pt-4"
              accessibilityLiveRegion="polite"
            >
              {failure}
            </Text>
          ) : null}

          {isOwner ? (
            <View className="gap-3 pt-6">
              <Button
                label={saved ? 'Generate new token' : 'Generate token'}
                icon="key-outline"
                fullWidth
                loading={rotate.isPending}
                disabled={busy}
                onPress={() =>
                  rotate.mutate(undefined, {
                    onSuccess: (t) => {
                      setToken(t);
                      show(saved ? 'New token generated. The old one stopped working.' : null);
                    },
                    onError: (e) => show(null, e),
                  })
                }
              />
              {saved ? (
                <Button
                  variant="destructive"
                  label="Turn off text bridge"
                  icon="trash-outline"
                  fullWidth
                  loading={remove.isPending}
                  disabled={busy}
                  onPress={() =>
                    remove.mutate(undefined, {
                      onSuccess: () => {
                        setToken(null);
                        show('Text bridge turned off. The token no longer works.');
                      },
                      onError: (e) => show(null, e),
                    })
                  }
                />
              ) : null}
            </View>
          ) : null}
        </View>
      )}
    </DetailScreen>
  );
}
