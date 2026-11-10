import {
  FIELD_KIND_LABELS,
  FIELD_KINDS,
  type FormField,
  type FormFieldKind,
  formFieldsError,
  MAX_FORM_DESCRIPTION,
  MAX_FORM_NAME,
  MAX_HELP,
  MAX_LABEL,
  newField,
  VALIDITY_PRESETS,
} from '@chairside/core/forms';
import type { FormTemplate } from '@chairside/db/forms';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Switch, View } from 'react-native';

import { DetailScreen } from '@/components/shell/screen';
import {
  Badge,
  Button,
  Card,
  Chip,
  EmptyState,
  Input,
  SectionHeader,
  SkeletonRow,
  Text,
} from '@/components/ui';
import { errorMessage } from '@/features/appointments/api';
import { useDeleteFormTemplate, useFormTemplate, useSaveFormTemplate } from '@/features/forms/api';
import { useCurrentSalon } from '@/providers/session-provider';

const KIND_ICONS = {
  text: 'create-outline',
  choice: 'list-outline',
  checkbox: 'checkbox-outline',
  signature: 'finger-print-outline',
} as const satisfies Record<FormFieldKind, string>;

/** Settings → Forms → a form: name, how often it's asked, and its questions. */
export default function FormEditorScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const isNew = id === 'new';
  const template = useFormTemplate(isNew ? undefined : id);

  if (!isNew && template.isPending) {
    return (
      <DetailScreen title="Form">
        <SkeletonRow />
      </DetailScreen>
    );
  }
  if (!isNew && !template.data) {
    return (
      <DetailScreen title="Form">
        <EmptyState
          icon="document-text-outline"
          title="Form not found"
          message={template.error ? errorMessage(template.error) : 'It may have been deleted.'}
        />
      </DetailScreen>
    );
  }
  return <FormEditor key={id} existing={template.data ?? null} />;
}

type Draft = {
  name: string;
  description: string;
  validDays: number | null;
  askNewClients: boolean;
  fields: FormField[];
};

const blank: Draft = {
  name: '',
  description: '',
  validDays: null,
  askNewClients: false,
  fields: [{ id: 'signature', kind: 'signature', label: 'Signature', required: true }],
};

/** Options are edited one per line; blank lines only drop out on save. */
const tidy = (fields: FormField[]): FormField[] =>
  fields.map((f) => {
    const out: FormField = { ...f, label: f.label.trim() };
    if (f.help?.trim()) out.help = f.help.trim();
    else delete out.help;
    if (f.kind === 'choice') out.options = (f.options ?? []).map((o) => o.trim()).filter(Boolean);
    return out;
  });

