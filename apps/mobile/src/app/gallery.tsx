import { useState } from 'react';
import { View } from 'react-native';

import { DetailScreen } from '@/components/shell/screen';
import {
  Avatar,
  Badge,
  Button,
  Card,
  Chip,
  Donut,
  EmptyState,
  Input,
  ListGroup,
  ListRow,
  SectionHeader,
  SegmentedControl,
  Sheet,
  Skeleton,
  SkeletonRow,
  Text,
} from '@/components/ui';
import { useTheme, type ThemePreference } from '@/theme/theme-provider';
import {
  COLOR_TOKENS,
  SERVICE_TAGS,
  elevation,
  radius,
  typography,
  type ThemeOverrides,
} from '@/theme/tokens';

const accents: { label: string; overrides: ThemeOverrides }[] = [
  { label: 'Indigo', overrides: {} },
  {
    label: 'Rose',
    overrides: {
      light: {
        primary: '#BE123C',
        ring: '#BE123C',
        'primary-soft': '#FFE4E6',
        'primary-soft-foreground': '#9F1239',
      },
      dark: {
        primary: '#FB7185',
        ring: '#FB7185',
        'primary-soft': '#4C0519',
        'primary-soft-foreground': '#FECDD3',
      },
    },
  },
  {
    label: 'Emerald',
    overrides: {
      light: {
        primary: '#047857',
        ring: '#047857',
        'primary-soft': '#D1FAE5',
        'primary-soft-foreground': '#065F46',
      },
      dark: {
        primary: '#34D399',
        ring: '#34D399',
        'primary-soft': '#022C22',
        'primary-soft-foreground': '#A7F3D0',
      },
    },
  },
];

const schemes = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
] as const;

