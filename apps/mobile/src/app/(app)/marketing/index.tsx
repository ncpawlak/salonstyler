import { addDays, parseLocalDate, toSalonDate, zonedToUtc } from '@chairside/core';
import {
  type MarketingAudience,
  type MarketingCampaign,
  type MarketingMessage,
  NUDGE_LEAD_DAY_OPTIONS,
  REVIEW_DELAY_HOUR_OPTIONS,
} from '@chairside/db/marketing';
import { useMemo, useState } from 'react';
import { Switch, View } from 'react-native';

import { DetailScreen } from '@/components/shell/screen';
import {
  Badge,
  Button,
  Card,
  Chip,
  EmptyState,
  Icon,
  Input,
  SectionHeader,
  SkeletonRow,
  Text,
} from '@/components/ui';
import { errorMessage } from '@/features/appointments/api';
import { formatDay, formatLocalDateLong, formatTime } from '@/features/appointments/format';
import {
  useApproveMarketingMessage,
  useAudienceCount,
  useCancelCampaign,
  useDismissMarketingMessage,
  useDraftCopy,
  useMarketingCampaigns,
  useMarketingDrafts,
  useMarketingHistory,
  useMarketingSettings,
  useSaveCampaign,
  useSendCampaign,
  useUpdateMarketingSettings,
} from '@/features/marketing/api';
import { useCurrentSalon } from '@/providers/session-provider';

const KIND_LABEL: Record<MarketingMessage['kind'], string> = {
  rebook_nudge: 'Time for a touch-up?',
  review_request: 'Review request',
  campaign: 'Campaign',
};

const STATUS: Record<
  MarketingMessage['status'],
  { label: string; tone?: 'primary' | 'warning' | 'success' | 'destructive' }
> = {
  draft: { label: 'Draft' },
  queued: { label: 'Sending soon', tone: 'primary' },
  sending: { label: 'Sending', tone: 'primary' },
  sent: { label: 'Sent', tone: 'success' },
  skipped: { label: 'Not sent', tone: 'warning' },
  failed: { label: 'Failed', tone: 'destructive' },
  dismissed: { label: 'Dismissed' },
};

const PLACEHOLDER_HINT =
  '{firstName}, {salonName} and {bookingLink} are filled in for each client. An unsubscribe link is added automatically.';

/**
 * Settings → Marketing (#27): "time for a touch-up?" nudges when a client is due back (from the
 * rebook engine), thank-you emails asking for a review after a visit, and campaigns to every
 * client who opted in. Nudges and review requests wait here for approval unless auto-send is on.
 */
export default function MarketingScreen() {
  return (
    <DetailScreen title="Marketing">
      <View className="gap-1">
        <Text variant="footnote" tone="muted">
          Only clients who said it’s OK to send marketing get these emails, and every one has a
          one-click unsubscribe link. Appointment emails aren’t affected.
        </Text>
        <SettingsCard />
        <DraftsSection />
        <CampaignsSection />
        <HistorySection />
      </View>
    </DetailScreen>
  );
}

// --- Settings --------------------------------------------------------------------------------