function FormEditor({ existing }: { existing: FormTemplate | null }) {
  const salon = useCurrentSalon();
  const canEdit = salon.role === 'owner';
  const save = useSaveFormTemplate(salon.id);
  const remove = useDeleteFormTemplate();
  const [draft, setDraft] = useState<Draft>(() =>
    existing
      ? {
          name: existing.name,
          description: existing.description ?? '',
          validDays: existing.valid_days,
          askNewClients: existing.ask_new_clients,
          fields: existing.fields,
        }
      : blank,
  );
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const set = (changes: Partial<Draft>) => setDraft((d) => ({ ...d, ...changes }));
  const setField = (i: number, changes: Partial<FormField>) =>
    set({ fields: draft.fields.map((f, j) => (j === i ? { ...f, ...changes } : f)) });
  const move = (i: number, by: -1 | 1) => {
    const next = [...draft.fields];
    const [f] = next.splice(i, 1);
    next.splice(i + by, 0, f!);
    set({ fields: next });
  };
  const done = () => (router.canGoBack() ? router.back() : router.replace('/settings/forms'));

  const onSave = () => {
    const name = draft.name.trim();
    if (!name) return setError('Give the form a name.');
    const fields = tidy(draft.fields);
    const problem = formFieldsError(fields);
    if (problem) return setError(problem);
    setError(null);
    save.mutate(
      {
        id: existing?.id ?? null,
        input: {
          name,
          description: draft.description.trim() || null,
          fields,
          ask_new_clients: draft.askNewClients,
          valid_days: draft.validDays,
        },
      },
      { onSuccess: done, onError: (e) => setError(errorMessage(e)) },
    );
  };

  return (
    <DetailScreen
      title={existing ? (canEdit ? 'Edit form' : draft.name) : 'New form'}
      close={!existing}
    >
      {!canEdit ? (
        <Card className="mb-2">
          <Text variant="footnote" tone="muted">
            Only the salon owner can edit forms.
          </Text>
        </Card>
      ) : null}

      <View className="gap-3">
        <Input
          label="Name"
          value={draft.name}
          onChangeText={(name) => set({ name })}
          placeholder="e.g. Lash lift consent"
          maxLength={MAX_FORM_NAME}
          editable={canEdit}
        />
        <Input
          label="Intro (optional)"
          value={draft.description}
          onChangeText={(description) => set({ description })}
          placeholder="Shown at the top of the form"
          maxLength={MAX_FORM_DESCRIPTION}
          multiline
          editable={canEdit}
        />
      </View>

      <SectionHeader title="Who signs it" />
      <Card className="gap-4">
        <View className="flex-row items-center gap-3">
          <View className="flex-1 gap-0.5">
            <Text variant="body">Ask every new client</Text>
            <Text variant="footnote" tone="muted">
              Their first visit, whatever they book. To ask before a service, turn the form on in
              that service’s settings.
            </Text>
          </View>
          <Switch
            accessibilityLabel="Ask every new client"
            value={draft.askNewClients}
            disabled={!canEdit}
            onValueChange={(askNewClients) => set({ askNewClients })}
          />
        </View>
        <View className="gap-2">
          <Text variant="footnote" tone="muted" className="font-medium">
            How often
          </Text>
          <View className="flex-row flex-wrap gap-2">
            {VALIDITY_PRESETS.map((p) => (
              <Chip
                key={p.label}
                label={p.label}
                selected={draft.validDays === p.days}
                onPress={canEdit ? () => set({ validDays: p.days }) : undefined}
              />
            ))}
          </View>
          <Text variant="footnote" tone="muted">
            {draft.validDays === null
              ? 'Signed once, it counts for every later visit.'
              : draft.validDays === 0
                ? 'Signed again before each visit.'
                : 'Signed again once the last one is older than this.'}
          </Text>
        </View>
      </Card>

      <SectionHeader title={`Questions · ${draft.fields.length}`} />
      <View className="gap-3">
        {draft.fields.map((f, i) => (
          <FieldEditor
            key={f.id}
            field={f}
            canEdit={canEdit}
            first={i === 0}
            last={i === draft.fields.length - 1}
            onChange={(changes) => setField(i, changes)}
            onMove={(by) => move(i, by)}
            onRemove={() => set({ fields: draft.fields.filter((_, j) => j !== i) })}
          />
        ))}
        {canEdit ? (
          <View className="flex-row flex-wrap gap-2">
            {FIELD_KINDS.map((k) => (
              <Button
                key={k}
                variant="outline"
                size="sm"
                icon={KIND_ICONS[k]}
                label={FIELD_KIND_LABELS[k]}
                accessibilityLabel={`Add ${FIELD_KIND_LABELS[k].toLowerCase()} question`}
                onPress={() => set({ fields: [...draft.fields, newField(k, draft.fields)] })}
              />
            ))}
          </View>
        ) : null}
      </View>

      {error || save.error ? (
        <Text
          variant="footnote"
          tone="destructive"
          className="pt-4"
          accessibilityLiveRegion="polite"
        >
          {error ?? errorMessage(save.error)}
        </Text>
      ) : null}
      {canEdit ? (
        <View className="gap-2 pt-4">
          <Button label="Save form" fullWidth loading={save.isPending} onPress={onSave} />
          {existing ? (
            confirmDelete ? (
              <Card className="gap-3">
                <Text variant="body">
                  Delete this form? Signed copies stay on clients’ profiles.
                </Text>
                {remove.error ? (
                  <Text variant="footnote" tone="destructive">
                    {errorMessage(remove.error)}
                  </Text>
                ) : null}
                <View className="flex-row gap-2">
                  <Button
                    grow
                    variant="outline"
                    label="Keep"
                    onPress={() => setConfirmDelete(false)}
                  />
                  <Button
                    grow
                    variant="destructive"
                    label="Delete"
                    loading={remove.isPending}
                    onPress={() => remove.mutate(existing.id, { onSuccess: done })}
                  />
                </View>
              </Card>
            ) : (
              <Button
                variant="ghost"
                label="Delete form"
                fullWidth
                onPress={() => setConfirmDelete(true)}
              />
            )
          ) : null}
        </View>
      ) : null}
    </DetailScreen>
  );
}

