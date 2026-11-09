import type { SearchResult, SearchResultKind } from '@chairside/db';
import { router } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { ActivityIndicator, Linking, Pressable, View } from 'react-native';

import {
  Avatar,
  Badge,
  Button,
  Card,
  EmptyState,
  Icon,
  Input,
  ListGroup,
  ListRow,
  SectionHeader,
  Sheet,
  Text,
  type IconName,
} from '@/components/ui';
import { formatDay, formatTime } from '@/features/appointments/format';
import { useRecentSearches, useSalonSearch } from '@/features/search/api';
import { serviceColor } from '@/features/today/service-pills';
import { haptics } from '@/lib/haptics';
import { useCurrentSalon } from '@/providers/session-provider';
import { useTheme } from '@/theme/theme-provider';

interface KindConfig {
  title: string;
  icon: IconName;
  subtitle: (r: SearchResult, timeZone: string) => string | undefined;
  leading: (r: SearchResult) => ReactNode;
  trailing?: (r: SearchResult) => ReactNode;
}

const STATUS_BADGE: Partial<Record<string, { label: string; tone: 'warning' | 'primary' }>> = {
  requested: { label: 'Request', tone: 'primary' },
  held: { label: 'Hold', tone: 'warning' },
};

/**
 * One entry per searchable kind; sections render in this order. Products (#17) plug in here
 * once `search_salon` returns them.
 */
const KINDS: Record<SearchResultKind, KindConfig> = {
  client: {
    title: 'Clients',
    icon: 'person-outline',
    subtitle: (r) => r.subtitle ?? undefined,
    leading: (r) => <Avatar name={r.title} size={36} />,
  },
  appointment: {
    title: 'Appointments',
    icon: 'calendar-outline',
    subtitle: (r, tz) =>
      [
        r.startsAt
          ? `${formatDay(Date.parse(r.startsAt), tz)} · ${formatTime(Date.parse(r.startsAt), tz)}`
          : null,
        r.subtitle,
      ]
        .filter(Boolean)
        .join(' · '),
    leading: (r) => <KindIcon icon="calendar-outline" color={serviceColor(r.colorTag)} />,
    trailing: (r) => {
      const badge = r.status ? STATUS_BADGE[r.status] : undefined;
      if (badge) return <Badge label={badge.label} tone={badge.tone} />;
      if (r.status === 'cancelled' || r.status === 'no_show')
        return <Badge label={r.status === 'no_show' ? 'No-show' : 'Cancelled'} />;
      return null;
    },
  },
  service: {
    title: 'Services',
    icon: 'cut-outline',
    subtitle: (r) => r.subtitle ?? undefined,
    leading: (r) => <KindIcon icon="cut-outline" color={serviceColor(r.colorTag)} />,
  },
};

const ORDER = Object.keys(KINDS) as SearchResultKind[];

function KindIcon({ icon, color }: { icon: IconName; color: string }) {
  return (
    <View
      className="h-9 w-9 items-center justify-center rounded-full"
      style={{ backgroundColor: `${color}22` }}
    >
      <Icon name={icon} size={18} color={color} />
    </View>
  );
}

function ResultRows({
  results,
  timeZone,
  onPress,
}: {
  results: SearchResult[];
  timeZone: string;
  onPress: (r: SearchResult) => void;
}) {
  return (
    <ListGroup>
      {results.map((r, i) => {
        const kind = KINDS[r.kind];
        return (
          <ListRow
            key={`${r.kind}:${r.id}`}
            title={r.title}
            subtitle={kind.subtitle(r, timeZone)}
            leading={kind.leading(r)}
            trailing={kind.trailing?.(r) ?? undefined}
            chevron
            last={i === results.length - 1}
            onPress={() => onPress(r)}
          />
        );
      })}
    </ListGroup>
  );
}

function ClientPeek({
  client,
  onBack,
  onBook,
  onProfile,
}: {
  client: SearchResult;
  onBack: () => void;
  onBook: () => void;
  onProfile: () => void;
}) {
  const phone = client.subtitle && /\d/.test(client.subtitle) ? client.subtitle : null;
  return (
    <View className="gap-4 pt-2" testID="client-peek">
      <Pressable
        accessibilityRole="button"
        onPress={onBack}
        className="flex-row items-center gap-1 self-start py-1"
      >
        <Icon name="chevron-back" size={18} color="primary" />
        <Text variant="subhead" tone="primary">
          Results
        </Text>
      </Pressable>
      <Card className="items-center gap-2 py-6">
        <Avatar name={client.title} size={64} />
        <Text variant="title2">{client.title}</Text>
        {client.subtitle ? (
          <Text variant="subhead" tone="muted" numeric>
            {client.subtitle}
          </Text>
        ) : null}
      </Card>
      <View className="flex-row gap-3">
        <Button grow icon="add" label="Book" onPress={onBook} />
        <Button
          grow
          variant="secondary"
          icon="person-outline"
          label="Profile"
          onPress={onProfile}
        />
        {phone ? (
          <Button
            grow
            variant="secondary"
            icon="call-outline"
            label="Call"
            onPress={() => void Linking.openURL(`tel:${phone.replace(/[^\d+]/g, '')}`)}
          />
        ) : null}
      </View>
    </View>
  );
}