function SettingsCard() {
  const salon = useCurrentSalon();
  const isOwner = salon.role === 'owner';
  const settings = useMarketingSettings();
  const update = useUpdateMarketingSettings();
  const saved = settings.data;
  const [reviewUrl, setReviewUrl] = useState<string | null>(null);
  if (!saved) return null;
  const disabled = !isOwner || update.isPending;
  const url = reviewUrl ?? saved.marketing_review_url ?? '';
  const urlChanged = url.trim() !== (saved.marketing_review_url ?? '');

  return (
    <Card className="mt-2 gap-4" testID="marketing-settings">
      <ToggleRow
        label="Rebook nudges"
        hint="Email clients a “time for a touch-up?” note when they’re due back and haven’t booked."
        value={saved.marketing_nudges_enabled}
        disabled={disabled}
        onChange={(v) => update.mutate({ marketing_nudges_enabled: v })}
      />
      {saved.marketing_nudges_enabled ? (
        <>
          <ToggleRow
            label="Send nudges automatically"
            hint="Off: nudges wait below for you to approve. On: they go out on their own."
            value={saved.marketing_nudges_auto_send}
            disabled={disabled}
            onChange={(v) => update.mutate({ marketing_nudges_auto_send: v })}
          />
          <View className="gap-2">
            <Text variant="body">Send the nudge</Text>
            <View className="flex-row flex-wrap gap-2">
              {NUDGE_LEAD_DAY_OPTIONS.map((d) => (
                <Chip
                  key={d}
                  label={d === 0 ? 'On the day' : `${d} days before`}
                  selected={saved.marketing_nudge_lead_days === d}
                  onPress={
                    disabled ? undefined : () => update.mutate({ marketing_nudge_lead_days: d })
                  }
                />
              ))}
            </View>
          </View>
        </>
      ) : null}

      <ToggleRow
        label="Review requests"
        hint="After checkout, thank the client and ask for a review."
        value={saved.marketing_reviews_enabled}
        disabled={disabled}
        onChange={(v) => update.mutate({ marketing_reviews_enabled: v })}
      />
      <View className="gap-2">
        <Input
          label="Review link"
          placeholder="https://g.page/r/…/review"
          helper="Your Google review link (Google Business Profile → Ask for reviews)."
          autoCapitalize="none"
          keyboardType="url"
          editable={isOwner}
          value={url}
          onChangeText={setReviewUrl}
          testID="marketing-review-url"
        />
        {urlChanged ? (
          <Button
            size="sm"
            label="Save link"
            loading={update.isPending}
            onPress={() =>
              update.mutate(
                { marketing_review_url: url.trim() || null },
                { onSuccess: () => setReviewUrl(null) },
              )
            }
          />
        ) : null}
      </View>
      {saved.marketing_reviews_enabled ? (
        <>
          <ToggleRow
            label="Send review requests automatically"
            hint="Off: they wait below for you to approve. On: they go out on their own."
            value={saved.marketing_reviews_auto_send}
            disabled={disabled}
            onChange={(v) => update.mutate({ marketing_reviews_auto_send: v })}
          />
          <View className="gap-2">
            <Text variant="body">Send after checkout</Text>
            <View className="flex-row flex-wrap gap-2">
              {REVIEW_DELAY_HOUR_OPTIONS.map((h) => (
                <Chip
                  key={h}
                  label={
                    h === 0
                      ? 'Right away'
                      : h < 24
                        ? `${h} hours`
                        : `${h / 24} day${h > 24 ? 's' : ''}`
                  }
                  selected={saved.marketing_review_delay_hours === h}
                  onPress={
                    disabled ? undefined : () => update.mutate({ marketing_review_delay_hours: h })
                  }
                />
              ))}
            </View>
          </View>
        </>
      ) : null}

      {!isOwner ? (
        <Text variant="footnote" tone="warning">
          Only the salon owner can change these.
        </Text>
      ) : null}
      {update.error ? (
        <Text variant="footnote" tone="destructive">
          {errorMessage(update.error)}
        </Text>
      ) : null}
    </Card>
  );
}

