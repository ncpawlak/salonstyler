import { type ReplyDraft, type ReplyKind, templateReply } from '@chairside/ai/assistant';
import { useState } from 'react';
import { View } from 'react-native';

import { Button, Icon, Input, Sheet, Skeleton, Text } from '@/components/ui';
import { haptics } from '@/lib/haptics';
import { useCurrentSalon } from '@/providers/session-provider';

import { errorMessage } from '../appointments/api';
import { useRecordReply, useReplyDraft } from './api';
import { replySource } from './compose';
import { SEND_CHANNEL, SEND_ICON, SEND_LABEL, sendClientText } from './send';

/** Who the reply goes to and what it's about. */
export interface ReplyTarget {
  kind: ReplyKind;
  name: string;
  phone: string | null;
  requestId?: string | null;
  appointmentId?: string | null;
  clientId?: string | null;
  /** For the offline template: the appointment's start and services. */
  start?: string | null;
  services?: readonly string[];
}

const TITLE: Record<ReplyKind, string> = {
  confirm: 'Confirm by text',
  offer: 'Offer this time',
  decline: 'Let them know',
  cancelled: 'Confirm the cancellation',
  other: 'Reply',
};

export const MAX_REPLY_INPUT = 480;

/**
 * The reply editor (issue #7): Ask Chairside drafts the text, the stylist edits it if they like,
 * and Send opens Messages with it filled in. Nothing goes out without that tap.
 */
export function ReplySheet({
  target,
  onClose,
}: {
  target: ReplyTarget | null;
  onClose: () => void;
}) {
  return (
    <Sheet
      open={!!target}
      onOpenChange={(next) => !next && onClose()}
      title={target ? TITLE[target.kind] : 'Reply'}
      subtitle={target ? `To ${target.name}${target.phone ? ` · ${target.phone}` : ''}` : undefined}
    >
      {target ? (
        <ReplyEditor
          key={`${target.kind}:${target.requestId ?? ''}:${target.appointmentId ?? ''}`}
          target={target}
          onDone={onClose}
        />
      ) : null}
    </Sheet>
  );
}

function ReplyEditor({ target, onDone }: { target: ReplyTarget; onDone: () => void }) {
  const salon = useCurrentSalon();
  const drafting = useReplyDraft(target);
  const record = useRecordReply();
  const [text, setText] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fallback = (): ReplyDraft =>
    templateReply({
      kind: target.kind,
      salonName: salon.name,
      timeZone: salon.timezone,
      clientName: target.name,
      start: target.start ?? null,
      services: target.services ?? [],
    });
  const draft: ReplyDraft | null = drafting.data?.draft ?? (drafting.isError ? fallback() : null);
  const notice = drafting.isError
    ? 'Couldn’t reach Ask Chairside, so this is a standard reply.'
    : (drafting.data?.notice ?? null);
  const value = text ?? draft?.text ?? '';
  const to = target.phone ?? drafting.data?.to ?? null;

  const send = async () => {
    const body = value.trim();
    if (!body) return;
    setError(null);
    setSending(true);
    try {
      const result = await sendClientText({ to, body });
      if (result === 'cancelled') return;
      haptics.success();
      try {
        await record.mutateAsync({
          kind: target.kind,
          body,
          channel: SEND_CHANNEL,
          source: replySource(draft, body),
          toPhone: to,
          capturedRequestId: target.requestId ?? null,
          appointmentId: drafting.data?.appointmentId ?? target.appointmentId ?? null,
          clientId: drafting.data?.clientId ?? target.clientId ?? null,
        });
      } catch (e) {
        setError(`Sent, but couldn’t save it to the history: ${errorMessage(e)}`);
        return;
      }
      onDone();
    } catch (e) {
      haptics.error();
      setError(errorMessage(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <View className="gap-3" testID="reply-editor">
      {draft === null ? (
        <Skeleton height={96} />
      ) : (
        <Input
          value={value}
          onChangeText={setText}
          multiline
          numberOfLines={5}
          textAlignVertical="top"
          maxLength={MAX_REPLY_INPUT}
          accessibilityLabel={`Text to ${target.name}`}
          testID="reply-text"
        />
      )}
      <View className="flex-row items-center gap-2">
        <Icon
          name={draft?.source === 'ai' ? 'sparkles' : 'document-text-outline'}
          size={14}
          color="muted-foreground"
        />
        <Text variant="caption" tone="subtle" className="flex-1">
          {draft === null
            ? 'Drafting…'
            : draft.source === 'ai' && text === null
              ? 'Drafted by Ask Chairside. Edit anything before sending.'
              : `${value.length}/${MAX_REPLY_INPUT}`}
          {to ? '' : ' · No phone on file'}
        </Text>
      </View>
      {notice ? (
        <Text variant="footnote" tone="subtle">
          {notice}
        </Text>
      ) : null}
      {error ? (
        <Text variant="subhead" tone="destructive" accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
      <View className="flex-row gap-3">
        <Button variant="outline" label="Not now" grow onPress={onDone} />
        <Button
          label={SEND_LABEL}
          icon={SEND_ICON}
          grow
          haptic={false}
          loading={sending || record.isPending}
          disabled={!value.trim() || draft === null || sending}
          accessibilityLabel={`${SEND_LABEL} text to ${target.name}`}
          onPress={() => void send()}
        />
      </View>
    </View>
  );
}
