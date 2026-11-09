import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Avatar, Button, Text } from '@/components/ui';
import { cn } from '@/lib/cn';
import { haptics } from '@/lib/haptics';
import { stylist } from '@/mocks/data';

import { SearchSheet } from './search-sheet';
import { useSheet } from '@/components/ui/sheet';

export type ScreenProps = {
  title: string;
  subtitle?: string;
  children: ReactNode;
  /** Content rendered between the header and the scroll area (e.g. a segmented control). */
  toolbar?: ReactNode;
  scroll?: boolean;
  className?: string;
};

/** Tab screen chrome: avatar (Settings) · large title · global search. */
export function Screen({
  title,
  subtitle,
  children,
  toolbar,
  scroll = true,
  className,
}: ScreenProps) {
  const search = useSheet();

  return (
    <SafeAreaView edges={['top']} className="flex-1 bg-background">
      {/* Phone-width column on tablets / desktop web. */}
      <View className="w-full max-w-2xl flex-1 self-center">
        <View className="flex-row items-center gap-3 px-4 pb-2 pt-2">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Settings and profile"
            hitSlop={4}
            onPress={() => {
              haptics.selection();
              router.push('/settings');
            }}
            className="rounded-full"
          >
            <Avatar name={stylist.name} size={40} />
          </Pressable>
          <View className="flex-1" />
          <Button
            variant="secondary"
            size="icon"
            icon="search"
            haptic="selection"
            accessibilityLabel="Search clients, appointments, services and products"
            onPress={search.show}
          />
        </View>
        <View className="gap-0.5 px-4 pb-3">
          <Text variant="display">{title}</Text>
          {subtitle ? (
            <Text variant="subhead" tone="muted">
              {subtitle}
            </Text>
          ) : null}
        </View>
        {toolbar ? <View className="px-4 pb-3">{toolbar}</View> : null}
        {scroll ? (
          <ScrollView
            className="flex-1"
            contentContainerClassName={cn('px-4 pb-36', className)}
            keyboardShouldPersistTaps="handled"
          >
            {children}
          </ScrollView>
        ) : (
          <View className={cn('flex-1 px-4', className)}>{children}</View>
        )}
        <SearchSheet {...search.props} />
      </View>
    </SafeAreaView>
  );
}

/** Chrome for pushed/modal screens: back/close + title. */
export function DetailScreen({
  title,
  children,
  close,
  right,
}: {
  title: string;
  children: ReactNode;
  close?: boolean;
  right?: ReactNode;
}) {
  return (
    <SafeAreaView edges={['top']} className="flex-1 bg-background">
      {/* Phone-width column on tablets / desktop web. */}
      <View className="w-full max-w-2xl flex-1 self-center">
        <View className="flex-row items-center gap-2 px-2 pb-1 pt-1">
          <Button
            variant="ghost"
            size="icon"
            icon={close ? 'close' : 'chevron-back'}
            accessibilityLabel={close ? 'Close' : 'Back'}
            haptic="selection"
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
          />
          <Text variant="headline" className="flex-1 text-center" numberOfLines={1}>
            {title}
          </Text>
          <View className="min-w-tap items-end">{right}</View>
        </View>
        <ScrollView
          className="flex-1"
          contentContainerClassName="px-4 pb-36 pt-2"
          keyboardShouldPersistTaps="handled"
        >
          {children}
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}
