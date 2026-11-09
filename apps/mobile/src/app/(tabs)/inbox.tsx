import { View } from 'react-native';

import { RequestCard } from '@/components/mockups/request-card';
import { Screen } from '@/components/shell/screen';
import { EmptyState } from '@/components/ui';
import { inboxStore, usePendingRequests } from '@/mocks/inbox-store';

export default function InboxScreen() {
  const requests = usePendingRequests();

  return (
    <Screen
      title="Inbox"
      subtitle={requests.length ? `${requests.length} requests waiting for you` : 'All caught up'}
    >
      {requests.length ? (
        <View className="gap-3">
          {requests.map((r) => (
            <RequestCard key={r.id} request={r} />
          ))}
        </View>
      ) : (
        <EmptyState
          icon="file-tray-outline"
          title="Inbox zero"
          message="New booking requests from texts, Instagram and your booking page land here."
          actionLabel="Reset demo"
          onAction={inboxStore.reset}
        />
      )}
    </Screen>
  );
}
