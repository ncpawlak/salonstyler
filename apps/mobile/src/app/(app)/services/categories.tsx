import { useMemo, useState } from 'react';
import { View } from 'react-native';

import { DetailScreen } from '@/components/shell/screen';
import {
  Button,
  Card,
  Chip,
  EmptyState,
  Input,
  SectionHeader,
  SkeletonRow,
  Text,
} from '@/components/ui';
import { useCategoryAction } from '@/features/services/categories';
import {
  canonicalCategory,
  categoryCounts,
  menuCategories,
  moveCategory,
} from '@/features/services/category-utils';
import { useServiceMenu } from '@/features/services/data';

type Editing = { name: string; mode: 'rename' | 'remove'; text: string } | null;

/** Owner-managed service categories (#86): add, rename, remove/merge and reorder. */
export default function ServiceCategoriesScreen() {
  const { data: menu, error, isPending, canEdit, refetch } = useServiceMenu();
  const action = useCategoryAction();
  const categories = useMemo(() => (menu ? menuCategories(menu) : []), [menu]);
  const counts = useMemo(() => (menu ? categoryCounts(menu) : new Map<string, number>()), [menu]);
  const [editing, setEditing] = useState<Editing>(null);
  const [newName, setNewName] = useState('');

  const run = (a: Parameters<typeof action.mutate>[0], after?: () => void) =>
    action.mutate(a, { onSuccess: () => after?.() });

  const add = () => {
    const name = canonicalCategory(categories, newName);
    if (!name || categories.includes(name)) return setNewName('');
    run({ type: 'add', name }, () => setNewName(''));
  };

  const rename = (from: string, text: string) => {
    const to = canonicalCategory(
      categories.filter((c) => c !== from),
      text,
    );
    if (!to || to === from) return setEditing(null);
    run({ type: 'rename', from, to }, () => setEditing(null));
  };

  return (
    <DetailScreen title="Categories">
      {isPending ? (
        <View className="gap-3">
          <SkeletonRow />
          <SkeletonRow />
        </View>
      ) : null}
      {error ? (
        <EmptyState
          icon="cloud-offline-outline"
          title="Couldn't load categories"
          message={error.message}
          actionLabel="Try again"
          onAction={() => void refetch()}
        />
      ) : null}
      {menu ? (
        <Text variant="footnote" tone="muted">
          {canEdit
            ? 'Order here is the order on your services list and booking page. Renaming moves every service in the category.'
            : 'Only the salon owner can change categories.'}
        </Text>
      ) : null}
      {action.error ? (
        <Text variant="footnote" tone="destructive" className="mt-2">
          {action.error.message}
        </Text>
      ) : null}

      {menu ? <SectionHeader title="Categories" /> : null}
      <View className="gap-3">
        {categories.map((name, i) => {
          const count = counts.get(name) ?? 0;
          const row = editing?.name === name ? editing : null;
          return (
            <Card key={name} className="gap-3">
              <View className="flex-row items-center gap-2">
                <View className="flex-1">
                  <Text variant="headline" numberOfLines={1}>
                    {name}
                  </Text>
                  <Text variant="footnote" tone="muted">
                    {count === 1 ? '1 service' : `${count} services`}
                  </Text>
                </View>
                {canEdit ? (
                  <>
                    <Button
                      variant="ghost"
                      size="icon"
                      icon="arrow-up"
                      accessibilityLabel={`Move ${name} up`}
                      disabled={i === 0 || action.isPending}
                      onPress={() =>
                        run({ type: 'reorder', names: moveCategory(categories, i, -1) })
                      }
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      icon="arrow-down"
                      accessibilityLabel={`Move ${name} down`}
                      disabled={i === categories.length - 1 || action.isPending}
                      onPress={() =>
                        run({ type: 'reorder', names: moveCategory(categories, i, 1) })
                      }
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      icon="create-outline"
                      accessibilityLabel={`Rename ${name}`}
                      onPress={() => setEditing({ name, mode: 'rename', text: name })}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      icon="trash-outline"
                      accessibilityLabel={`Remove ${name}`}
                      onPress={() => setEditing({ name, mode: 'remove', text: '' })}
                    />
                  </>
                ) : null}
              </View>

              {row?.mode === 'rename' ? (
                <View className="flex-row items-end gap-2">
                  <Input
                    className="flex-1"
                    value={row.text}
                    onChangeText={(text) => setEditing({ ...row, text })}
                    accessibilityLabel={`New name for ${name}`}
                    maxLength={40}
                    autoFocus
                    returnKeyType="done"
                    onSubmitEditing={() => rename(name, row.text)}
                  />
                  <Button
                    label="Save"
                    disabled={!row.text.trim() || action.isPending}
                    onPress={() => rename(name, row.text)}
                  />
                  <Button variant="ghost" label="Cancel" onPress={() => setEditing(null)} />
                </View>
              ) : null}

              {row?.mode === 'remove' ? (
                <View className="gap-2">
                  {count === 0 ? (
                    <Text variant="subhead">No services use {name}.</Text>
                  ) : (
                    <>
                      <Text variant="subhead">
                        Move {count === 1 ? 'its service' : `its ${count} services`} to:
                      </Text>
                      <View className="flex-row flex-wrap gap-2">
                        {categories
                          .filter((c) => c !== name)
                          .map((c) => (
                            <Chip
                              key={c}
                              label={c}
                              selected={row.text === c}
                              onPress={() => setEditing({ ...row, text: c })}
                            />
                          ))}
                      </View>
                    </>
                  )}
                  <View className="flex-row gap-2">
                    <Button
                      variant="primary"
                      label={count === 0 ? `Remove ${name}` : `Merge into ${row.text || '…'}`}
                      disabled={(count > 0 && !row.text) || action.isPending}
                      onPress={() =>
                        run(
                          { type: 'delete', name, moveTo: count > 0 ? row.text : undefined },
                          () => setEditing(null),
                        )
                      }
                    />
                    <Button variant="ghost" label="Cancel" onPress={() => setEditing(null)} />
                  </View>
                </View>
              ) : null}
            </Card>
          );
        })}
      </View>

      {canEdit ? (
        <>
          <SectionHeader title="New category" />
          <View className="flex-row items-end gap-2">
            <Input
              className="flex-1"
              value={newName}
              onChangeText={setNewName}
              placeholder="e.g. Bridal"
              accessibilityLabel="New category name"
              maxLength={40}
              returnKeyType="done"
              onSubmitEditing={add}
            />
            <Button
              label="Add"
              icon="add"
              disabled={!newName.trim() || action.isPending}
              onPress={add}
            />
          </View>
        </>
      ) : null}
    </DetailScreen>
  );
}
