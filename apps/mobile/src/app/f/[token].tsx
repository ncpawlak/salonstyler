import type { PublicAppointmentForms, PublicForm } from '@chairside/db/forms';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Badge, Button, Card, EmptyState, Icon, SkeletonRow, Text } from '@/components/ui';
import { formatDay, formatTime } from '@/features/appointments/format';
import { FormFill } from '@/features/forms/form-fill';
import { usePublicAppointmentForms, useSubmitPublicForm } from '@/features/forms/api';

/**
 * A client's forms link (`/f/<token>`), from the forms email or a text. Signed out: the
 * appointment's manage token unlocks just the forms that appointment still needs, to fill out
 * and sign on their phone. Each one lands on their client profile with a timestamp.
 */
export default function ClientFormsScreen() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const view = usePublicAppointmentForms(token);

  return (
    <SafeAreaView edges={['top']} className="flex-1 bg-background">
      <View className="w-full max-w-2xl flex-1 self-center">
        {router.canGoBack() ? (
          <View className="flex-row px-2 pt-1">
            <Button
              variant="ghost"
              size="icon"
              icon="chevron-back"
              accessibilityLabel="Back"
              onPress={() => router.back()}
            />
          </View>
        ) : null}
        <ScrollView
          className="flex-1"
          contentContainerClassName="px-4 pb-24 pt-6"
          keyboardShouldPersistTaps="handled"
        >
          {view.isPending ? (
            <View className="gap-3">
              <SkeletonRow />
              <SkeletonRow />
            </View>
          ) : view.error || !view.data ? (
            <EmptyState
              icon="document-text-outline"
              title="Forms not found"
              message={
                view.error?.message ??
                'This link may be mistyped, or the appointment was cancelled. Contact the salon.'
              }
            />
          ) : (
            <FormsView token={token} data={view.data} />
          )}
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}

function FormsView({ token, data }: { token: string; data: PublicAppointmentForms }) {
  const tz = data.salon.timezone;
  const start = Date.parse(data.startsAt);
  const todo = data.forms.filter((f) => !f.done);
  const [openId, setOpenId] = useState<string | null>(null);
  const [justSigned, setJustSigned] = useState<string | null>(null);
  const open = data.forms.find((f) => f.templateId === (openId ?? todo[0]?.templateId)) ?? null;

  return (
    <View className="gap-4">
      <View className="items-center gap-1">
        <Text variant="title2" accessibilityRole="header" className="text-center">
          {data.salon.name}
        </Text>
        <Text variant="subhead" tone="muted" className="text-center">
          {data.clientFirstName ? `Hi ${data.clientFirstName}, ` : ''}
          {todo.length
            ? 'please fill out before your appointment'
            : 'you’re all set for your appointment'}
        </Text>
      </View>

      <Card className="gap-2">
        <Text variant="headline">{data.services ?? 'Appointment'}</Text>
        <View className="flex-row items-center gap-2">
          <Icon name="calendar-outline" size={18} color="muted-foreground" />
          <Text variant="body">
            {formatDay(start, tz)} · {formatTime(start, tz)}
          </Text>
        </View>
      </Card>

      {justSigned ? (
        <Text
          variant="subhead"
          tone="success"
          accessibilityLiveRegion="polite"
          testID="forms-notice"
        >
          Thanks! {justSigned} is signed and sent to the salon.
        </Text>
      ) : null}

      {data.forms.length > 1 || todo.length === 0 ? (
        <View className="gap-2" testID="forms-list">
          {data.forms.map((f) => (
            <FormRow
              key={f.templateId}
              form={f}
              tz={tz}
              active={open?.templateId === f.templateId && !f.done}
              onPress={f.done ? undefined : () => setOpenId(f.templateId)}
            />
          ))}
        </View>
      ) : null}

      {todo.length === 0 ? (
        <EmptyState
          icon="checkmark-circle-outline"
          title="All done"
          message="Your forms are signed. See you soon!"
          actionLabel="Manage appointment"
          onAction={() => router.push(`/m/${token}`)}
        />
      ) : open && !open.done ? (
        <OpenForm
          key={open.templateId}
          token={token}
          form={open}
          onSigned={() => {
            setJustSigned(open.name);
            setOpenId(null);
          }}
        />
      ) : null}
    </View>
  );
}

function FormRow({
  form,
  tz,
  active,
  onPress,
}: {
  form: PublicForm;
  tz: string;
  active: boolean;
  onPress?: () => void;
}) {
  const signedAt = form.submittedAt ? Date.parse(form.submittedAt) : null;
  return (
    <Card padded className={active ? 'border border-primary' : undefined}>
      <View className="flex-row items-center justify-between gap-3">
        <View className="flex-1 gap-0.5">
          <Text variant="headline">{form.name}</Text>
          {signedAt ? (
            <Text variant="footnote" tone="muted">
              Signed {formatDay(signedAt, tz)}
            </Text>
          ) : null}
        </View>
        {form.done ? (
          <Badge label="Signed" tone="success" />
        ) : active ? (
          <Badge label="To do" tone="warning" />
        ) : (
          <Button size="sm" variant="outline" label="Fill out" onPress={onPress} />
        )}
      </View>
    </Card>
  );
}

function OpenForm({
  token,
  form,
  onSigned,
}: {
  token: string;
  form: PublicForm;
  onSigned: () => void;
}) {
  const submit = useSubmitPublicForm(token);
  const result = submit.data;
  const serverError =
    submit.error?.message ?? (result && !result.ok ? result.message : null) ?? null;

  return (
    <FormFill
      name={form.name}
      description={form.description}
      fields={form.fields}
      submitting={submit.isPending}
      serverError={serverError}
      onSubmit={(answers) =>
        submit.mutate(
          { templateId: form.templateId, answers },
          { onSuccess: (r) => r.ok && onSigned() },
        )
      }
    />
  );
}
