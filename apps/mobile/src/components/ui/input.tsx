import { useState, type ComponentRef, type Ref } from 'react';
import { TextInput, View, type TextInputProps } from 'react-native';

import { cn } from '@/lib/cn';
import { useTheme } from '@/theme/theme-provider';

import { Icon, type IconName } from './icon';
import { Text } from './text';

export type InputProps = TextInputProps & {
  label?: string;
  helper?: string;
  error?: string;
  icon?: IconName;
  className?: string;
  ref?: Ref<ComponentRef<typeof TextInput>>;
};

export function Input({
  label,
  helper,
  error,
  icon,
  className,
  onFocus,
  onBlur,
  ref,
  ...props
}: InputProps) {
  const { colors } = useTheme();
  const [focused, setFocused] = useState(false);

  return (
    <View className={cn('gap-1.5', className)}>
      {label ? (
        <Text variant="footnote" tone="muted" className="font-medium">
          {label}
        </Text>
      ) : null}
      <View
        className={cn(
          'min-h-tap flex-row items-center gap-2 rounded-lg border bg-card px-3',
          error ? 'border-destructive' : focused ? 'border-ring' : 'border-input',
        )}
      >
        {icon ? <Icon name={icon} size={18} color="muted-foreground" /> : null}
        <TextInput
          ref={ref}
          accessibilityLabel={props.accessibilityLabel ?? label ?? props.placeholder}
          placeholderTextColor={colors['subtle-foreground']}
          selectionColor={colors.primary}
          maxFontSizeMultiplier={2}
          onFocus={(e) => {
            setFocused(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            onBlur?.(e);
          }}
          className="min-h-tap flex-1 py-2 text-body text-foreground"
          style={{ outlineStyle: 'none' } as object}
          {...props}
        />
      </View>
      {error || helper ? (
        <Text variant="footnote" tone={error ? 'destructive' : 'muted'}>
          {error ?? helper}
        </Text>
      ) : null}
    </View>
  );
}
