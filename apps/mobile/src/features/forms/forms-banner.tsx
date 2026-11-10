import { router } from 'expo-router';

import { Button, Card, Text } from '@/components/ui';

import { usePublicAppointmentForms } from './api';

/** On the client's manage page: a nudge to the forms page while something is left to sign. */
export function FormsBanner({ token }: { token: string }) {
  const forms = usePublicAppointmentForms(token);
  const todo = forms.data?.forms.filter((f) => !f.done) ?? [];
  if (todo.length === 0) return null;
  return (
    <Card className="gap-3" testID="manage-forms-banner">
      <Text variant="body">
        Please fill out and sign{' '}
        {todo.length === 1 ? `the ${todo[0]!.name} form` : `${todo.length} forms`} before your
        visit.
      </Text>
      <Button
        icon="create-outline"
        label={todo.length === 1 ? 'Fill out form' : 'Fill out forms'}
        fullWidth
        onPress={() => router.push(`/f/${token}`)}
      />
    </Card>
  );
}
