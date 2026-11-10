# Processing timers, Live Activities and widgets (#40)

The ⭐ row in [`docs/PLAN.md` §11b](../../docs/PLAN.md). There are no database changes: timers come from the appointment's processing segments, and everything else is per device.

## Processing timers

Every processing segment on today's confirmed or completed appointments can become a timer. The logic is in `apps/mobile/src/features/timers/timers.ts` and is unit-tested.

- **Start:** a segment starts on its own at its booked start (**Start at the booked time**, on by default). The stylist can also tap **Start processing**, which starts it now for the booked length. That button shows from 30 minutes before the client's first segment until they leave, one per appointment.
- **Adjust:** **+5 min** extends a timer (from now if it's already done). **Stop** removes a running timer. **Dismiss** clears a finished one. A finished timer stays on Today for 10 minutes.
- **Several at once:** each segment is its own timer, keyed `${appointmentId}:${n}`. Two clients processing side by side get two timers and two Live Activities.
- **State:** manual starts, extensions and dismissals are stored on the device in AsyncStorage under `chairside.processingTimers.v1`, and pruned after 24 hours. Timers are a convenience on the stylist's own phone, so nothing goes to the database. Preferences live in the same store.
- **Alert at 0:** the app buzzes (`haptics.warning`) when a timer it's showing finishes. On iOS and Android, `timer-alerts.ts` also schedules one local notification per running timer at its end: "Karina’s color is done". The notification has `data.type = 'processing_timer'`, so tapping it just opens the app. It is rescheduled when a timer is extended and cancelled when the timer is stopped. If notification permission hasn't been asked yet, it's asked the first time an alert is needed.

## Live Activities and Dynamic Island (iOS 16.2+)

`src/widgets/processing-activity.tsx` is the layout, written in TSX with `@expo/ui/swift-ui`. `expo-widgets` compiles it into the `ExpoWidgetsTarget` WidgetKit extension.

- **Lock Screen banner:** client and service, a live countdown, and a progress bar.
- **Dynamic Island:** compact (hourglass + countdown), minimal (countdown), and expanded (client · service + countdown + progress).
- **Ticking:** the countdown uses SwiftUI's `timerInterval`, so it runs without updates from the app.
- **Sync:** `live-activities.ios.ts` keeps exactly one activity per running timer (`planActivities`). It starts new ones, updates extended ones, and removes stopped ones. When a timer hits 0 the activity ends showing **Done** and stays on the Lock Screen for 15 minutes or until it's dismissed in the app. Activity IDs are remembered across launches (`chairside.liveActivities.v1`), and checked against `getInstances()`.
- **Off switch:** **Settings → Timers & widgets → Live Activities**, or the system switch in iOS Settings › Chairside.

## Widgets (iOS 17+)

The app computes small JSON snapshots and timelines and pushes them to WidgetKit through the shared App Group. Widgets never call Supabase. That code is in `features/glance/glance.ts` (unit-tested) and `widget-sync.ios.ts`.

| Widget | Families | Shows | Tap opens |
|---|---|---|---|
| **Next client** (`ChairsideNextClient`) | small, medium, Lock Screen rectangular and inline | Next client, time, service, "in 12 min", who's in the chair, how many are left | Today |
| **Today booked** (`ChairsideDayBooked`) | small, Lock Screen circular | Donut of today's open time that is booked, plus the client count | Calendar |
| **Requests** (`ChairsideRequests`) | small, Lock Screen circular and inline | Booking requests waiting (the Inbox badge count) | Inbox |

`useGlanceSync` is mounted in the signed-in tab layout. It uses the same queries as Today, so new bookings, moves, cancellations, approvals and realtime changes all flow through.

- **Next client timeline:** one entry each time a client arrives or leaves, so the widget rolls forward through the day without the app running. Another entry at the salon's midnight clears it.
- **Reloads:** widgets only reload when something visible changes (`glanceSignature`), because iOS rations widget reloads.

## Native setup

The `expo-widgets` config plugin in `apps/mobile/app.config.ts` adds the `ExpoWidgetsTarget` extension.

- **Bundle ID and App Group:** the extension's bundle ID is `<app>.widgets`. It uses the same App Group as the share extension (`group.<app>`, per variant). EAS gets both extensions from `extra.eas.build.experimental.ios.appExtensions`.
- **App Info.plist:** the plugin also sets `NSSupportsLiveActivities`.
- **Plugin order:** the plugin is listed before `expo-share-intent`. Its App Group mod runs last and de-duplicates the group in the app's entitlements.
- **CI:** the `Validate native config` job in `.github/workflows/eas.yml` prebuilds every variant. It checks the extension, its App Group, the Live Activities key, and that the group is listed only once.
- **Platform stubs:** on web and Android, `live-activities.ts` and `widget-sync.ts` are no-ops (iOS uses the `.ios.ts` files), and the in-app timers work the same.
- **Layout rules:** widget layouts must follow the `'widget'` directive rules. They can't use hooks or module scope, only `@expo/ui/swift-ui` components and modifiers, and props must be JSON. Live Activities need no entry in the plugin's `widgets` list.

## On-device verification (iPhone, development or preview build)

Live Activities, widgets and notifications only exist in a native build, not Expo Go or web. Build with `eas build --profile development --platform ios`. After any change to `src/widgets/` or the plugin config, rebuild; a JS-only OTA update does not change the widget extension.

1. **Auto-start:** book a client now with a service that has a short processing gap (for example 1 min busy, 2 min processing). At the processing start, Today shows the timer and a Live Activity appears. Lock the phone: the banner reads "Karina · color" with a countdown. On a Dynamic Island iPhone, swipe home: the compact view shows the countdown, and long-press expands it.
2. **Alert at 0:** with the phone locked, a "Karina’s color is done" notification arrives at 0, and the activity flips to **Done**. In the app, a haptic fires. **Dismiss** removes the activity.
3. **Manual start and extend:** turn off **Start at the booked time**. Tap **Start processing** on the card; the activity starts. Tap **+5 min**: the countdown and the scheduled notification both move 5 minutes. **Stop** removes both.
4. **Several timers:** start two clients' processing at once. You get two Live Activities and two alerts.
5. **Widgets:** add Next client (small and medium), Today booked, Requests, and the Lock Screen versions. Book, move or cancel an appointment, or approve or decline a request (in the app or from another device via realtime). The widgets update within a few seconds of the app seeing the change. Next client rolls forward on its own as clients arrive.
6. **Coexistence:** sharing a screenshot to **Save to Chairside** still lands in the Inbox (same App Group).
