// Auth/onboarding form primitives, built on the Chairside kit (#41). Same API as the
// original #33 primitives so sign-in and create-salon pick up the design system as-is.
import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button as KitButton, Icon, Input, Text, type InputProps } from '@/components/ui';

export function Screen({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <SafeAreaView className="flex-1 bg-background">
      <KeyboardAvoidingView
        className="flex-1"
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerClassName="flex-grow justify-center"
          keyboardShouldPersistTaps="handled"
        >
          <View className="w-full max-w-md gap-4 self-center px-6 py-10">
            <View className="mb-2 h-14 w-14 items-center justify-center rounded-2xl bg-primary">
              <Icon name="cut-outline" size={28} color="primary-foreground" />
            </View>
            <View className="gap-1">
              <Text variant="title1" accessibilityRole="header">
                {title}
              </Text>
              {subtitle ? (
                <Text variant="body" tone="muted">
                  {subtitle}
                </Text>
              ) : null}
            </View>
            {children}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

export function Field({
  label,
  hint,
  ...props
}: Omit<InputProps, 'label'> & { label: string; hint?: ReactNode }) {
  return (
    <View className="gap-1.5">
      <Input label={label} {...props} />
      {typeof hint === 'string' ? (
        <Text variant="footnote" tone="muted">
          {hint}
        </Text>
      ) : (
        hint
      )}
    </View>
  );
}

export function Button({
  title,
  onPress,
  disabled,
  loading,
  variant = 'primary',
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  variant?: 'primary' | 'link';
}) {
  return (
    <KitButton
      label={title}
      onPress={onPress}
      disabled={disabled}
      loading={loading}
      variant={variant === 'link' ? 'ghost' : 'primary'}
      size={variant === 'link' ? 'md' : 'lg'}
      fullWidth
    />
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <Text variant="footnote" tone="destructive" accessibilityRole="alert">
      {children}
    </Text>
  );
}
