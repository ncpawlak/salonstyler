// Minimal form primitives for auth/onboarding. #41 (design system) will restyle these.
import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from 'react-native';

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
    <View className="flex-1 bg-white dark:bg-black">
      <View className="w-full max-w-md flex-1 justify-center gap-4 self-center px-6">
        <Text className="text-3xl font-bold text-black dark:text-white">{title}</Text>
        {subtitle ? (
          <Text className="text-base text-neutral-500 dark:text-neutral-400">{subtitle}</Text>
        ) : null}
        {children}
      </View>
    </View>
  );
}

export function Field({
  label,
  hint,
  ...props
}: TextInputProps & { label: string; hint?: ReactNode }) {
  return (
    <View className="gap-1">
      <Text className="text-sm font-medium text-neutral-700 dark:text-neutral-300">{label}</Text>
      <TextInput
        accessibilityLabel={label}
        className="rounded-lg border border-neutral-300 px-3 py-3 text-base text-black dark:border-neutral-700 dark:text-white"
        placeholderTextColor="#a3a3a3"
        {...props}
      />
      {hint}
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
  const isDisabled = disabled || loading;
  if (variant === 'link') {
    return (
      <Pressable
        accessibilityRole="button"
        onPress={onPress}
        disabled={isDisabled}
        className="py-2"
      >
        <Text className="text-center text-base text-neutral-600 underline dark:text-neutral-400">
          {title}
        </Text>
      </Pressable>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!isDisabled, busy: !!loading }}
      onPress={onPress}
      disabled={isDisabled}
      className={`items-center rounded-lg bg-black py-3 dark:bg-white ${isDisabled ? 'opacity-50' : ''}`}
    >
      {loading ? (
        <ActivityIndicator color="#888" />
      ) : (
        <Text className="text-base font-semibold text-white dark:text-black">{title}</Text>
      )}
    </Pressable>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <Text accessibilityRole="alert" className="text-sm text-red-600">
      {children}
    </Text>
  );
}
