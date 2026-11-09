import { router } from 'expo-router';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BookingRulesForm } from '@/features/hours/booking-rules';
import { MonthPainter } from '@/features/hours/month-painter';
import { useWorkHoursEditor } from '@/features/hours/use-work-hours-editor';
import { WeeklySchedule } from '@/features/hours/weekly-schedule';

export default function WorkHoursScreen() {
  const editor = useWorkHoursEditor();

  return (
    <SafeAreaView className="flex-1 bg-white dark:bg-black">
      <View className="flex-row items-center justify-between px-4 py-2">
        <Text className="text-3xl font-bold text-black dark:text-white">Work hours</Text>
        {router.canGoBack() ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => router.back()}
            className="min-h-11 justify-center px-2"
          >
            <Text className="text-base font-semibold text-black dark:text-white">Done</Text>
          </Pressable>
        ) : null}
      </View>
      <ScrollView contentContainerClassName="gap-4 px-4 pb-12">
        <WeeklySchedule
          hours={editor.hours}
          applyBlanket={editor.applyBlanket}
          setWeekday={editor.setWeekday}
        />
        <MonthPainter hours={editor.hours} paint={editor.paint} reset={editor.reset} />
        <BookingRulesForm rules={editor.rules} onChange={editor.setRules} />
      </ScrollView>
    </SafeAreaView>
  );
}
