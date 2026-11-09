// iOS notification categories / Android actions. The ids must match the `category` column the
// database writes into notifications_outbox (no ':' or '-' allowed by expo-notifications).
export const NOTIFICATION_CATEGORIES = {
  appointmentRequest: 'appointmentRequest',
  requestNudge: 'requestNudge',
} as const;

export type NotificationCategoryId =
  (typeof NOTIFICATION_CATEGORIES)[keyof typeof NOTIFICATION_CATEGORIES];

export const NOTIFICATION_ACTIONS = {
  approve: 'approve',
  otherTime: 'otherTime',
  decline: 'decline',
  respond: 'respond',
  ignore: 'ignore',
} as const;

export type NotificationActionId = (typeof NOTIFICATION_ACTIONS)[keyof typeof NOTIFICATION_ACTIONS];

export interface NotificationActionSpec {
  identifier: NotificationActionId;
  buttonTitle: string;
  /** Run in the background (lock screen) instead of opening the app. */
  background: boolean;
  destructive?: boolean;
  /** Require Face ID / passcode before running (iOS). */
  authenticationRequired?: boolean;
}

export const CATEGORY_ACTIONS: Record<NotificationCategoryId, NotificationActionSpec[]> = {
  appointmentRequest: [
    {
      identifier: 'approve',
      buttonTitle: 'Approve',
      background: true,
      authenticationRequired: true,
    },
    { identifier: 'otherTime', buttonTitle: 'Other time', background: false },
    { identifier: 'decline', buttonTitle: 'Decline', background: true, destructive: true },
  ],
  requestNudge: [
    { identifier: 'respond', buttonTitle: 'Respond', background: false },
    { identifier: 'ignore', buttonTitle: 'Ignore', background: true, destructive: true },
  ],
};

/** The default action id expo-notifications reports for a plain tap on the notification. */
export const DEFAULT_ACTION_ID = 'expo.modules.notifications.actions.DEFAULT';

/** Setting choices (hours) shared by the settings screen and docs. */
export const NUDGE_DELAY_OPTIONS = [1, 2, 4, 8, 12, 24, 48, 72] as const;
export const DEFAULT_NUDGE_DELAY_HOURS = 24;
