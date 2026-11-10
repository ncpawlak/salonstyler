import { getShareExtensionKey } from 'expo-share-intent';

/**
 * The iOS Share Extension opens the app with `chairside://dataUrl=<key>…`, which isn't a route.
 * Send it to the capture screen, which reads the shared text or image (#2).
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  try {
    if (path.includes(`dataUrl=${getShareExtensionKey()}`)) return '/capture?shared=1';
    return path;
  } catch {
    return '/';
  }
}
