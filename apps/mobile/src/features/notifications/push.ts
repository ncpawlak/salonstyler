// Native push setup (expo-notifications). Everything is a no-op on web.
import {
  CATEGORY_ACTIONS,
  type NotificationCategoryId,
  notificationIntent,
} from '@chairside/notifications';
import { setAppointmentStatus } from '@chairside/db/appointments';
import { registerPushToken, unregisterPushToken } from '@chairside/db/notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { supabase } from '@/lib/supabase';

const TOKEN_KEY = 'chairside.pushToken';
const HANDLED_KEY = 'chairside.handledNotificationResponses';

export const pushSupported = Platform.OS === 'ios' || Platform.OS === 'android';

export type PushStatus =
  | { state: 'unsupported' }
  | { state: 'denied' }
  | { state: 'no-project' }
  | { state: 'registered'; token: string }
  | { state: 'error'; message: string };

let configured = false;

/** Foreground presentation, iOS categories (lock-screen buttons) and the Android channel. */
export async function configureNotifications(): Promise<void> {
  if (!pushSupported || configured) return;
  configured = true;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'Bookings',
      // eslint-disable-next-line import/namespace -- re-exported enum the import plugin can't resolve.
      importance: Notifications.AndroidImportance.HIGH,
    });
  }
  await Promise.all(
    (Object.keys(CATEGORY_ACTIONS) as NotificationCategoryId[]).map((id) =>
      Notifications.setNotificationCategoryAsync(
        id,
        CATEGORY_ACTIONS[id].map((a) => ({
          identifier: a.identifier,
          buttonTitle: a.buttonTitle,
          options: {
            // Background actions run JS without opening the app (approve from the lock screen).
            opensAppToForeground: !a.background,
            isDestructive: a.destructive ?? false,
            isAuthenticationRequired: a.authenticationRequired ?? false,
          },
        })),
      ),
    ),
  );
}

function projectId(): string | undefined {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined;
  return extra?.eas?.projectId ?? Constants.easConfig?.projectId ?? undefined;
}

/** Asks for permission (once) and saves this device's Expo push token for the signed-in member. */
export async function registerForPush(salonId: string, ask = true): Promise<PushStatus> {
  if (!pushSupported) return { state: 'unsupported' };
  try {
    await configureNotifications();
    let { status } = await Notifications.getPermissionsAsync();
    if (status !== 'granted' && ask) ({ status } = await Notifications.requestPermissionsAsync());
    if (status !== 'granted') return { state: 'denied' };
    const id = projectId();
    if (!id) return { state: 'no-project' };
    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId: id });
    await registerPushToken(supabase, salonId, token, Platform.OS === 'ios' ? 'ios' : 'android');
    await AsyncStorage.setItem(TOKEN_KEY, token);
    return { state: 'registered', token };
  } catch (e) {
    return { state: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}

/** Stops pushes to this device. Call while still signed in. */
export async function unregisterThisDevice(): Promise<void> {
  const token = await AsyncStorage.getItem(TOKEN_KEY);
  if (!token) return;
  await AsyncStorage.removeItem(TOKEN_KEY);
  await unregisterPushToken(supabase, token).catch(() => undefined);
}

const handledThisRun = new Set<string>();

/** Records a response so it runs once, even if delivered to both the listener and on launch. */
async function claimResponse(key: string): Promise<boolean> {
  if (handledThisRun.has(key)) return false;
  handledThisRun.add(key);
  const raw = await AsyncStorage.getItem(HANDLED_KEY);
  const handled: string[] = raw ? (JSON.parse(raw) as string[]) : [];
  if (handled.includes(key)) return false;
  await AsyncStorage.setItem(HANDLED_KEY, JSON.stringify([...handled, key].slice(-50)));
  return true;
}

type Listener = (event: { kind: 'changed' } | { kind: 'open'; href: string }) => void;
const listeners = new Set<Listener>();
const pendingOpens: string[] = [];

/** Subscribe to handled responses (refresh data / navigate). Replays an open that arrived early. */
export function onNotificationEvent(listener: Listener): () => void {
  listeners.add(listener);
  for (const href of pendingOpens.splice(0)) listener({ kind: 'open', href });
  return () => listeners.delete(listener);
}

function emit(event: Parameters<Listener>[0]) {
  if (event.kind === 'open' && listeners.size === 0) pendingOpens.push(event.href);
  for (const l of listeners) l(event);
}

/**
 * Approve / Decline / Ignore change the appointment via set_appointment_status (works from the lock
 * screen with the app in the background); Other time / Respond / taps open the request.
 */
export async function handleNotificationResponse(
  response: Notifications.NotificationResponse,
): Promise<void> {
  const { request } = response.notification;
  if (!(await claimResponse(`${request.identifier}:${response.actionIdentifier}`))) return;

  const intent = notificationIntent(response.actionIdentifier, request.content.data);
  if (intent.kind === 'none') return;
  if (intent.kind === 'open') {
    emit({ kind: 'open', href: intent.href });
    return;
  }
  try {
    if (intent.kind === 'approve') {
      await setAppointmentStatus(supabase, intent.appointmentId, 'confirmed');
    } else {
      await setAppointmentStatus(
        supabase,
        intent.appointmentId,
        'cancelled',
        intent.kind === 'decline' ? 'declined' : 'ignored',
      );
    }
    await Notifications.dismissNotificationAsync(request.identifier).catch(() => undefined);
    emit({ kind: 'changed' });
  } catch (e) {
    // Tell him it didn't go through; tapping opens the request to sort it out.
    await Notifications.scheduleNotificationAsync({
      content: {
        title:
          intent.kind === 'approve'
            ? 'Couldn’t approve the request'
            : 'Couldn’t update the request',
        body: e instanceof Error ? e.message : 'Open Chairside to try again.',
        data: { type: 'request', appointmentId: intent.appointmentId },
      },
      trigger: null,
    }).catch(() => undefined);
  }
}

let installed = false;

/** Installs the response listener at startup (module scope) so background actions are handled. */
export function installNotificationResponseHandler(): void {
  if (!pushSupported || installed) return;
  installed = true;
  void configureNotifications();
  Notifications.addNotificationResponseReceivedListener((r) => void handleNotificationResponse(r));
  void Notifications.getLastNotificationResponseAsync().then((r) => {
    if (r) void handleNotificationResponse(r);
  });
}