function ToggleRow({
  label,
  hint,
  value,
  onChange,
  disabled,
}: {
  label: string;
  hint: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <View className="flex-row items-center gap-3">
      <View className="flex-1 gap-0.5">
        <Text variant="body">{label}</Text>
        <Text variant="footnote" tone="muted">
          {hint}
        </Text>
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

// --- Drafts to approve -----------------------------------------------------------------------

function DraftsSection() {
  const drafts = useMarketingDrafts();
  return (
    <View className="gap-2 pt-4">
      <SectionHeader title="To approve" />
      {drafts.isPending ? (
        <SkeletonRow />
      ) : drafts.error ? (
        <EmptyState
          icon="cloud-offline-outline"
          title="Couldn't load drafts"
          message={errorMessage(drafts.error)}
          actionLabel="Try again"
          onAction={() => void drafts.refetch()}
        />
      ) : drafts.data.length === 0 ? (
        <Text variant="footnote" tone="muted" testID="marketing-no-drafts">
          Nothing waiting. Nudges show up here when a client is due back, and review requests after
          checkout.
        </Text>
      ) : (
        drafts.data.map((m) => <DraftCard key={m.id} message={m} />)
      )}
    </View>
  );
}

function nudgeContext(message: MarketingMessage): string | null {
  const { serviceName, dueOn } = message.meta as { serviceName?: string; dueOn?: string };
  if (message.kind !== 'rebook_nudge' || !dueOn) return null;
  return `${serviceName ? `${serviceName} · ` : ''}due ${formatLocalDateLong(dueOn)}`;
}

function DraftCard({ message }: { message: MarketingMessage }) {
  const approve = useApproveMarketingMessage();
  const dismiss = useDismissMarketingMessage();
  const [editing, setEditing] = useState(false);
  const [subject, setSubject] = useState(message.subject);
  const [body, setBody] = useState(message.body);
  const context = nudgeContext(message);

  return (
    <Card className="gap-3" testID={`marketing-draft-${message.id}`}>
      <View className="flex-row items-start gap-3">
        <View className="flex-1 gap-0.5">
          <Text variant="headline">{message.clientName}</Text>
          <Text variant="footnote" tone="muted">
            {KIND_LABEL[message.kind]}
            {context ? ` · ${context}` : ''}
          </Text>
        </View>
        <Badge label="Draft" />
      </View>
      {editing ? (
        <View className="gap-2">
          <Input label="Subject" value={subject} onChangeText={setSubject} maxLength={150} />
          <Input
            label="Message"
            value={body}
            onChangeText={setBody}
            multiline
            maxLength={5000}
            helper={PLACEHOLDER_HINT}
          />
        </View>
      ) : (
        <View className="gap-1 rounded-lg bg-muted p-3">
          <Text variant="subhead">{subject}</Text>
          <Text variant="footnote" tone="muted" numberOfLines={6}>
            {body}
          </Text>
        </View>
      )}
      <View className="flex-row flex-wrap gap-2">
        <Button
          size="sm"
          icon="send"
          label="Approve & send"
          disabled={!subject.trim() || !body.trim()}
          loading={approve.isPending}
          onPress={() =>
            approve.mutate({
              id: message.id,
              ...(subject !== message.subject ? { subject } : {}),
              ...(body !== message.body ? { body } : {}),
            })
          }
        />
        <Button
          size="sm"
          variant="outline"
          icon={editing ? 'checkmark' : 'create-outline'}
          label={editing ? 'Done' : 'Edit'}
          onPress={() => setEditing((v) => !v)}
        />
        <Button
          size="sm"
          variant="ghost"
          label="Dismiss"
          loading={dismiss.isPending}
          onPress={() => dismiss.mutate(message.id)}
        />
      </View>
      {approve.error || dismiss.error ? (
        <Text variant="footnote" tone="destructive">
          {errorMessage(approve.error ?? dismiss.error)}
        </Text>
      ) : null}
    </Card>
  );
}

// --- Campaigns -------------------------------------------------------------------------------

const CAMPAIGN_STATUS: Record<
  MarketingCampaign['status'],
  { label: string; tone?: 'primary' | 'success' }
> = {
  draft: { label: 'Draft' },
  scheduled: { label: 'Scheduled', tone: 'primary' },
  sent: { label: 'Sent', tone: 'success' },
  cancelled: { label: 'Cancelled' },
};

function CampaignsSection() {
  const salon = useCurrentSalon();
  const campaigns = useMarketingCampaigns();
  const [editing, setEditing] = useState<MarketingCampaign | 'new' | null>(null);

  return (
    <View className="gap-2 pt-4">
      <View className="flex-row items-center justify-between">
        <SectionHeader title="Campaigns" />
        {editing ? null : (
          <Button
            size="sm"
            variant="outline"
            icon="add"
            label="New campaign"
            onPress={() => setEditing('new')}
          />
        )}
      </View>
      {editing ? (
        <CampaignEditor
          key={editing === 'new' ? 'new' : editing.id}
          campaign={editing === 'new' ? null : editing}
          onDone={() => setEditing(null)}
        />
      ) : null}
      {campaigns.isPending ? (
        <SkeletonRow />
      ) : campaigns.error ? (
        <Text variant="footnote" tone="destructive">
          {errorMessage(campaigns.error)}
        </Text>
      ) : campaigns.data.length === 0 && !editing ? (
        <Text variant="footnote" tone="muted">
          Holiday hours, a new service, a promo: write it once and it goes to every client who opted
          in.
        </Text>
      ) : (
        campaigns.data
          .filter((c) => editing === 'new' || editing?.id !== c.id)
          .map((c) => (
            <CampaignCard
              key={c.id}
              campaign={c}
              timeZone={salon.timezone}
              onEdit={() => setEditing(c)}
            />
          ))
      )}
    </View>
  );
}

function CampaignCard({
  campaign,
  timeZone,
  onEdit,
}: {
  campaign: MarketingCampaign;
  timeZone: string;
  onEdit: () => void;
}) {
  const cancel = useCancelCampaign();
  const status = CAMPAIGN_STATUS[campaign.status];
  const when = campaign.sentAt ?? campaign.sendAt;
  return (
    <Card className="gap-2" testID={`marketing-campaign-${campaign.id}`}>
      <View className="flex-row items-start gap-3">
        <View className="flex-1 gap-0.5">
          <Text variant="headline">{campaign.name}</Text>
          <Text variant="footnote" tone="muted">
            {campaign.subject}
          </Text>
          {when ? (
            <Text variant="footnote" tone="muted">
              {campaign.status === 'sent' ? 'Sent' : 'Goes out'}{' '}
              {formatDay(Date.parse(when), timeZone)} · {formatTime(Date.parse(when), timeZone)}
              {campaign.recipientCount
                ? ` · ${campaign.recipientCount} client${campaign.recipientCount === 1 ? '' : 's'}`
                : ''}
            </Text>
          ) : null}
        </View>
        <Badge label={status.label} tone={status.tone} />
      </View>
      {campaign.status === 'draft' || campaign.status === 'scheduled' ? (
        <View className="flex-row gap-2">
          {campaign.status === 'draft' ? (
            <Button size="sm" variant="outline" label="Edit" onPress={onEdit} />
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            label={campaign.status === 'draft' ? 'Delete' : 'Cancel sending'}
            loading={cancel.isPending}
            onPress={() => cancel.mutate(campaign.id)}
          />
        </View>
      ) : null}
      {cancel.error ? (
        <Text variant="footnote" tone="destructive">
          {errorMessage(cancel.error)}
        </Text>
      ) : null}
    </Card>
  );
}

const AUDIENCES: { key: string; label: string; audience: MarketingAudience }[] = [
  { key: 'all', label: 'Everyone opted in', audience: {} },
  { key: 'recent', label: 'In within 90 days', audience: { lastVisitWithinDays: 90 } },
  { key: 'lapsed', label: 'Not in for 60+ days', audience: { noVisitForDays: 60 } },
];

function audienceKey(audience: MarketingAudience): string {
  return (
    AUDIENCES.find((a) => JSON.stringify(a.audience) === JSON.stringify(audience))?.key ?? 'all'
  );
}

/** When to send: now, or 9 AM salon time on a coming day. */
function scheduleOptions(timeZone: string) {
  const today = parseLocalDate(toSalonDate(Date.now(), timeZone));
  return [
    { key: 'now', label: 'Now', at: null as string | null },
    ...[1, 3, 7].map((days) => {
      const at = zonedToUtc(addDays(today, days), 9 * 60, timeZone);
      return {
        key: `d${days}`,
        label: `${formatDay(at, timeZone)}, 9 AM`,
        at: new Date(at).toISOString(),
      };
    }),
  ];
}

function CampaignEditor({
  campaign,
  onDone,
}: {
  campaign: MarketingCampaign | null;
  onDone: () => void;
}) {
  const salon = useCurrentSalon();
  const save = useSaveCampaign();
  const send = useSendCampaign();
  const draft = useDraftCopy();
  const [name, setName] = useState(campaign?.name ?? '');
  const [brief, setBrief] = useState('');
  const [subject, setSubject] = useState(campaign?.subject ?? '');
  const [body, setBody] = useState(campaign?.body ?? '');
  const [audience, setAudience] = useState(
    audienceKey(campaign?.audience ?? {}) as (typeof AUDIENCES)[number]['key'],
  );
  const [when, setWhen] = useState('now');
  const schedule = useMemo(() => scheduleOptions(salon.timezone), [salon.timezone]);
  const chosen = AUDIENCES.find((a) => a.key === audience)!;
  const count = useAudienceCount(chosen.audience);
  const ready = name.trim() && subject.trim() && body.trim();
  const sendAt = schedule.find((s) => s.key === when)?.at ?? null;

  const input = () => ({
    id: campaign?.id ?? null,
    name: name.trim(),
    subject: subject.trim(),
    body: body.trim(),
    audience: chosen.audience,
  });

  return (
    <Card className="gap-3" testID="marketing-campaign-editor">
      <Input
        label="Name (just for you)"
        placeholder="Holiday hours"
        value={name}
        onChangeText={setName}
        maxLength={100}
      />
      <View className="gap-2 rounded-lg bg-muted p-3">
        <Input
          label="What do you want to say?"
          placeholder="Closed Dec 24–26, open late Dec 23 until 8"
          value={brief}
          onChangeText={setBrief}
          multiline
          maxLength={1000}
        />
        <Button
          size="sm"
          variant="outline"
          icon="sparkles-outline"
          label="Draft it for me"
          loading={draft.isPending}
          onPress={() =>
            draft.mutate(
              { kind: 'campaign', brief: brief.trim() || undefined },
              {
                onSuccess: (copy) => {
                  setSubject(copy.subject);
                  setBody(copy.body);
                },
              },
            )
          }
        />
        {draft.data?.source === 'template' ? (
          <Text variant="footnote" tone="muted">
            Started from a template. Set up AI in Settings → AI for a tailored draft.
          </Text>
        ) : null}
      </View>
      <Input label="Subject" value={subject} onChangeText={setSubject} maxLength={150} />
      <Input
        label="Message"
        value={body}
        onChangeText={setBody}
        multiline
        maxLength={5000}
        helper={PLACEHOLDER_HINT}
      />
      <View className="gap-2">
        <Text variant="body">Send to</Text>
        <View className="flex-row flex-wrap gap-2">
          {AUDIENCES.map((a) => (
            <Chip
              key={a.key}
              label={a.label}
              selected={a.key === audience}
              onPress={() => setAudience(a.key)}
            />
          ))}
        </View>
        <Text variant="footnote" tone="muted" testID="marketing-audience-count">
          {count.data === undefined
            ? ' '
            : `${count.data} client${count.data === 1 ? '' : 's'} with an email said OK to marketing.`}
        </Text>
      </View>
      <View className="gap-2">
        <Text variant="body">When</Text>
        <View className="flex-row flex-wrap gap-2">
          {schedule.map((s) => (
            <Chip
              key={s.key}
              label={s.label}
              selected={s.key === when}
              onPress={() => setWhen(s.key)}
            />
          ))}
        </View>
      </View>
      <View className="flex-row flex-wrap gap-2">
        <Button
          size="sm"
          icon="send"
          label={sendAt ? 'Schedule' : 'Send now'}
          disabled={!ready || count.data === 0}
          loading={save.isPending || send.isPending}
          onPress={() =>
            save.mutate(input(), {
              onSuccess: (saved) =>
                send.mutate({ id: saved.id, sendAt }, { onSuccess: () => onDone() }),
            })
          }
        />
        <Button
          size="sm"
          variant="outline"
          label="Save draft"
          disabled={!ready}
          loading={save.isPending && !send.isPending}
          onPress={() => save.mutate(input(), { onSuccess: () => onDone() })}
        />
        <Button size="sm" variant="ghost" label="Cancel" onPress={onDone} />
      </View>
      {save.error || send.error || draft.error ? (
        <Text variant="footnote" tone="destructive">
          {errorMessage(save.error ?? send.error ?? draft.error)}
        </Text>
      ) : null}
    </Card>
  );
}

// --- History ---------------------------------------------------------------------------------

function HistorySection() {
  const salon = useCurrentSalon();
  const history = useMarketingHistory();
  if (!history.data?.length) return null;
  return (
    <View className="gap-2 pt-4">
      <SectionHeader title="Recently sent" />
      <Card className="gap-3">
        {history.data.map((m) => {
          const status = STATUS[m.status];
          const at = Date.parse(m.sentAt ?? m.dueAt);
          return (
            <View
              key={m.id}
              className="flex-row items-center gap-3"
              testID={`marketing-sent-${m.id}`}
            >
              <Icon
                name={m.kind === 'review_request' ? 'star-outline' : 'mail-outline'}
                size={18}
                color="muted-foreground"
              />
              <View className="flex-1">
                <Text variant="body">{m.clientName}</Text>
                <Text variant="footnote" tone="muted">
                  {KIND_LABEL[m.kind]} · {formatDay(at, salon.timezone)}
                  {m.status === 'skipped' && m.lastError ? ` · ${m.lastError}` : ''}
                </Text>
              </View>
              <Badge label={status.label} tone={status.tone} />
            </View>
          );
        })}
      </Card>
    </View>
  );
}
