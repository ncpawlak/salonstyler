import { answerText, type FormField } from '@chairside/core/forms';
import type { FormSubmission } from '@chairside/db/forms';
import { useState } from 'react';
import { View } from 'react-native';

import { ListGroup, ListRow, SectionHeader, Sheet, SkeletonRow, Text } from '@/components/ui';
import { formatDay, formatTime } from '@/features/appointments/format';

import { useClientFormSubmissions, useFormSubmission } from './api';
import { SignatureView } from './signature';

/** Client profile → Forms: every intake and consent form they've signed, newest first. */
export function ClientFormsSection({ clientId, timeZone }: { clientId: string; timeZone: string }) {
  const submissions = useClientFormSubmissions(clientId);
  const [openId, setOpenId] = useState<string | null>(null);
  const list = submissions.data ?? [];
  if (list.length === 0) return null;

  return (
    <View className="gap-2" testID="client-forms">
      <SectionHeader title="Forms" />
      <ListGroup>
        {list.map((s, i) => {
          const at = Date.parse(s.submitted_at);
          return (
            <ListRow
              key={s.id}
              title={s.template_name}
              subtitle={`Signed ${formatDay(at, timeZone)} at ${formatTime(at, timeZone)}`}
              chevron
              onPress={() => setOpenId(s.id)}
              last={i === list.length - 1}
            />
          );
        })}
      </ListGroup>
      <SubmissionSheet id={openId} timeZone={timeZone} onClose={() => setOpenId(null)} />
    </View>
  );
}

function SubmissionSheet({
  id,
  timeZone,
  onClose,
}: {
  id: string | null;
  timeZone: string;
  onClose: () => void;
}) {
  const submission = useFormSubmission(id);
  const s = submission.data;
  return (
    <Sheet
      open={id !== null}
      onOpenChange={(open) => !open && onClose()}
      title={s?.template_name ?? 'Form'}
      subtitle={
        s
          ? `Signed ${formatDay(Date.parse(s.submitted_at), timeZone)} at ${formatTime(Date.parse(s.submitted_at), timeZone)}`
          : undefined
      }
    >
      {!s ? <SkeletonRow /> : <Answers submission={s} />}
    </Sheet>
  );
}

function Answers({ submission }: { submission: FormSubmission }) {
  return (
    <View className="gap-4" testID="form-submission">
      {submission.fields.map((f: FormField) => {
        const value = submission.answers[f.id];
        return (
          <View key={f.id} className="gap-1">
            <Text variant="footnote" tone="muted" className="font-medium">
              {f.label}
            </Text>
            {f.kind === 'signature' && typeof value === 'string' ? (
              <SignatureView path={value} />
            ) : (
              <Text variant="body" tone={value == null ? 'subtle' : 'default'}>
                {answerText(f, value)}
              </Text>
            )}
          </View>
        );
      })}
    </View>
  );
}