function FieldEditor({
  field,
  canEdit,
  first,
  last,
  onChange,
  onMove,
  onRemove,
}: {
  field: FormField;
  canEdit: boolean;
  first: boolean;
  last: boolean;
  onChange: (changes: Partial<FormField>) => void;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
}) {
  const name = field.label || FIELD_KIND_LABELS[field.kind];
  return (
    <Card className="gap-3" testID={`form-field-${field.id}`}>
      <View className="flex-row items-center gap-1">
        <View className="flex-1 flex-row">
          <Badge label={FIELD_KIND_LABELS[field.kind]} />
        </View>
        {canEdit ? (
          <>
            <Button
              variant="ghost"
              size="icon"
              icon="arrow-up"
              accessibilityLabel={`Move ${name} up`}
              disabled={first}
              onPress={() => onMove(-1)}
            />
            <Button
              variant="ghost"
              size="icon"
              icon="arrow-down"
              accessibilityLabel={`Move ${name} down`}
              disabled={last}
              onPress={() => onMove(1)}
            />
            <Button
              variant="ghost"
              size="icon"
              icon="trash-outline"
              accessibilityLabel={`Remove ${name}`}
              onPress={onRemove}
            />
          </>
        ) : null}
      </View>
      <Input
        label={field.kind === 'checkbox' ? 'Statement to tick' : 'Question'}
        value={field.label}
        onChangeText={(label) => onChange({ label })}
        placeholder={
          field.kind === 'checkbox'
            ? 'e.g. I understand results may vary'
            : field.kind === 'signature'
              ? 'Signature'
              : 'e.g. Any allergies?'
        }
        maxLength={MAX_LABEL}
        editable={canEdit}
      />
      {field.kind === 'choice' ? (
        <Input
          label="Options (one per line)"
          value={(field.options ?? []).join('\n')}
          onChangeText={(t) => onChange({ options: t.split('\n') })}
          multiline
          editable={canEdit}
        />
      ) : null}
      <Input
        label="Hint (optional)"
        value={field.help ?? ''}
        onChangeText={(help) => onChange({ help })}
        maxLength={MAX_HELP}
        editable={canEdit}
      />
      <View className="flex-row flex-wrap gap-2">
        <Chip
          label="Required"
          icon={field.required ? 'checkmark' : undefined}
          selected={!!field.required}
          onPress={canEdit ? () => onChange({ required: !field.required }) : undefined}
        />
        {field.kind === 'text' ? (
          <Chip
            label="Long answer"
            icon={field.multiline ? 'checkmark' : undefined}
            selected={!!field.multiline}
            onPress={canEdit ? () => onChange({ multiline: !field.multiline }) : undefined}
          />
        ) : null}
      </View>
    </Card>
  );
}
