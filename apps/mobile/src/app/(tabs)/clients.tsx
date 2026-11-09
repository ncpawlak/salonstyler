import type { ClientSummary } from '@chairside/db';
import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { Screen } from '@/components/shell/screen';
import {
  Avatar,
  Button,
  EmptyState,
  Input,
  ListGroup,
  ListRow,
  Sheet,
  SkeletonRow,
  Text,
} from '@/components/ui';
import { errorMessage, useAddClient } from '@/features/appointments/api';
import { useClientList } from '@/features/clients/api';
import { formatDay } from '@/features/appointments/format';
import { useDebounced } from '@/features/search/api';
import { useCurrentSalon } from '@/providers/session-provider';

function visitLine(summary: ClientSummary | null, timeZone: string): string {
  const visits = summary?.visit_count ?? 0;
  if (!visits) return summary?.next_visit_at ? 'New client' : 'No visits yet';
  const last = summary?.last_visit_at
    ? ` · last ${formatDay(Date.parse(summary.last_visit_at), timeZone)}`
    : '';
  return `${visits} visit${visits === 1 ? '' : 's'}${last}`;
}

export default function ClientsScreen() {
  const salon = useCurrentSalon();
  const [query, setQuery] = useState('');
  const search = useDebounced(query, 200);
  const list = useClientList(search);
  const [adding, setAdding] = useState(false);
  const rows = list.data ?? [];

  const open = (id: string) => router.push({ pathname: '/clients/[id]', params: { id } });

  let body;
  if (list.isPending) {
    body = (
      <ListGroup>
        <SkeletonRow />
        <SkeletonRow />
        <SkeletonRow />
      </ListGroup>
    );
  } else if (list.isError) {
    body = (
      <EmptyState
        icon="cloud-offline-outline"
        title="Couldn't load clients"
        message="Check your connection and try again."
        actionLabel="Retry"
        onAction={() => list.refetch()}
      />
    );
  } else if (rows.length) {
    body = (
      <ListGroup>
        {rows.map(({ client, summary, formulaMatch }, i) => (
          <ListRow
            key={client.id}
            title={client.name}
            subtitle={
              formulaMatch
                ? `Formula: ${formulaMatch}`
                : [visitLine(summary, salon.timezone), client.tags.join(', ')]
                    .filter(Boolean)
                    .join(' · ')
            }
            leading={<Avatar name={client.name} size={40} />}
            last={i === rows.length - 1}
            onPress={() => open(client.id)}
          />
        ))}
      </ListGroup>
    );
  } else if (search.trim()) {
    body = (
      <EmptyState
        icon="people-outline"
        title="No clients found"
        message={`No one matches “${search.trim()}” by name, phone, email or color formula.`}
        actionLabel={`Add “${search.trim()}”`}
        onAction={() => setAdding(true)}
      />
    );
  } else {
    body = (
      <EmptyState
        icon="people-outline"
        title="No clients yet"
        message="Clients you book appear here with their visits, formulas and photos."
        actionLabel="Add client"
        onAction={() => setAdding(true)}
      />
    );
  }

  return (
    <Screen
      title="Clients"
      subtitle={rows.length && !search.trim() ? `${rows.length} clients` : undefined}
      toolbar={
        <View className="flex-row items-center gap-2">
          <View className="flex-1">
            <Input
              icon="search"
              placeholder="Name, phone or formula (7N)"
              value={query}
              onChangeText={setQuery}
              accessibilityLabel="Search clients"
              clearButtonMode="while-editing"
              autoCorrect={false}
            />
          </View>
          <Button
            size="icon"
            variant="secondary"
            icon="person-add-outline"
            accessibilityLabel="Add client"
            onPress={() => setAdding(true)}
          />
        </View>
      }
    >
      {body}
      <AddClientSheet
        open={adding}
        initialName={search.trim()}
        onOpenChange={setAdding}
        onAdded={(id) => {
          setAdding(false);
          setQuery('');
          open(id);
        }}
      />
    </Screen>
  );
}

function AddClientSheet({
  open,
  initialName,
  onOpenChange,
  onAdded,
}: {
  open: boolean;
  initialName: string;
  onOpenChange: (open: boolean) => void;
  onAdded: (id: string) => void;
}) {
  const add = useAddClient();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [seeded, setSeeded] = useState(false);
  if (open && !seeded) {
    setSeeded(true);
    setName(/\d/.test(initialName) ? '' : initialName);
    setPhone(/\d/.test(initialName) ? initialName : '');
    setEmail('');
    setError(null);
  } else if (!open && seeded) {
    setSeeded(false);
  }

  const submit = async () => {
    setError(null);
    try {
      const client = await add.mutateAsync({ name: name.trim(), phone, email });
      onAdded(client.id);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="New client">
      <View className="gap-3">
        <Input label="Name" value={name} onChangeText={setName} autoFocus />
        <Input label="Phone" value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
        <Input
          label="Email"
          value={email}
          onChangeText={setEmail}
          keyboardType="email-address"
          autoCapitalize="none"
        />
        {error ? (
          <Text variant="footnote" tone="destructive">
            {error}
          </Text>
        ) : null}
        <Button
          label="Add client"
          disabled={!name.trim()}
          loading={add.isPending}
          onPress={() => void submit()}
        />
      </View>
    </Sheet>
  );
}
