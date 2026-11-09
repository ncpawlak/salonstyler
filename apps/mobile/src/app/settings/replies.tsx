import { OUTBOX_BRIDGE_VERSION, parseBridgeVersion } from '@chairside/ai/shortcut';
import { isValidBookingLink, MAX_REPLY_TONE_EXAMPLES, type ReplySettings } from '@chairside/db';
import { router } from 'expo-router';
import { useState } from 'react';
import { Switch, View } from 'react-native';

import { DetailScreen } from '@/components/shell/screen';
import { Badge, Button, Card, EmptyState, Icon, Input, SkeletonRow, Text } from '@/components/ui';
import { errorMessage } from '@/features/appointments/api';
import { Section } from '@/features/hours/ui';
import { useInboxBridge } from '@/features/inbox/api';
import { useReplySettings, useUpdateReplySettings } from '@/features/replies/api';
import { useCurrentSalon } from '@/providers/session-provider';

interface FormState {
  autoSendReplies: boolean;
  toneExamples: string;
  bookingLink: string;
  includeBookingLink: boolean;
}

const toForm = (s: ReplySettings): FormState => ({
  autoSendReplies: s.autoSendReplies,
  toneExamples: s.toneExamples ?? '',
  bookingLink: s.bookingLink ?? '',
  includeBookingLink: s.includeBookingLink,
});

function ToggleRow({
  label,
  hint,
  value,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <View className="flex-row items-center gap-3">
      <View className="flex-1 gap-0.5">
        <Text variant="body">{label}</Text>
        {hint ? (
          <Text variant="footnote" tone="muted">
            {hint}
          </Text>
        ) : null}
      </View>
      <Switch
        accessibilityLabel={label}
        value={value}
        onValueChange={onChange}
        disabled={disabled}
      />
    </View>
  );
}