/** Living style guide for the design system (#41). Works on web at /gallery. */
export default function GalleryScreen() {
  const { colors, preference, setPreference, setOverrides, tag } = useTheme();
  const [accent, setAccent] = useState('Indigo');
  const [segment, setSegment] = useState<'a' | 'b' | 'c'>('a');
  const [chip, setChip] = useState(true);
  const [sheet, setSheet] = useState(false);
  const [loading, setLoading] = useState(false);

  return (
    <DetailScreen title="Component gallery">
      <Text variant="subhead" tone="muted">
        Every token and component in the Chairside kit. Flip the theme and accent to check light,
        dark and branding overrides.
      </Text>

      <SectionHeader title="Theme" />
      <SegmentedControl<ThemePreference>
        accessibilityLabel="Color scheme"
        options={schemes}
        value={preference}
        onChange={setPreference}
      />
      <View className="mt-3 flex-row flex-wrap gap-2">
        {accents.map((a) => (
          <Chip
            key={a.label}
            label={a.label}
            selected={accent === a.label}
            onPress={() => {
              setAccent(a.label);
              setOverrides(a.overrides);
            }}
          />
        ))}
      </View>

      <SectionHeader title="Colors" />
      <View className="flex-row flex-wrap gap-2">
        {COLOR_TOKENS.map((t) => (
          <View key={t} className="w-[31%] gap-1">
            <View
              className="h-12 rounded-md border border-border"
              style={{ backgroundColor: colors[t] }}
            />
            <Text variant="caption" tone="muted" numberOfLines={1}>
              {t}
            </Text>
          </View>
        ))}
      </View>

      <SectionHeader title="Service tags" />
      <View className="flex-row flex-wrap gap-2">
        {SERVICE_TAGS.map((t) => (
          <View key={t} className="flex-row items-center gap-1.5">
            <View className="h-4 w-4 rounded-full" style={{ backgroundColor: tag(t).solid }} />
            <Chip label={t} tag={t} />
          </View>
        ))}
      </View>

      <SectionHeader title="Type" />
      <Card className="gap-1">
        {(Object.keys(typography) as (keyof typeof typography)[]).map((v) => (
          <Text key={v} variant={v} numberOfLines={1}>
            {v} · {typography[v].fontSize}/{typography[v].lineHeight}
          </Text>
        ))}
      </Card>

      <SectionHeader title="Radius & elevation" />
      <View className="flex-row flex-wrap gap-3">
        {(Object.keys(radius) as (keyof typeof radius)[]).map((r) => (
          <View
            key={r}
            className="h-16 w-16 items-center justify-center border border-border bg-card"
            style={{ borderRadius: radius[r] }}
          >
            <Text variant="caption">{r}</Text>
          </View>
        ))}
        {(Object.keys(elevation) as (keyof typeof elevation)[]).map((e) => (
          <Card key={e} elevation={e} className="h-16 w-16 items-center justify-center">
            <Text variant="caption">{e}</Text>
          </Card>
        ))}
      </View>

      <SectionHeader title="Buttons" />
      <View className="gap-3">
        <View className="flex-row flex-wrap gap-2">
          <Button label="Primary" />
          <Button variant="secondary" label="Secondary" />
          <Button variant="outline" label="Outline" />
          <Button variant="ghost" label="Ghost" />
          <Button variant="destructive" label="Delete" icon="trash-outline" />
        </View>
        <View className="flex-row flex-wrap items-center gap-2">
          <Button size="sm" label="Small" />
          <Button size="lg" label="Large" icon="add" />
          <Button size="icon" variant="secondary" icon="mic" accessibilityLabel="Voice" />
          <Button
            label="Loading"
            loading={loading}
            onPress={() => {
              setLoading(true);
              setTimeout(() => setLoading(false), 1500);
            }}
          />
          <Button label="Disabled" disabled />
        </View>
        <Button
          label="Open sheet"
          iconRight="chevron-up"
          fullWidth
          onPress={() => setSheet(true)}
        />
      </View>

      <SectionHeader title="Chips & badges" />
      <View className="flex-row flex-wrap items-center gap-2">
        <Chip label="Selectable" selected={chip} onPress={() => setChip(!chip)} />
        <Chip label="With icon" icon="sparkles-outline" />
        <Badge label="Neutral" />
        <Badge label="Primary" tone="primary" />
        <Badge label="Done" tone="success" />
        <Badge label="Late" tone="warning" />
        <Badge label={3} tone="destructive" />
      </View>

      <SectionHeader title="Segmented control" />
      <SegmentedControl
        accessibilityLabel="Example"
        options={[
          { value: 'a', label: 'Day' },
          { value: 'b', label: 'Week' },
          { value: 'c', label: 'Month' },
        ]}
        value={segment}
        onChange={setSegment}
      />

      <SectionHeader title="Inputs" />
      <View className="gap-3">
        <Input label="Client name" placeholder="e.g. Maya Chen" />
        <Input icon="search" placeholder="Search" accessibilityLabel="Search" />
        <Input label="Phone" helper="We text reminders here." keyboardType="phone-pad" />
        <Input label="Email" error="That doesn’t look like an email." defaultValue="maya@" />
      </View>

      <SectionHeader title="List" />
      <ListGroup>
        <ListRow
          title="Maya Chen"
          subtitle="Balayage · 3 weeks ago"
          leading={<Avatar name="Maya Chen" tag="amber" />}
        />
        <ListRow
          title="With trailing"
          trailing={<Badge label="New" tone="primary" />}
          chevron={false}
        />
        <ListRow title="Sign out" destructive last onPress={() => undefined} />
      </ListGroup>

      <SectionHeader title="Donuts" />
      <Card className="flex-row items-center justify-around">
        <Donut value={0.2} size={48} />
        <Donut value={0.55} size={56} />
        <Donut value={0.85} size={64} />
        <Donut value={1} size={72} />
      </Card>

      <SectionHeader title="Loading" />
      <Card className="gap-3">
        <SkeletonRow />
        <Skeleton height={12} width="60%" />
      </Card>

      <SectionHeader title="Empty state" />
      <Card>
        <EmptyState
          icon="calendar-clear-outline"
          title="No appointments"
          message="Enjoy the quiet, or open a few slots."
          actionLabel="Open slots"
          onAction={() => undefined}
        />
      </Card>

      <Sheet
        open={sheet}
        onOpenChange={setSheet}
        title="Bottom sheet"
        subtitle="@gorhom/bottom-sheet"
      >
        <Text variant="body" tone="muted">
          Drag down or tap the close button to dismiss.
        </Text>
        <Button label="Done" fullWidth className="mt-4" onPress={() => setSheet(false)} />
      </Sheet>
    </DetailScreen>
  );
}
