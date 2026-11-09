import { useMemo, useState } from 'react';
import { View } from 'react-native';

import { Screen } from '@/components/shell/screen';
import {
  Avatar,
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  ListGroup,
  ListRow,
  Sheet,
  Text,
} from '@/components/ui';
import { clients, type Client } from '@/mocks/data';

export default function ClientsScreen() {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Client | null>(null);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return clients
      .filter((c) => !q || c.name.toLowerCase().includes(q) || c.phone.includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [query]);

  return (
    <Screen
      title="Clients"
      subtitle={`${clients.length} clients`}
      toolbar={
        <Input
          icon="search"
          placeholder="Search by name or phone"
          value={query}
          onChangeText={setQuery}
          accessibilityLabel="Search clients"
          clearButtonMode="while-editing"
        />
      }
    >
      {filtered.length ? (
        <ListGroup>
          {filtered.map((c, i) => (
            <ListRow
              key={c.id}
              title={c.name}
              subtitle={`${c.favorite} · last visit ${c.lastVisit}`}
              leading={<Avatar name={c.name} size={40} tag={c.tag} />}
              last={i === filtered.length - 1}
              onPress={() => setSelected(c)}
            />
          ))}
        </ListGroup>
      ) : (
        <EmptyState
          icon="people-outline"
          title="No clients found"
          message={`No one matches “${query}”. Check the spelling or add them as a new client.`}
          actionLabel="Clear search"
          onAction={() => setQuery('')}
        />
      )}

      <Sheet
        open={!!selected}
        onOpenChange={(open) => !open && setSelected(null)}
        title={selected?.name}
        subtitle={selected?.phone}
      >
        {selected ? (
          <View className="gap-4">
            <View className="flex-row gap-3">
              <Card className="flex-1 gap-1">
                <Text variant="footnote" tone="muted">
                  Visits
                </Text>
                <Text variant="title2" numeric>
                  {selected.visits}
                </Text>
              </Card>
              <Card className="flex-1 gap-1">
                <Text variant="footnote" tone="muted">
                  Last visit
                </Text>
                <Text variant="title2">{selected.lastVisit}</Text>
              </Card>
            </View>
            {selected.formula ? (
              <Card className="gap-1">
                <View className="flex-row items-center gap-2">
                  <Text variant="footnote" tone="muted" className="font-semibold uppercase">
                    Color formula
                  </Text>
                  <Badge label="Latest" tone="primary" />
                </View>
                <Text variant="body">{selected.formula}</Text>
              </Card>
            ) : null}
            <View className="flex-row gap-3">
              <Button variant="secondary" label="Message" icon="chatbubble-outline" grow />
              <Button label="Book" icon="add" grow onPress={() => setSelected(null)} />
            </View>
          </View>
        ) : null}
      </Sheet>
    </Screen>
  );
}
