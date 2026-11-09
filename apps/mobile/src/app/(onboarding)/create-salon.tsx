import { createSalon, isSalonSlugAvailable, isValidSalonSlug, toSalonSlug } from '@chairside/db';
import { useQuery } from '@tanstack/react-query';
import { getCalendars } from 'expo-localization';
import { useEffect, useState } from 'react';
import { Text } from 'react-native';

import { Button, ErrorText, Field, Screen } from '@/components/form';
import { supabase } from '@/lib/supabase';
import { useSession } from '@/providers/session-provider';

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

function createSalonErrorMessage(e: unknown): string {
  const err = e as { code?: string; message?: string };
  if (err.code === '23505') return 'That link is already taken. Try another.';
  if (err.code === '23514') return 'Check the salon name, link and timezone and try again.';
  return err.message ?? 'Could not create your salon. Please try again.';
}

export default function CreateSalonScreen() {
  const { user, selectSalon, refreshSalons, signOut } = useSession();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [timezone, setTimezone] = useState(() => getCalendars()[0]?.timeZone ?? 'UTC');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveSlug = slugEdited ? slug : toSalonSlug(name);
  const debouncedSlug = useDebounced(effectiveSlug, 350);
  const slugValid = isValidSalonSlug(effectiveSlug);

  const availability = useQuery({
    queryKey: ['salon-slug-available', debouncedSlug],
    queryFn: () => isSalonSlugAvailable(supabase, debouncedSlug),
    enabled: isValidSalonSlug(debouncedSlug),
    staleTime: 10_000,
  });
  const checked = debouncedSlug === effectiveSlug && availability.isSuccess;
  const slugAvailable = checked && availability.data === true;

  let slugHint: string;
  if (!effectiveSlug) slugHint = '3–40 lowercase letters, numbers or dashes.';
  else if (!slugValid)
    slugHint = 'Use 3–40 lowercase letters, numbers or dashes (some words are reserved).';
  else if (!checked) slugHint = 'Checking availability…';
  else slugHint = slugAvailable ? `✓ ${effectiveSlug} is available` : `✗ ${effectiveSlug} is taken`;

  const canSubmit = name.trim().length > 0 && slugAvailable && timezone.trim().length > 0;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const salon = await createSalon(supabase, {
        name: name.trim(),
        slug: effectiveSlug,
        timezone: timezone.trim(),
      });
      await selectSalon(salon.id);
      // Loading the new salon flips the root guard to home.
      await refreshSalons();
    } catch (e) {
      setError(createSalonErrorMessage(e));
      void availability.refetch();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen
      title="Create your salon"
      subtitle={user?.email ? `Signed in as ${user.email}` : undefined}
    >
      <Field
        label="Salon name"
        value={name}
        onChangeText={setName}
        placeholder="Studio Nova"
        autoFocus
      />
      <Field
        label="Booking link"
        value={effectiveSlug}
        onChangeText={(t) => {
          setSlugEdited(true);
          setSlug(t.toLowerCase());
        }}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="studio-nova"
        hint={
          <Text
            className={`text-sm ${checked && !slugAvailable ? 'text-red-600' : 'text-neutral-500'}`}
          >
            {slugHint}
          </Text>
        }
      />
      <Field
        label="Timezone"
        value={timezone}
        onChangeText={setTimezone}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="America/Chicago"
      />
      <ErrorText>{error}</ErrorText>
      <Button title="Create salon" onPress={submit} loading={busy} disabled={!canSubmit} />
      <Button title="Sign out" variant="link" onPress={() => void signOut()} disabled={busy} />
    </Screen>
  );
}
