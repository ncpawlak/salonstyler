import {
  BRIDGE_SHORTCUT_NAME,
  BRIDGE_SHORTCUT_VERSION,
  triggerPhrases,
} from '@chairside/ai/shortcut';
import { router } from 'expo-router';
import { useState } from 'react';
import { Linking, Platform, View } from 'react-native';

import { DetailScreen } from '@/components/shell/screen';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Icon,
  SegmentedControl,
  SkeletonRow,
  Text,
} from '@/components/ui';
import { errorMessage } from '@/features/appointments/api';
import {
  inboxEndpoint,
  shortcutInstallUrl,
  useInboxBridge,
  useRotateBridgeToken,
} from '@/features/inbox/api';
import { healthOf, MockPhoneScreen, useCopy } from '@/features/inbox/bridge-ui';
import { haptics } from '@/lib/haptics';
import { useCurrentSalon } from '@/providers/session-provider';

const STEP_TITLES = [
  'Get your token',
  'Add the Shortcut',
  'Turn on the trigger',
  'Allow it to connect',
  'Send a test text',
] as const;

type IosVersion = 'ios27' | 'ios17';
const IOS_OPTIONS = [
  { value: 'ios27', label: 'iOS 27' },
  { value: 'ios17', label: 'iOS 17–26' },
] as const;

const RUN_URL = `shortcuts://run-shortcut?name=${encodeURIComponent(BRIDGE_SHORTCUT_NAME)}`;
const isNewer = (iso: string | null | undefined, since: number) =>
  !!iso && Date.parse(iso) >= since;

/** The build-it-yourself recipe, for when no published Shortcut link is configured. */
const MANUAL_RECIPE = [
  `Shortcuts → + → name it “${BRIDGE_SHORTCUT_NAME}”. In ⓘ Details turn on “Receive: Messages”, and set “If there’s no input” to Continue.`,
  'Text: paste the endpoint (rename it InboxURL). Text: paste the token (rename it BridgeToken).',
  'Get Details of Contacts → Phone Number of Shortcut Input → Sender (SenderPhone). Text: Shortcut Input → Sender (SenderText). Text: Shortcut Input → Content (MessageText).',
  'Format Date: Current Date, ISO 8601, include time (ReceivedAt).',
  `Get Contents of URL: InboxURL, POST, headers X-Bridge-Token = BridgeToken and Content-Type = application/json. JSON body: sender, senderPhone, text, receivedAt, and bridgeVersion = ${BRIDGE_SHORTCUT_VERSION}.`,
  'Get Dictionary Value “reply” from Contents of URL → If it has any value → Send Message (Show When Run off) to Shortcut Input → Sender.',
];

function StepDots({ step }: { step: number }) {
  return (
    <View
      className="flex-row gap-1.5 px-1 pb-4"
      accessibilityLabel={`Step ${step + 1} of ${STEP_TITLES.length}`}
    >
      {STEP_TITLES.map((title, i) => (
        <View
          key={title}
          className={`h-1.5 flex-1 rounded-full ${i <= step ? 'bg-primary' : 'bg-border'}`}
        />
      ))}
    </View>
  );
}

function Numbered({ items }: { items: readonly string[] }) {
  return (
    <View className="gap-2">
      {items.map((item, i) => (
        <View key={item} className="flex-row gap-2">
          <Text variant="subhead" tone="muted" numeric>
            {i + 1}.
          </Text>
          <Text variant="subhead" className="flex-1">
            {item}
          </Text>
        </View>
      ))}
    </View>
  );
}

function Waiting({ label, done, doneLabel }: { label: string; done: boolean; doneLabel: string }) {
  return (
    <View
      className={`flex-row items-center gap-3 rounded-xl px-4 py-3 ${done ? 'bg-success/10' : 'bg-muted'}`}
      accessibilityLiveRegion="polite"
      testID={done ? 'bridge-test-received' : 'bridge-test-waiting'}
    >
      <Icon
        name={done ? 'checkmark-circle' : 'hourglass-outline'}
        color={done ? 'success' : 'muted-foreground'}
      />
      <Text variant="subhead" className="flex-1">
        {done ? doneLabel : label}
      </Text>
    </View>
  );
}

/**
 * Settings → Text bridge → Set up: about a minute, five steps. Ends with a real text through the
 * real Shortcut, so a green check means bookings will arrive.
 */