/** Settings → Client replies (issue #7): how drafted replies sound, and the opt-in auto-send. */
export default function ReplySettingsScreen() {
  const salon = useCurrentSalon();
  const isOwner = salon.role === 'owner';
  const settings = useReplySettings();
  const bridge = useInboxBridge();
  const update = useUpdateReplySettings();

  const [form, setForm] = useState<FormState | null>(null);
  const [loaded, setLoaded] = useState(settings.data);
  const [notice, setNotice] = useState<string | null>(null);
  if (settings.data && settings.data !== loaded) {
    setLoaded(settings.data);
    setForm(toForm(settings.data));
  }
  const state = form ?? (settings.data ? toForm(settings.data) : null);
  const saved = settings.data ? toForm(settings.data) : null;
  const dirty = !!state && !!saved && JSON.stringify(state) !== JSON.stringify(saved);
  const hasBridge = !!bridge.data;
  const bridgeVersion = parseBridgeVersion(bridge.data?.last_bridge_version);
  const oldShortcut = bridgeVersion !== null && bridgeVersion < OUTBOX_BRIDGE_VERSION;

  const link = state?.bookingLink.trim() ?? '';
  const linkError = link && !isValidBookingLink(link) ? 'Use a full https:// link.' : undefined;
  const linkMissing = !!state?.includeBookingLink && !link;

  const set = (patch: Partial<FormState>) => {
    setNotice(null);
    update.reset();
    setForm({ ...state!, ...patch });
  };

  const save = () =>
    update.mutate(
      {
        autoSendReplies: state!.autoSendReplies,
        toneExamples: state!.toneExamples,
        bookingLink: link,
        includeBookingLink: state!.includeBookingLink,
      },
      { onSuccess: () => setNotice('Saved.') },
    );

  return (
    <DetailScreen title="Client replies">
      {settings.isPending ? (
        <View className="gap-3">
          <SkeletonRow />
          <SkeletonRow />
        </View>
      ) : settings.error || !state ? (
        <EmptyState
          icon="cloud-offline-outline"
          title="Couldn't load reply settings"
          message={errorMessage(settings.error)}
          actionLabel="Try again"
          onAction={() => void settings.refetch()}
        />
      ) : (
        <View className="gap-4">
          <Card className="flex-row items-center gap-3">
            <Icon name="paper-plane-outline" color="primary" />
            <Text variant="footnote" tone="muted" className="flex-1">
              When you approve, decline or offer a time, Ask Chairside drafts the text. You review
              it and tap Send to open it in Messages. The AI only writes the words; nothing is sent
              without you unless you turn on auto-send.
            </Text>
          </Card>
          {!isOwner ? (
            <Text variant="footnote" tone="warning" className="px-1">
              Only the salon owner can change these.
            </Text>
          ) : null}

          <Section
            title="Auto-send"
            hint="Off by default. When on, approving a texted request (or a client replying “yes” to your offer) sends the confirmation through your text bridge Shortcut, without the editor."
          >
            <ToggleRow
              label="Send confirmations automatically"
              hint={
                !hasBridge
                  ? 'Needs the text bridge. Set it up first.'
                  : oldShortcut
                    ? `Your Shortcut is v${bridgeVersion}. Update it to v${OUTBOX_BRIDGE_VERSION} or newer (Settings → Text bridge → Run setup again); until then confirmations wait.`
                    : `Needs Chairside Bridge v${OUTBOX_BRIDGE_VERSION} or newer, which texts them with “Send Message”.`
              }
              value={state.autoSendReplies}
              disabled={!isOwner || (!hasBridge && !state.autoSendReplies)}
              onChange={(autoSendReplies) => set({ autoSendReplies })}
            />
            {!hasBridge ? (
              <Button
                variant="outline"
                size="sm"
                label="Set up text bridge"
                onPress={() => router.push('/settings/text-bridge')}
              />
            ) : state.autoSendReplies ? (
              <Badge label="Auto-send on" tone="warning" />
            ) : null}
          </Section>

          <Section
            title="Your voice"
            hint="Paste a few texts you’ve sent clients. Drafts copy the style, never the details."
          >
            <Input
              accessibilityLabel="Example texts"
              value={state.toneExamples}
              onChangeText={(toneExamples) => set({ toneExamples })}
              multiline
              numberOfLines={5}
              textAlignVertical="top"
              maxLength={MAX_REPLY_TONE_EXAMPLES}
              editable={isOwner}
              placeholder="heyy! you're all set for friday at 2, see you then 💇‍♀️"
              helper={`${state.toneExamples.length}/${MAX_REPLY_TONE_EXAMPLES}`}
            />
          </Section>

          <Section title="Booking link" hint="Added to the end of replies when turned on.">
            <Input
              accessibilityLabel="Booking link"
              value={state.bookingLink}
              onChangeText={(bookingLink) => set({ bookingLink })}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              editable={isOwner}
              placeholder="https://"
              error={linkError}
            />
            <ToggleRow
              label="Include in replies"
              value={state.includeBookingLink}
              disabled={!isOwner}
              onChange={(includeBookingLink) => set({ includeBookingLink })}
            />
            {linkMissing ? (
              <Text variant="footnote" tone="destructive">
                Add a link to include it.
              </Text>
            ) : null}
          </Section>

          {notice ? (
            <Text
              variant="footnote"
              tone="success"
              className="px-1"
              accessibilityLiveRegion="polite"
            >
              {notice}
            </Text>
          ) : null}
          {update.error ? (
            <Text
              variant="footnote"
              tone="destructive"
              className="px-1"
              accessibilityLiveRegion="polite"
            >
              {errorMessage(update.error)}
            </Text>
          ) : null}

          {isOwner ? (
            <Button
              label="Save"
              fullWidth
              loading={update.isPending}
              disabled={!dirty || !!linkError || linkMissing || update.isPending}
              onPress={save}
            />
          ) : null}
        </View>
      )}
    </DetailScreen>
  );
}
