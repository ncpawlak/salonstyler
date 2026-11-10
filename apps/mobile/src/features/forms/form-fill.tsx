import {
  cleanAnswers,
  type FormAnswers,
  formAnswersError,
  type FormField,
} from '@chairside/core/forms';
import { useState } from 'react';
import { Pressable, View } from 'react-native';

import { Button, Card, Chip, Icon, Input, Text } from '@/components/ui';
import { cn } from '@/lib/cn';

import { SignaturePad } from './signature';

/** One form for the client to fill out and sign. */
export function FormFill({
  name,
  description,
  fields,
  submitting,
  serverError,
  onSubmit,
}: {
  name: string;
  description: string | null;
  fields: FormField[];
  submitting: boolean;
  serverError: string | null;
  onSubmit: (answers: FormAnswers) => void;
}) {
  const [answers, setAnswers] = useState<FormAnswers>({});
  const [error, setError] = useState<string | null>(null);
  const set = (id: string, v: FormAnswers[string]) => {
    setError(null);
    setAnswers((a) => ({ ...a, [id]: v }));
  };

  const submit = () => {
    const clean = cleanAnswers(fields, answers);
    const problem = formAnswersError(fields, clean);
    if (problem) {
      setError(problem);
      return;
    }
    onSubmit(clean);
  };

  return (
    <Card className="gap-5" testID="form-fill">
      <View className="gap-1">
        <Text variant="title3" accessibilityRole="header">
          {name}
        </Text>
        {description ? (
          <Text variant="subhead" tone="muted">
            {description}
          </Text>
        ) : null}
      </View>

      {fields.map((f) => (
        <FieldInput key={f.id} field={f} value={answers[f.id]} onChange={(v) => set(f.id, v)} />
      ))}

      {error || serverError ? (
        <Text
          variant="footnote"
          tone="destructive"
          accessibilityLiveRegion="polite"
          testID="form-error"
        >
          {error ?? serverError}
        </Text>
      ) : null}
      <Button
        label="Sign and send"
        icon="checkmark"
        fullWidth
        loading={submitting}
        onPress={submit}
        testID="form-submit"
      />
    </Card>
  );
}

function FieldLabel({ field }: { field: FormField }) {
  return (
    <View className="gap-0.5">
      <Text variant="subhead" className="font-semibold">
        {field.label}
        {field.required ? <Text tone="destructive"> *</Text> : null}
      </Text>
      {field.help ? (
        <Text variant="footnote" tone="muted">
          {field.help}
        </Text>
      ) : null}
    </View>
  );
}

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: FormField;
  value: FormAnswers[string];
  onChange: (v: FormAnswers[string]) => void;
}) {
  switch (field.kind) {
    case 'text':
      return (
        <View className="gap-2">
          <FieldLabel field={field} />
          <Input
            accessibilityLabel={field.label}
            value={typeof value === 'string' ? value : ''}
            onChangeText={onChange}
            multiline={field.multiline}
            maxLength={4000}
            testID={`field-${field.id}`}
            style={
              field.multiline
                ? ({ minHeight: 80, textAlignVertical: 'top', outlineStyle: 'none' } as object)
                : undefined
            }
          />
        </View>
      );
    case 'choice':
      return (
        <View className="gap-2">
          <FieldLabel field={field} />
          <View
            className="flex-row flex-wrap gap-2"
            accessibilityRole="radiogroup"
            accessibilityLabel={field.label}
          >
            {(field.options ?? []).map((o) => (
              <Chip
                key={o}
                label={o}
                selected={value === o}
                onPress={() => onChange(value === o && !field.required ? null : o)}
              />
            ))}
          </View>
        </View>
      );
    case 'checkbox':
      return (
        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked: value === true }}
          accessibilityLabel={field.label}
          onPress={() => onChange(value !== true)}
          className="min-h-tap flex-row items-start gap-3"
          testID={`field-${field.id}`}
        >
          <View
            className={cn(
              'mt-0.5 h-6 w-6 items-center justify-center rounded-md border',
              value === true ? 'border-primary bg-primary' : 'border-input bg-card',
            )}
          >
            {value === true ? <Icon name="checkmark" size={16} color="primary-foreground" /> : null}
          </View>
          <View className="flex-1">
            <FieldLabel field={field} />
          </View>
        </Pressable>
      );
    case 'signature':
      return (
        <View className="gap-1">
          <SignaturePad
            label={`${field.label}${field.required ? ' *' : ''}`}
            value={typeof value === 'string' ? value : null}
            onChange={onChange}
            testID={`field-${field.id}`}
          />
          {field.help ? (
            <Text variant="footnote" tone="muted">
              {field.help}
            </Text>
          ) : null}
        </View>
      );
  }
}
