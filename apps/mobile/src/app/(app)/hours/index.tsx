import { router } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button, ErrorText } from '@/components/form';
import { BookingRulesForm } from '@/features/hours/booking-rules';
import { MonthPainter } from '@/features/hours/month-painter';
import {
  useSaveWorkHours,
  useWorkHours,
  type SavedWorkHours,
} from '@/features/hours/use-work-hours';
import { useWorkHoursEditor } from '@/features/hours/use-work-hours-editor';
import { WeeklySchedule } from '@/features/hours/weekly-schedule';
import { useCurrentSalon } from '@/providers/session-provider';

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e);
}

export default function WorkHoursScreen() {
  const salon = useCurrentSalon();
  const query = useWorkHours(salon.id);

  return (
    <SafeAreaView className="flex-1 bg-white dark:bg-black">
      <View className="flex-row items-center justify-between px-4 py-2">
        <Text className="text-3xl font-bold text-black dark:text-white">Work hours</Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
          className="min-h-11 justify-center px-2"
        >
          <Text className="text-base font-semibold text-black dark:text-white">Done</Text>
        </Pressable>
      </View>
      {query.data ? (
        // Remount on every (re)load so the editor starts from what is actually saved.
        <WorkHoursEditor
          key={query.dataUpdatedAt}
          saved={query.data}
          salonId={salon.id}
          canEdit={salon.role === 'owner'}
        />
      ) : query.isError ? (
        <View className="gap-2 px-4">
          <ErrorText>Couldn’t load work hours: {errorMessage(query.error)}</ErrorText>
          <Button title="Try again" onPress={() => void query.refetch()} />
        </View>
      ) : (
        <ActivityIndicator className="mt-8" />
      )}
    </SafeAreaView>
  );
}

function WorkHoursEditor({
  saved,
  salonId,
  canEdit,
}: {
  saved: SavedWorkHours;
  salonId: string;
  canEdit: boolean;
}) {
  const editor = useWorkHoursEditor(saved);
  const save = useSaveWorkHours(salonId);

  return (
    <>
      <ScrollView contentContainerClassName="gap-4 px-4 pb-12">
        <Text className="text-sm text-neutral-500 dark:text-neutral-400">
          Times are in {saved.hours.timeZone}.
          {canEdit ? '' : ' Only the salon owner can change work hours.'}
        </Text>
        <WeeklySchedule
          hours={editor.hours}
          applyBlanket={editor.applyBlanket}
          setWeekday={editor.setWeekday}
        />
        <MonthPainter hours={editor.hours} paint={editor.paint} reset={editor.reset} />
        <BookingRulesForm rules={editor.rules} onChange={editor.setRules} />
      </ScrollView>
      {canEdit && (editor.dirty || save.isError) ? (
        <View className="gap-2 border-t border-neutral-200 px-4 py-3 dark:border-neutral-800">
          <ErrorText>
            {save.isError ? `Couldn’t save: ${errorMessage(save.error)}` : null}
          </ErrorText>
          <View className="flex-row items-center gap-3">
            <View className="flex-1">
              <Button title="Discard" variant="link" onPress={editor.discard} />
            </View>
            <View className="flex-1">
              <Button
                title="Save"
                loading={save.isPending}
                onPress={() => save.mutate({ saved, hours: editor.hours, rules: editor.rules })}
              />
            </View>
          </View>
        </View>
      ) : null}
    </>
  );
}
