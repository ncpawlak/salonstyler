import * as SMS from 'expo-sms';
import { Linking, Platform } from 'react-native';

import { smsUrl } from './compose';

type Clipboard = { writeText(text: string): Promise<void> };

/** `unknown`: handed to Messages, but the OS doesn't say whether it was sent (Android). */
export type SendResult = 'sent' | 'copied' | 'cancelled' | 'unknown';

/** How a reply leaves the app: the Messages composer, or the clipboard on web. */
export const SEND_CHANNEL: 'messages' | 'copy' = Platform.OS === 'web' ? 'copy' : 'messages';
export const SEND_LABEL = Platform.OS === 'web' ? 'Copy' : 'Send';
export const SEND_ICON =
  Platform.OS === 'web' ? ('copy-outline' as const) : ('paper-plane-outline' as const);

/**
 * One-tap send (issue #7): opens the Messages composer with the recipient and text filled in, so
 * the stylist just taps send. Falls back to an `sms:` link where the composer isn't available,
 * and to copying on web.
 */
export async function sendClientText({
  to,
  body,
}: {
  to: string | null;
  body: string;
}): Promise<SendResult> {
  if (Platform.OS === 'web') {
    const clipboard = (globalThis as { navigator?: { clipboard?: Clipboard } }).navigator
      ?.clipboard;
    if (!clipboard) throw new Error('Copying isn’t available in this browser');
    await clipboard.writeText(body);
    return 'copied';
  }
  if (await SMS.isAvailableAsync()) {
    const { result } = await SMS.sendSMSAsync(to ? [to] : [], body);
    return result;
  }
  try {
    await Linking.openURL(smsUrl(to, body, Platform.OS));
  } catch {
    throw new Error('This device can’t send text messages');
  }
  return 'unknown';
}
