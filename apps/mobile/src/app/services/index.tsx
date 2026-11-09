import { formatDuration, resolveService } from '@chairside/core';
import { router } from 'expo-router';
import { Pressable, View } from 'react-native';

import { DetailScreen } from '@/components/shell/screen';
import {
  Button,
  Card,
  EmptyState,
  ListGroup,
  ListRow,
  SectionHeader,
  SkeletonRow,
  Text,
} from '@/components/ui';
import { COLOR_HEX } from '@/features/services/colors';
import { formatPrice, resolveMenuCombo, useServiceMenu } from '@/features/services/data';
import { SegmentTimeline } from '@/features/services/timeline';

export default function ServicesScreen() {
  const { data: menu, error, isPending, canEdit, refetch } = useServiceMenu();
  const services = menu?.services.filter((s) => !s.archivedAt) ?? [];
  const categories = [...new Set(services.map((s) => s.category))];
  const combos = menu?.combos.filter((c) => !c.archivedAt) ?? [];
  const addons = menu?.addons.filter((a) => !a.archivedAt) ?? [];

  return (
    <DetailScreen
      title="Services"
      right={
        canEdit ? (
          <Button
            size="sm"
            icon="add"
            label="New"
            accessibilityLabel="New service"
            onPress={() => router.push('/services/new')}
          />
        ) : null
      }
    >
      {isPending ? (
        <View className="gap-3">
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </View>
      ) : null}
      {error ? (
        <EmptyState
          icon="cloud-offline-outline"
          title="Couldn't load services"
          message={error.message}
          actionLabel="Try again"
          onAction={() => void refetch()}
        />
      ) : null}
      {menu && services.length === 0 && combos.length === 0 ? (
        <EmptyState
          icon="cut-outline"
          title="No services yet"
          message="Build your menu: each service is a timeline of busy and processing time."
          actionLabel={canEdit ? 'New service' : undefined}
          onAction={canEdit ? () => router.push('/services/new') : undefined}
        />
      ) : null}

      {categories.map((category) => (
        <View key={category}>
          <SectionHeader title={category} />
          <View className="gap-3">
            {services
              .filter((s) => s.category === category)
              .map((s) => (
                <Pressable
                  key={s.id}
                  accessibilityRole="link"
                  accessibilityLabel={s.name}
                  onPress={() => router.push({ pathname: '/services/[id]', params: { id: s.id } })}
                >
                  <Card className="gap-3">
                    <View className="flex-row items-center gap-2">
                      <View
                        style={{ backgroundColor: COLOR_HEX[s.colorTag] }}
                        className="h-2.5 w-2.5 rounded-full"
                      />
                      <Text variant="headline" className="flex-1" numberOfLines={1}>
                        {s.name}
                      </Text>
                      <Text variant="subhead" tone="muted" numeric>
                        {formatDuration(resolveService(s).totalMinutes)} ·{' '}
                        {formatPrice(s.priceCents)}
                      </Text>
                    </View>
                    <SegmentTimeline
                      segments={s.segments}
                      bufferBeforeMinutes={s.bufferBeforeMinutes}
                      bufferAfterMinutes={s.bufferAfterMinutes}
                      colorTag={s.colorTag}
                      showLabels={false}
                      height={28}
                    />
                  </Card>
                </Pressable>
              ))}
          </View>
        </View>
      ))}

      {menu && combos.length > 0 ? (
        <View>
          <SectionHeader title="Combos" />
          <View className="gap-3">
            {combos.map((c) => {
              const r = resolveMenuCombo(menu, c);
              return (
                <Card key={c.id} className="gap-3">
                  <View className="flex-row items-center gap-2">
                    <Text variant="headline" className="flex-1" numberOfLines={1}>
                      {c.name}
                    </Text>
                    <Text variant="subhead" tone="muted" numeric>
                      {formatDuration(r.totalMinutes)}
                    </Text>
                  </View>
                  <SegmentTimeline
                    segments={r.segments}
                    bufferBeforeMinutes={r.bufferBeforeMinutes}
                    bufferAfterMinutes={r.bufferAfterMinutes}
                    colorTag={c.colorTag}
                  />
                </Card>
              );
            })}
          </View>
        </View>
      ) : null}

      {addons.length > 0 ? (
        <View>
          <SectionHeader title="Add-ons" />
          <ListGroup>
            {addons.map((a, i) => (
              <ListRow
                key={a.id}
                title={a.name}
                subtitle={`+${formatDuration(a.segments.reduce((n, s) => n + s.minutes, 0))}`}
                trailing={
                  <Text variant="subhead" tone="muted" numeric>
                    {formatPrice(a.priceCents)}
                  </Text>
                }
                chevron={false}
                last={i === addons.length - 1}
              />
            ))}
          </ListGroup>
        </View>
      ) : null}
    </DetailScreen>
  );
}
