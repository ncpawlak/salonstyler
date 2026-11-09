import { AI_PROVIDERS } from '@chairside/ai';
import { Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function HomeScreen() {
  return (
    <SafeAreaView className="flex-1 bg-white dark:bg-black">
      <View className="flex-1 items-center justify-center gap-3 px-6">
        <Text className="text-4xl font-bold text-black dark:text-white">Chairside</Text>
        <Text className="text-center text-base text-neutral-500 dark:text-neutral-400">
          The AI-first booking app for independent stylists.
        </Text>
        <Text className="text-xs text-neutral-400">AI providers: {AI_PROVIDERS.join(' · ')}</Text>
      </View>
    </SafeAreaView>
  );
}