export default function TextBridgeSetupScreen() {
  const salon = useCurrentSalon();
  const isOwner = salon.role === 'owner';
  const [step, setStep] = useState(0);
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const waiting = step >= 3;
  const bridge = useInboxBridge({ pollMs: waiting ? 2000 : undefined });
  const rotate = useRotateBridgeToken();
  const { copied, copy } = useCopy();
  const [token, setToken] = useState<string | null>(null);
  const [ios, setIos] = useState<IosVersion>('ios27');
  const [failure, setFailure] = useState<string | null>(null);

  const saved = bridge.data ?? null;
  const phrases = triggerPhrases(saved?.keyword);
  const installUrl = shortcutInstallUrl();
  const health = healthOf(saved);
  const handRun = isNewer(saved?.last_test_at, startedAt);
  const testReceived =
    isNewer(saved?.last_test_at, startedAt) || isNewer(saved?.last_received_at, startedAt);

  const go = (next: number) => {
    setFailure(null);
    setStartedAt(Date.now());
    setStep(next);
  };
  const copyOrFail = (key: string, text: string) =>
    void copy(key, text).catch((e: unknown) => setFailure(errorMessage(e)));
  const open = (url: string) =>
    void Linking.openURL(url).catch(() =>
      setFailure('Open this on the iPhone that receives your booking texts.'),
    );

  if (!isOwner) {
    return (
      <DetailScreen title="Set up text bridge">
        <EmptyState
          icon="lock-closed-outline"
          title="Owner only"
          message="Ask the salon owner to set up the text bridge."
        />
      </DetailScreen>
    );
  }
  if (bridge.isPending) {
    return (
      <DetailScreen title="Set up text bridge">
        <SkeletonRow />
      </DetailScreen>
    );
  }

  let body: React.ReactNode;
  let next: { label: string; disabled?: boolean } | null = { label: 'Next' };

  if (step === 0) {
    body = (
      <>
        <Text variant="body">
          Your iPhone forwards texts that contain “{phrases[0]}” to Chairside. Copy this token. The
          Shortcut asks for it in the next step.
        </Text>
        {token ? (
          <Card className="gap-2">
            <Text variant="subhead" selectable testID="bridge-token" className="font-semibold">
              {token}
            </Text>
            <Button
              variant="secondary"
              label={copied === 'token' ? 'Copied' : 'Copy token'}
              icon={copied === 'token' ? 'checkmark' : 'copy-outline'}
              onPress={() => copyOrFail('token', token)}
            />
          </Card>
        ) : (
          <>
            {saved ? (
              <Text variant="footnote" tone="warning">
                A new token replaces the one ending in {saved.token_hint}. Your current Shortcut
                stops working until you add the new one.
              </Text>
            ) : null}
            <Button
              label="Generate token"
              icon="key-outline"
              loading={rotate.isPending}
              onPress={() =>
                rotate.mutate(undefined, {
                  onSuccess: (t) => {
                    setToken(t);
                    copyOrFail('token', t);
                  },
                  onError: (e) => setFailure(errorMessage(e)),
                })
              }
            />
          </>
        )}
      </>
    );
    next = { label: 'Next', disabled: !token };
  } else if (step === 1) {
    body = installUrl ? (
      <>
        <Text variant="body">
          Tap below on your iPhone. Shortcuts opens and asks two questions:
        </Text>
        <MockPhoneScreen
          title={`Set Up “${BRIDGE_SHORTCUT_NAME}”`}
          rows={[
            { label: 'Bridge token', value: 'Paste', highlight: true },
            { label: 'Inbox URL', value: 'Keep as is' },
          ]}
        />
        <Text variant="subhead" tone="muted">
          Paste your token (it’s on your clipboard), then tap Add Shortcut.
          {health?.outdated ? ' Updating? Choose Replace when asked.' : ''}
        </Text>
        <Button
          label={`Add “${BRIDGE_SHORTCUT_NAME}”`}
          icon="add-circle-outline"
          onPress={() => open(installUrl)}
        />
        <Button
          variant="ghost"
          label={copied === 'token' ? 'Copied' : 'Copy token again'}
          onPress={() => token && copyOrFail('token', token)}
        />
        <Button
          variant="ghost"
          label={copied === 'endpoint' ? 'Copied' : 'Copy Inbox URL'}
          onPress={() => copyOrFail('endpoint', inboxEndpoint())}
        />
      </>
    ) : (
      <>
        <Text variant="body">Build the Shortcut once (about 3 minutes):</Text>
        <Numbered items={MANUAL_RECIPE} />
        <View className="flex-row gap-2">
          <Button
            grow
            variant="secondary"
            label={copied === 'endpoint' ? 'Copied' : 'Copy endpoint'}
            onPress={() => copyOrFail('endpoint', inboxEndpoint())}
          />
          <Button
            grow
            variant="secondary"
            label={copied === 'token' ? 'Copied' : 'Copy token'}
            onPress={() => token && copyOrFail('token', token)}
          />
        </View>
      </>
    );
  } else if (step === 2) {
    const steps =
      ios === 'ios27'
        ? [
            `Open “${BRIDGE_SHORTCUT_NAME}” → Edit → Automation → Message.`,
            `Message Contains: “${phrases[0]}”. Leave Sender empty (anyone).`,
            'Automation on, Confirm Before Run off.',
            ...(phrases[1] ? [`Add a second Message trigger for “${phrases[1]}”.`] : []),
            'ⓘ → Privacy → Allow Running When Locked: on.',
          ]
        : [
            'Shortcuts → Automation tab → + → Message.',
            `Message Contains: “${phrases[0]}”. Leave Sender empty (anyone) → Next.`,
            'Choose Run Immediately (not Run After Confirmation).',
            `Pick “${BRIDGE_SHORTCUT_NAME}”.`,
            ...(phrases[1] ? [`Repeat for “${phrases[1]}”.`] : []),
          ];
    body = (
      <>
        <Text variant="body">
          This makes it run by itself. Which iOS is on your phone? (Settings → General → About)
        </Text>
        <SegmentedControl
          options={IOS_OPTIONS}
          value={ios}
          onChange={setIos}
          accessibilityLabel="iOS version"
        />
        <Numbered items={steps} />
        <MockPhoneScreen
          title={ios === 'ios27' ? 'Message trigger' : 'When I get a message'}
          rows={
            ios === 'ios27'
              ? [
                  { label: 'Message Contains', value: phrases[0], highlight: true },
                  { label: 'Sender', value: 'Anyone' },
                  { label: 'Automation', toggle: true },
                  { label: 'Confirm Before Run', toggle: false, highlight: true },
                  { label: 'Allow Running When Locked', toggle: true, highlight: true },
                ]
              : [
                  { label: 'Message Contains', value: phrases[0], highlight: true },
                  { label: 'Sender', value: 'Anyone' },
                  { label: 'Run After Confirmation', value: '' },
                  { label: 'Run Immediately', value: '✓', highlight: true },
                ]
          }
        />
        <View className="flex-row flex-wrap gap-2">
          {phrases.map((p) => (
            <Button
              key={p}
              size="sm"
              variant="secondary"
              label={copied === p ? 'Copied' : `Copy “${p}”`}
              onPress={() => copyOrFail(p, p)}
            />
          ))}
        </View>
        <Text variant="footnote" tone="muted">
          Autocorrect often splits “Chairside”, so set up both. Don’t add a Sender filter: it stops
          texts from unsaved numbers.
        </Text>
      </>
    );
  } else if (step === 3) {
    body = (
      <>
        <Text variant="body">
          Run the Shortcut once by hand while your phone is unlocked. When iOS asks to connect to
          Chairside, tap Always Allow. Otherwise it can’t run while your phone is locked.
        </Text>
        <MockPhoneScreen
          title={`Allow “${BRIDGE_SHORTCUT_NAME}” to connect?`}
          rows={[
            { label: 'Allow Once', value: '' },
            { label: 'Always Allow', value: 'Tap this', highlight: true },
            { label: 'Don’t Allow', value: '' },
          ]}
        />
        {Platform.OS === 'ios' ? (
          <Button label="Run it now" icon="play-outline" onPress={() => open(RUN_URL)} />
        ) : (
          <Text variant="subhead" tone="muted">
            On your iPhone: Shortcuts → tap “{BRIDGE_SHORTCUT_NAME}”.
          </Text>
        )}
        <Waiting
          label="Waiting for the hand run…"
          done={handRun}
          doneLabel="Connected. Chairside heard from your Shortcut."
        />
      </>
    );
    next = { label: handRun ? 'Next' : 'Skip' };
  } else {
    body = (
      <>
        <Text variant="body">From another phone, text this iPhone:</Text>
        <Card className="items-center gap-2">
          <Text variant="title3" selectable testID="bridge-test-phrase">
            {phrases[0]} test
          </Text>
          <Text variant="footnote" tone="muted">
            Lock your iPhone first to check that it works in your pocket.
          </Text>
        </Card>
        <Waiting
          label="Waiting for the test text…"
          done={testReceived}
          doneLabel="It works! Booking texts will land in your Inbox."
        />
        {saved?.auto_reply ? (
          <Text variant="footnote" tone="muted">
            Auto-reply is on, so the other phone gets a “connected” text back.
          </Text>
        ) : null}
        {!testReceived ? (
          <Text variant="footnote" tone="muted">
            Nothing after a minute? Check that the trigger says Run Immediately (or Confirm Before
            Run is off), that the keyword matches, and that you tapped Always Allow.
          </Text>
        ) : null}
      </>
    );
    next = testReceived ? { label: 'Done' } : null;
  }

  return (
    <DetailScreen title="Set up text bridge">
      <StepDots step={step} />
      <View className="gap-4">
        <View className="flex-row items-center gap-2 px-1">
          <Text variant="title3" className="flex-1" testID="bridge-setup-step">
            {step + 1}. {STEP_TITLES[step]}
          </Text>
          {step === 0 ? <Badge label="~1 min" /> : null}
        </View>
        {body}
        {failure ? (
          <Text variant="footnote" tone="destructive" accessibilityLiveRegion="polite">
            {failure}
          </Text>
        ) : null}
        <View className="flex-row gap-3 pt-2">
          {step > 0 ? (
            <Button grow variant="outline" label="Back" onPress={() => go(step - 1)} />
          ) : null}
          {next ? (
            <Button
              grow
              label={next.label}
              disabled={next.disabled}
              testID="bridge-setup-next"
              onPress={() => {
                if (step < STEP_TITLES.length - 1) return go(step + 1);
                haptics.success();
                router.back();
              }}
            />
          ) : null}
        </View>
      </View>
    </DetailScreen>
  );
}
