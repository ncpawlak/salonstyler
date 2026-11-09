import { Stack, router } from 'expo-router';
import { View } from 'react-native';

import { DetailScreen } from '@/components/shell/screen';
import {
  Avatar,
  Badge,
  Card,
  Icon,
  ListGroup,
  ListRow,
  SectionHeader,
  SegmentedControl,
  Text,
} from '@/components/ui';
import { settingsRows } from '@/features/settings/registry';
import type { SettingsSection } from '@/features/settings/row';
import { useCurrentSalon, useSession } from '@/providers/session-provider';
import { useTheme, type ThemePreference } from '@/theme/theme-provider';

const appearance = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
] as const;

export default function SettingsScreen() {
  const { preference, setPreference } = useTheme();
  const salon = useCurrentSalon();
  const { user, signOut } = useSession();
  const name = user?.email ?? salon.name;

  return (
    <>
      <Stack.Screen options={{ presentation: 'modal' }} />
      <DetailScreen title="Settings" close>
        <Card className="flex-row items-center gap-3">
          <Avatar name={salon.name} size={56} />
          <View className="flex-1">
            <Text variant="title3" numberOfLines={1}>
              {salon.name}
            </Text>
            <Text variant="subhead" tone="muted" numberOfLines={1}>
              {name} · {salon.role}
            </Text>
            <Text variant="footnote" tone="subtle" numberOfLines={1}>
              chairside.app/{salon.slug} · {salon.timezone}
            </Text>
          </View>
        </Card>

        <SectionHeader title="Appearance" />
        <SegmentedControl<ThemePreference>
          accessibilityLabel="Appearance"
          options={appearance}
          value={preference}
          onChange={setPreference}
        />
        <Card className="mt-3 flex-row items-center gap-3">
          <Icon name="color-palette-outline" color="primary" />
          <View className="flex-1">
            <Text variant="headline">Branding</Text>
            <Text variant="footnote" tone="muted">
              Your colors and logo, coming soon.
            </Text>
          </View>
          <Badge label="Soon" />
        </Card>

        <SectionHeader title="Salon" />
        <SettingsRows section="salon" />

        <SectionHeader title="Design previews" />
        <SettingsRows section="previews" />
        <ListGroup className="mt-6">
          <ListRow
            title="Sign out"
            leading={<Icon name="log-out-outline" color="destructive" />}
            chevron={false}
            destructive
            onPress={() => void signOut()}
            last
          />
        </ListGroup>
      </DetailScreen>
    </>
  );
}

/** Rows come from `src/features/settings/rows/`, one file each. */
function SettingsRows({ section }: { section: SettingsSection }) {
  const rows = settingsRows(section);
  return (
    <ListGroup>
      {rows.map((row, i) => (
        <ListRow
          key={row.title}
          title={row.title}
          subtitle={row.subtitle}
          leading={<Icon name={row.icon} color="primary" />}
          onPress={() => router.push(row.href)}
          last={i === rows.length - 1}
        />
      ))}
    </ListGroup>
  );
}
