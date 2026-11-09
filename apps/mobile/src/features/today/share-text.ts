import { Platform, Share } from 'react-native';

type Clipboard = { writeText(text: string): Promise<void> };

/**
 * Hands a drafted client text to the OS: the share sheet on iOS/Android (Messages, Copy, …),
 * the clipboard on web. One-tap send via Messages replaces this later (issue #7).
 */
export async function shareClientText(text: string): Promise<'copied' | 'shared' | 'dismissed'> {
  if (Platform.OS === 'web') {
    const clipboard = (globalThis as { navigator?: { clipboard?: Clipboard } }).navigator
      ?.clipboard;
    if (!clipboard) throw new Error('Copying isn’t available in this browser');
    await clipboard.writeText(text);
    return 'copied';
  }
  const result = await Share.share({ message: text });
  return result.action === Share.sharedAction ? 'shared' : 'dismissed';
}

export const SHARE_TEXT_LABEL = Platform.OS === 'web' ? 'Copy' : 'Share';
