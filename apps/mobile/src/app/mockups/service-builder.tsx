import { useState } from 'react';
import { View } from 'react-native';

import { SegmentTimeline, timelineSummary } from '@/components/mockups/segment-timeline';
import { DetailScreen } from '@/components/shell/screen';
import { Button, Card, Chip, Icon, Input, SectionHeader, Text } from '@/components/ui';
import { haptics } from '@/lib/haptics';
import { formatDuration, serviceById, type Segment, type SegmentKind } from '@/mocks/data';
import { SERVICE_TAGS, type ServiceTag } from '@/theme/tokens';

const kindLabel: Record<SegmentKind, string> = {
  work: 'Hands-on',
  processing: 'Processing (you’re free)',
  finish: 'Finish',
};

export default function ServiceBuilderMockup() {
  const base = serviceById('root-color');
  const [name, setName] = useState(base.name);
  const [tag, setTag] = useState<ServiceTag>(base.tag);
  const [price, setPrice] = useState(String(base.price));
  const [segments, setSegments] = useState<Segment[]>(base.segments);
  const summary = timelineSummary(segments);

  const step = (i: number, delta: number) => {
    haptics.selection();
    setSegments((segs) =>
      segs.map((s, j) => (j === i ? { ...s, minutes: Math.max(5, s.minutes + delta) } : s)),
    );
  };

  return (
    <DetailScreen title="New service" right={<Button size="sm" label="Save" haptic="success" />}>
      <View className="gap-3">
        <Input label="Name" value={name} onChangeText={setName} />
        <Input
          label="Price"
          value={price}
          onChangeText={setPrice}
          keyboardType="decimal-pad"
          icon="pricetag-outline"
        />
      </View>

      <SectionHeader title="Color" />
      <View className="flex-row flex-wrap gap-2">
        {SERVICE_TAGS.map((t) => (
          <Chip key={t} label={t} tag={t} selected={tag === t} onPress={() => setTag(t)} />
        ))}
      </View>

      <SectionHeader title="Timeline" />
      <Card className="gap-3">
        <SegmentTimeline segments={segments} tag={tag} />
        <View className="flex-row justify-between">
          <Text variant="subhead" numeric className="font-semibold">
            {formatDuration(summary.total)} total
          </Text>
          <Text variant="subhead" tone="muted" numeric>
            busy {formatDuration(summary.busy)} · free {formatDuration(summary.free)}
          </Text>
        </View>
        {summary.free ? (
          <View className="flex-row items-center gap-2 rounded-md bg-primary-soft p-2.5">
            <Icon name="sparkles" size={16} color="primary-soft-foreground" />
            <Text variant="footnote" className="flex-1 text-primary-soft-foreground">
              Chairside can book another client during the {formatDuration(summary.free)} processing
              window.
            </Text>
          </View>
        ) : null}
      </Card>

      <SectionHeader title="Steps" />
      <View className="gap-2">
        {segments.map((s, i) => (
          <Card key={`${s.label}-${i}`} className="flex-row items-center gap-3">
            <View className="flex-1">
              <Text variant="headline">{s.label}</Text>
              <Text variant="footnote" tone="muted">
                {kindLabel[s.kind]}
              </Text>
            </View>
            <Button
              size="icon"
              variant="secondary"
              icon="remove"
              accessibilityLabel={`Shorten ${s.label} by 5 minutes`}
              haptic={false}
              onPress={() => step(i, -5)}
            />
            <Text
              variant="headline"
              numeric
              className="w-14 text-center"
              accessibilityLiveRegion="polite"
            >
              {s.minutes}m
            </Text>
            <Button
              size="icon"
              variant="secondary"
              icon="add"
              accessibilityLabel={`Lengthen ${s.label} by 5 minutes`}
              haptic={false}
              onPress={() => step(i, 5)}
            />
          </Card>
        ))}
        <Button
          variant="outline"
          label="Add step"
          icon="add"
          onPress={() =>
            setSegments((segs) => [...segs, { kind: 'work', label: 'New step', minutes: 15 }])
          }
        />
      </View>
    </DetailScreen>
  );
}
