import { Pressable, View } from 'react-native';

import { Icon, Text, type IconName } from '@/components/ui';
import { cn } from '@/lib/cn';
import { haptics } from '@/lib/haptics';

interface QuickAction {
  id: string;
  icon: IconName;
  label: string;
  onPress?: () => void;
}

/** One-tap actions. Ones without `onPress` show as "Soon" until their feature ships. */
export function QuickActions({ actions }: { actions: QuickAction[] }) {
  const soon = actions.filter((a) => !a.onPress).map((a) => a.label);
  return (
    <View className="gap-2">
      <View className="flex-row gap-3">
        {actions.map((a) => {
          const disabled = !a.onPress;
          return (
            <Pressable
              key={a.id}
              accessibilityRole="button"
              accessibilityLabel={disabled ? `${a.label}, coming soon` : a.label}
              accessibilityState={{ disabled }}
              disabled={disabled}
              onPress={() => {
                haptics.tap();
                a.onPress?.();
              }}
              className={cn(
                'flex-1 items-center gap-2 rounded-xl border border-border bg-card px-1 py-3',
                disabled ? 'opacity-50' : 'active:bg-muted',
              )}
            >
              <View
                className={cn(
                  'h-11 w-11 items-center justify-center rounded-full',
                  disabled ? 'bg-muted' : 'bg-primary',
                )}
              >
                <Icon
                  name={a.icon}
                  size={22}
                  color={disabled ? 'muted-foreground' : 'primary-foreground'}
                />
              </View>
              <Text variant="caption" className="text-center" numberOfLines={1}>
                {a.label}
              </Text>
              {disabled ? (
                <Text variant="caption" tone="subtle" className="-mt-1.5 text-center">
                  Soon
                </Text>
              ) : null}
            </Pressable>
          );
        })}
      </View>
      {soon.length ? (
        <Text variant="footnote" tone="subtle" className="px-1">
          {soon.join(', ')} {soon.length === 1 ? 'is' : 'are'} coming soon.
        </Text>
      ) : null}
    </View>
  );
}
