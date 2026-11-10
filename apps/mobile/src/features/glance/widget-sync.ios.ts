import DayBookedWidget from '@/widgets/day-booked-widget';
import NextClientWidget from '@/widgets/next-client-widget';
import RequestsWidget from '@/widgets/requests-widget';

import { glanceSignature, type Glance, type TimelineEntry } from './glance';

let last: string | null = null;

const entries = <P>(timeline: TimelineEntry<P>[]) =>
  timeline.map((e) => ({ date: new Date(e.date), props: e.props }));

/**
 * Pushes widget timelines to WidgetKit (#40), only when something visible changed: every push
 * reloads the widgets, which iOS budgets.
 */
export function syncWidgets(glance: Glance): void {
  const signature = glanceSignature(glance);
  if (signature === last) return;
  try {
    NextClientWidget.updateTimeline(entries(glance.nextClient));
    DayBookedWidget.updateTimeline(entries(glance.dayBooked));
    RequestsWidget.updateSnapshot(glance.requests);
    last = signature;
  } catch {
    // No widget extension in this build (e.g. Expo Go); nothing to update.
  }
}
