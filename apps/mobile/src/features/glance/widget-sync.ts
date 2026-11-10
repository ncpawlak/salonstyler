import type { Glance } from './glance';

/** Pushes widget timelines to WidgetKit (#40). No-op off iOS; see `widget-sync.ios.ts`. */
export function syncWidgets(_glance: Glance): void {}
