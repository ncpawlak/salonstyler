import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';

/**
 * Haptics conventions:
 * - `selection`: segment/chip/tab changes
 * - `tap`: primary button presses
 * - `success` / `warning` / `error`: outcomes (approve, checkout paid, decline)
 */
const enabled = Platform.OS === 'ios' || Platform.OS === 'android';

function run(fn: () => Promise<void>) {
  if (enabled) fn().catch(() => undefined);
}

export const haptics = {
  selection: () => run(() => Haptics.selectionAsync()),
  tap: () => run(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)),
  heavy: () => run(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)),
  success: () => run(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)),
  warning: () => run(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)),
  error: () => run(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error)),
};
