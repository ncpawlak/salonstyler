import type { MarketingSubscriptionView } from '@chairside/db/marketing';
import { useMutation } from '@tanstack/react-query';
import { useLocalSearchParams } from 'expo-router';
import { useEffect, useRef } from 'react';
import { ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button, Card, EmptyState, Icon, SkeletonRow, Text } from '@/components/ui';
import { subscriptionApi } from '@/features/marketing/api';

/**
 * The unsubscribe link in every marketing email (`/u/<token>`). Signed out: the token alone
 * unsubscribes this one client from this salon's marketing, right away. Appointment emails
 * (confirmations, reminders, receipts) keep coming. They can opt back in here.
 */
export default function UnsubscribeScreen() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const api = subscriptionApi(token);
  const unsubscribe = useMutation({ mutationFn: api.unsubscribe });
  const resubscribe = useMutation({ mutationFn: api.resubscribe });
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    unsubscribe.mutate();
  }, [unsubscribe]);

  const view: MarketingSubscriptionView | undefined = (resubscribe.data ?? unsubscribe.data)
    ?.subscription;
  const error = unsubscribe.error ?? resubscribe.error;

  return (
    <SafeAreaView edges={['top']} className="flex-1 bg-background">
      <View className="w-full max-w-2xl flex-1 self-center">
        <ScrollView className="flex-1" contentContainerClassName="px-4 pb-24 pt-6">
          {unsubscribe.isPending || (!view && !error) ? (
            <View className="gap-3">
              <SkeletonRow />
            </View>
          ) : !view ? (
            <EmptyState
              icon="mail-outline"
              title="Link not found"
              message={error?.message ?? 'This link may be mistyped. Contact the salon.'}
            />
          ) : (
            <View className="gap-4">
              <Text variant="title2" accessibilityRole="header" className="text-center">
                {view.salonName}
              </Text>
              <Card className="gap-3" testID="unsubscribe-card">
                <View className="flex-row items-center gap-2">
                  <Icon
                    name={view.subscribed ? 'checkmark-circle' : 'mail-unread-outline'}
                    size={22}
                    color={view.subscribed ? 'success' : 'muted-foreground'}
                  />
                  <Text variant="headline" className="flex-1" testID="unsubscribe-status">
                    {view.subscribed ? 'You’re subscribed again' : 'You’re unsubscribed'}
                  </Text>
                </View>
                <Text variant="body" tone="muted">
                  {view.clientFirstName ? `${view.clientFirstName}, ` : ''}
                  {view.subscribed
                    ? `you’ll get news and reminders to rebook from ${view.salonName} again.`
                    : `you won’t get any more news, offers or rebooking reminders from ${view.salonName}. Emails about your appointments still come as usual.`}
                </Text>
                {view.subscribed ? (
                  <Button
                    variant="ghost"
                    label="Unsubscribe"
                    loading={unsubscribe.isPending}
                    onPress={() => {
                      resubscribe.reset();
                      unsubscribe.mutate();
                    }}
                  />
                ) : (
                  <Button
                    variant="outline"
                    label="Changed your mind? Resubscribe"
                    loading={resubscribe.isPending}
                    onPress={() => resubscribe.mutate()}
                  />
                )}
              </Card>
              {error ? (
                <Text variant="subhead" tone="destructive" accessibilityLiveRegion="polite">
                  {error.message}
                </Text>
              ) : null}
            </View>
          )}
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}
