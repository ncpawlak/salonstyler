import { HStack, Image, ProgressView, Spacer, Text, VStack } from '@expo/ui/swift-ui';
import {
  font,
  foregroundStyle,
  frame,
  lineLimit,
  monospacedDigit,
  multilineTextAlignment,
  padding,
  tint,
} from '@expo/ui/swift-ui/modifiers';
import { createLiveActivity, type LiveActivityEnvironment } from 'expo-widgets';

import type { ProcessingActivityProps } from '@/features/timers/timers';

/**
 * Processing timer Live Activity (#40): Lock Screen banner + Dynamic Island, e.g.
 * "Karina · color" with a countdown that SwiftUI ticks on its own (no app updates needed).
 *
 * Runs in the widget extension's isolated runtime: everything must be declared inside the
 * function (see the `'widget'` directive in the expo-widgets docs).
 */
const ProcessingActivity = (props: ProcessingActivityProps, env: LiveActivityEnvironment) => {
  'widget';
  const accent = env.isLuminanceReduced ? '#FFFFFF' : '#6366F1';
  const doneColor = '#16A34A';
  const range = { lower: new Date(props.start), upper: new Date(props.end) };
  const title = `${props.client} · ${props.service}`;
  const icon = props.done ? 'checkmark.circle.fill' : 'hourglass';
  const iconColor = props.done ? doneColor : accent;

  const countdown = (size: number) =>
    props.done ? (
      <Text modifiers={[font({ size, weight: 'semibold' }), foregroundStyle(doneColor)]}>Done</Text>
    ) : (
      <Text
        timerInterval={range}
        countsDown
        modifiers={[
          font({ size, weight: 'semibold', design: 'rounded' }),
          monospacedDigit(),
          multilineTextAlignment('trailing'),
          frame({ maxWidth: size * 4, alignment: 'trailing' }),
        ]}
      />
    );

  const progress = props.done ? (
    <ProgressView value={1} modifiers={[tint(doneColor)]} />
  ) : (
    <ProgressView timerInterval={range} countsDown={false} modifiers={[tint(accent)]} />
  );

  return {
    banner: (
      <VStack spacing={8} modifiers={[padding({ all: 16 })]}>
        <HStack spacing={10}>
          <Image systemName={icon} color={iconColor} size={22} />
          <VStack alignment="leading" spacing={2}>
            <Text modifiers={[font({ size: 16, weight: 'semibold' }), lineLimit(1)]}>{title}</Text>
            <Text
              modifiers={[
                font({ size: 13 }),
                foregroundStyle({ type: 'hierarchical', style: 'secondary' }),
              ]}
            >
              {props.done ? 'Processing done' : 'Processing'}
            </Text>
          </VStack>
          <Spacer />
          {countdown(28)}
        </HStack>
        {progress}
      </VStack>
    ),
    compactLeading: <Image systemName={icon} color={iconColor} />,
    compactTrailing: props.done ? (
      <Text modifiers={[foregroundStyle(doneColor)]}>Done</Text>
    ) : (
      <Text
        timerInterval={range}
        countsDown
        modifiers={[monospacedDigit(), frame({ maxWidth: 44 }), foregroundStyle(accent)]}
      />
    ),
    minimal: <Image systemName={icon} color={iconColor} />,
    expandedLeading: (
      <VStack alignment="leading" spacing={2} modifiers={[padding({ leading: 8 })]}>
        <Text modifiers={[font({ size: 15, weight: 'semibold' }), lineLimit(1)]}>
          {props.client}
        </Text>
        <Text
          modifiers={[
            font({ size: 13 }),
            foregroundStyle({ type: 'hierarchical', style: 'secondary' }),
          ]}
        >
          {props.service}
        </Text>
      </VStack>
    ),
    expandedTrailing: <VStack modifiers={[padding({ trailing: 8 })]}>{countdown(24)}</VStack>,
    expandedBottom: <VStack modifiers={[padding({ horizontal: 8 })]}>{progress}</VStack>,
  };
};

export default createLiveActivity('ProcessingTimer', ProcessingActivity);
