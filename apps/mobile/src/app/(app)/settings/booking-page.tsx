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
  SectionHeader,
  SkeletonRow,
  Text,
} from '@/components/ui';
import { errorMessage } from '@/features/appointments/api';
import {
  bookingPageUrl,
  useBookingPageSettings,
  useUpdateBookingPageSettings,
} from '@/features/public-booking/settings-api';
import { useCurrentSalon } from '@/providers/session-provider';

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

/** Settings → Booking page: the public `/b/{slug}` page clients book from. */
export default function BookingPageSettingsScreen() {
  const salon = useCurrentSalon();
  const isOwner = salon.role === 'owner';
  const settings = useBookingPageSettings(salon.id);
  const update = useUpdateBookingPageSettings(salon.id);

  const [intro, setIntro] = useState('');
  const [faq, setFaq] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  const saved = settings.data ?? null;
  const [loaded, setLoaded] = useState(saved);
  if (saved !== loaded) {
    setLoaded(saved);
    setIntro(saved?.booking_page_intro ?? '');
    setFaq(saved?.booking_page_faq ?? '');
  }

  const url = bookingPageUrl(salon.slug);
  const textChanged =
    saved !== null &&
    (intro.trim() !== (saved.booking_page_intro ?? '') ||
      faq.trim() !== (saved.booking_page_faq ?? ''));

  const save = (changes: Parameters<typeof update.mutate>[0], message: string) =>
    update.mutate(changes, { onSuccess: () => setNotice(message) });

  return (
    <DetailScreen title="Booking page">
      {settings.isPending ? (
        <View className="gap-3">
          <SkeletonRow />
          <SkeletonRow />
        </View>
      ) : settings.error || !saved ? (
        <EmptyState
          icon="cloud-offline-outline"
          title="Couldn't load the booking page"
          message={settings.error ? errorMessage(settings.error) : undefined}
          actionLabel="Try again"
          onAction={() => void settings.refetch()}
        />
      ) : (
        <View className="gap-1">
          <Card className="flex-row items-center gap-3">
            <Icon name="globe-outline" color="primary" />
            <View className="flex-1 gap-0.5">
              <Text variant="headline">Online booking</Text>
              <Text variant="footnote" tone="muted">
                Clients pick services or ask the concierge, choose a real open time and confirm with
                an email code. Tentative hours always come to you to approve.
              </Text>
            </View>
            {saved.public_booking_enabled ? (
              <Badge label="On" tone="success" />
            ) : (
              <Badge label="Off" />
            )}
          </Card>
          {!isOwner ? (
            <Text variant="footnote" tone="warning" className="px-1 pt-2">
              Only the salon owner can change these.
            </Text>
          ) : null}

          <SectionHeader title="Link" />
          <Card className="gap-1">
            <Text variant="subhead" selectable numberOfLines={2} testID="booking-page-url">
              {url}
            </Text>
            <Text variant="footnote" tone="muted">
              Share it in your bio, texts and website. Only services marked “Bookable online” are
              shown.
            </Text>
          </Card>

          <SectionHeader title="Rules" />
          <Card className="gap-4">
            <ToggleRow
              label="Accept online bookings"
              hint="When off, the page shows that online booking is paused."
              value={saved.public_booking_enabled}
              disabled={!isOwner || update.isPending}
              onChange={(v) =>
                save(
                  { public_booking_enabled: v },
                  v ? 'Booking page is live.' : 'Booking page paused.',
                )
              }
            />
            <ToggleRow
              label="Auto-confirm bookings"
              hint="Off: every online booking is a request you approve. Tentative hours always need approval."
              value={saved.autonomy === 'auto'}
              disabled={!isOwner || update.isPending}
              onChange={(v) =>
                save(
                  { autonomy: v ? 'auto' : 'draft' },
                  v ? 'Open-hour bookings now confirm instantly.' : 'Bookings now need approval.',
                )
              }
            />
          </Card>

          <SectionHeader title="Welcome" />
          <Input
            accessibilityLabel="Welcome message"
            value={intro}
            onChangeText={setIntro}
            editable={isOwner}
            multiline
            maxLength={500}
            placeholder="Hi! Book your next visit below."
            helper="Shown at the top of your page."
          />

          <SectionHeader title="FAQ" />
          <Input
            accessibilityLabel="FAQ"
            value={faq}
            onChangeText={setFaq}
            editable={isOwner}
            multiline
            maxLength={2000}
            placeholder="Parking, cancellation policy, what to bring…"
            helper="Shown on the page. The concierge answers from this text only."
          />
          {isOwner && textChanged ? (
            <Button
              variant="outline"
              label="Save text"
              fullWidth
              className="mt-2"
              loading={update.isPending}
              onPress={() =>
                save(
                  {
                    booking_page_intro: intro.trim() || null,
                    booking_page_faq: faq.trim() || null,
                  },
                  'Saved.',
                )
              }
            />
          ) : null}

          {notice && !update.error ? (
            <Text
              variant="footnote"
              tone="success"
              className="px-1 pt-4"
              accessibilityLiveRegion="polite"
            >
              {notice}
            </Text>
          ) : null}
          {update.error ? (
            <Text
              variant="footnote"
              tone="destructive"
              className="px-1 pt-4"
              accessibilityLiveRegion="polite"
            >
              {errorMessage(update.error)}
            </Text>
          ) : null}
        </View>
      )}
    </DetailScreen>
  );
}
