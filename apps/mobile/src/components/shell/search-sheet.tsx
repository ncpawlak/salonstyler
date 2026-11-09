import { useMemo, useState } from 'react';
import { View } from 'react-native';

import {
  Avatar,
  EmptyState,
  Input,
  ListGroup,
  ListRow,
  SectionHeader,
  Sheet,
} from '@/components/ui';
import { clients, formatTime, services, todayAppointments } from '@/mocks/data';

export function SearchSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();

  const results = useMemo(() => {
    if (!q) return null;
    return {
      clients: clients.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 4),
      appointments: todayAppointments.filter(
        (a) => a.status !== 'blocked' && a.client.toLowerCase().includes(q),
      ),
      services: services.filter((s) => s.name.toLowerCase().includes(q)),
    };
  }, [q]);

  const empty =
    results && !results.clients.length && !results.appointments.length && !results.services.length;

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Search" snapPoints={['90%']}>
      <Input
        icon="search"
        placeholder="Clients, appointments, services, products"
        value={query}
        onChangeText={setQuery}
        autoFocus
        returnKeyType="search"
        accessibilityLabel="Search"
      />
      {!results ? (
        <View className="pt-2">
          <SectionHeader title="Recent" />
          <ListGroup>
            {clients.slice(0, 3).map((c, i) => (
              <ListRow
                key={c.id}
                title={c.name}
                subtitle={`Last visit ${c.lastVisit}`}
                leading={<Avatar name={c.name} size={32} tag={c.tag} />}
                last={i === 2}
                onPress={() => onOpenChange(false)}
              />
            ))}
          </ListGroup>
        </View>
      ) : empty ? (
        <EmptyState icon="search" title="No matches" message={`Nothing found for “${query}”.`} />
      ) : (
        <View>
          {results.clients.length ? (
            <>
              <SectionHeader title="Clients" />
              <ListGroup>
                {results.clients.map((c, i, arr) => (
                  <ListRow
                    key={c.id}
                    title={c.name}
                    subtitle={c.phone}
                    leading={<Avatar name={c.name} size={32} tag={c.tag} />}
                    last={i === arr.length - 1}
                    onPress={() => onOpenChange(false)}
                  />
                ))}
              </ListGroup>
            </>
          ) : null}
          {results.appointments.length ? (
            <>
              <SectionHeader title="Today" />
              <ListGroup>
                {results.appointments.map((a, i, arr) => (
                  <ListRow
                    key={a.id}
                    title={a.client}
                    subtitle={formatTime(a.start)}
                    last={i === arr.length - 1}
                    onPress={() => onOpenChange(false)}
                  />
                ))}
              </ListGroup>
            </>
          ) : null}
          {results.services.length ? (
            <>
              <SectionHeader title="Services" />
              <ListGroup>
                {results.services.map((s, i, arr) => (
                  <ListRow
                    key={s.id}
                    title={s.name}
                    subtitle={`$${s.price}`}
                    last={i === arr.length - 1}
                    onPress={() => onOpenChange(false)}
                  />
                ))}
              </ListGroup>
            </>
          ) : null}
        </View>
      )}
    </Sheet>
  );
}
