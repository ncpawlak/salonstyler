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
        <ListGroup>
          <ListRow
            title="Work hours"
            leading={<Icon name="time-outline" color="primary" />}
            onPress={() => router.push('/hours')}
          />
          <ListRow
            title="Services"
            subtitle="Menu, timelines and add-ons"
            leading={<Icon name="cut-outline" color="primary" />}
            onPress={() => router.push('/services')}
          />
          <ListRow
            title="AI assistant"
            subtitle="Provider, API key and monthly budget"
            leading={<Icon name="sparkles-outline" color="primary" />}
            onPress={() => router.push('/settings/ai')}
            last
          />
        </ListGroup>

        <SectionHeader title="Design previews" />
        <ListGroup>
          <ListRow
            title="Component gallery"
            leading={<Icon name="grid-outline" color="primary" />}
            onPress={() => router.push('/gallery')}
          />
          <ListRow
            title="Service builder"
            leading={<Icon name="git-commit-outline" color="primary" />}
            onPress={() => router.push('/mockups/service-builder')}
          />
          <ListRow
            title="Checkout"
            leading={<Icon name="card-outline" color="primary" />}
            onPress={() => router.push('/mockups/checkout')}
            last
          />
        </ListGroup>

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
