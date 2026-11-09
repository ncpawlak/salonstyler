import { Text } from 'react-native';

import { Button, Screen } from '@/components/form';
import { useCurrentSalon, useSession } from '@/providers/session-provider';

// Placeholder home; #41 replaces this with the tab shell.
export default function HomeScreen() {
  const salon = useCurrentSalon();
  const { user, signOut } = useSession();

  return (
    <Screen title={salon.name} subtitle={`chairside.app/${salon.slug} · ${salon.timezone}`}>
      <Text className="text-base text-neutral-500 dark:text-neutral-400">
        Signed in as {user?.email ?? 'unknown'} ({salon.role})
      </Text>
      <Button title="Sign out" variant="link" onPress={() => void signOut()} />
    </Screen>
  );
}