/** Global search: clients, appointments, services. Fuzzy, instant, with recents. */
export function SearchSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const salon = useCurrentSalon();
  const { colors } = useTheme();
  const [query, setQuery] = useState('');
  const [peek, setPeek] = useState<SearchResult | null>(null);
  const search = useSalonSearch(query);
  const { recent, addQuery, addItem, clear } = useRecentSearches();
  const q = query.trim();
  const tz = salon.timezone;

  const close = () => {
    onOpenChange(false);
    setPeek(null);
    setQuery('');
  };

  const openResult = (r: SearchResult) => {
    haptics.selection();
    addItem(r);
    if (q) addQuery(q);
    switch (r.kind) {
      case 'client':
        setPeek(r);
        return;
      case 'appointment':
        close();
        router.navigate({ pathname: '/', params: { appointment: r.id } });
        return;
      case 'service':
        close();
        router.push({ pathname: '/services/[id]', params: { id: r.id } });
        return;
    }
  };

  const results = search.data ?? [];
  const showResults = q.length > 0 && search.debouncedQuery.length > 0;
  const grouped = ORDER.map((kind) => ({
    kind,
    rows: results.filter((r) => r.kind === kind),
  })).filter((g) => g.rows.length);

  let body: ReactNode;
  if (peek) {
    body = (
      <ClientPeek
        client={peek}
        onBack={() => setPeek(null)}
        onProfile={() => {
          close();
          router.push({ pathname: '/clients/[id]', params: { id: peek.id } });
        }}
        onBook={() => {
          close();
          router.navigate({
            pathname: '/',
            params: {
              bookClient: peek.id,
              bookClientName: peek.title,
              bookClientPhone: peek.subtitle ?? '',
            },
          });
        }}
      />
    );
  } else if (!showResults) {
    body =
      recent.queries.length || recent.items.length ? (
        <View testID="search-recents">
          <SectionHeader
            title="Recent"
            action={<Button variant="ghost" size="sm" label="Clear" onPress={clear} />}
          />
          {recent.queries.length ? (
            <View className="mb-3 flex-row flex-wrap gap-2">
              {recent.queries.map((rq) => (
                <Pressable
                  key={rq}
                  accessibilityRole="button"
                  accessibilityLabel={`Search ${rq}`}
                  onPress={() => setQuery(rq)}
                  className="flex-row items-center gap-1.5 rounded-full bg-muted px-3 py-1.5 active:opacity-70"
                >
                  <Icon name="time-outline" size={14} color="muted-foreground" />
                  <Text variant="subhead">{rq}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}
          {recent.items.length ? (
            <ResultRows results={recent.items} timeZone={tz} onPress={openResult} />
          ) : null}
        </View>
      ) : (
        <EmptyState
          icon="search"
          title="Find anything"
          message="Search clients by name or phone, appointments, and services."
        />
      );
  } else if (search.isError) {
    body = (
      <EmptyState
        icon="cloud-offline-outline"
        title="Search failed"
        message="Check your connection and try again."
        actionLabel="Retry"
        onAction={() => search.refetch()}
      />
    );
  } else if (!grouped.length && !search.settling) {
    body = <EmptyState icon="search" title="No matches" message={`Nothing found for “${q}”.`} />;
  } else {
    body = (
      <View testID="search-results">
        {grouped.map((g) => (
          <View key={g.kind}>
            <SectionHeader title={KINDS[g.kind].title} />
            <ResultRows results={g.rows} timeZone={tz} onPress={openResult} />
          </View>
        ))}
      </View>
    );
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => (o ? onOpenChange(true) : close())}
      title="Search"
      snapPoints={['90%']}
    >
      {peek ? null : (
        <View className="flex-row items-center gap-2">
          <View className="flex-1">
            <Input
              icon="search"
              placeholder="Name, phone, service…"
              value={query}
              onChangeText={setQuery}
              onSubmitEditing={() => addQuery(q)}
              autoFocus
              autoCorrect={false}
              autoCapitalize="none"
              returnKeyType="search"
              accessibilityLabel="Search"
              testID="search-input"
            />
          </View>
          {search.settling && q ? (
            <ActivityIndicator size="small" color={colors['muted-foreground']} />
          ) : null}
        </View>
      )}
      {body}
    </Sheet>
  );
}
