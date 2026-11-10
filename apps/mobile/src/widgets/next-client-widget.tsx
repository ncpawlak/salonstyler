import { HStack, Image, Spacer, Text, VStack } from '@expo/ui/swift-ui';
import {
  containerBackground,
  font,
  foregroundStyle,
  frame,
  lineLimit,
  minimumScaleFactor,
  widgetURL,
} from '@expo/ui/swift-ui/modifiers';
import { createWidget, type WidgetEnvironment } from 'expo-widgets';
import { PlatformColor } from 'react-native';

import type { NextClientProps } from '@/features/glance/glance';

/**
 * "Next client" widget (#40): who's next, when, and what for. The app pushes a timeline
 * (`src/features/glance/glance.ts`) so it rolls forward on its own as clients come and go.
 */
const NextClientWidget = (props: NextClientProps, env: WidgetEnvironment) => {
  'widget';
  const accent = env.widgetRenderingMode === 'fullColor' ? '#4F46E5' : PlatformColor('label');
  const secondary = { type: 'hierarchical', style: 'secondary' } as const;
  const root = [
    containerBackground(PlatformColor('systemBackground'), 'widget'),
    widgetURL('chairside:///'),
  ];
  const nobody = !props.today
    ? 'Open Chairside for today'
    : props.inChair
      ? 'Last client of the day'
      : 'No more clients today';

  if (env.widgetFamily === 'accessoryInline') {
    return (
      <Text modifiers={root}>{props.name ? `Next: ${props.name} · ${props.time}` : nobody}</Text>
    );
  }

  if (env.widgetFamily === 'accessoryRectangular') {
    return (
      <VStack alignment="leading" spacing={1} modifiers={root}>
        <Text modifiers={[font({ size: 13, weight: 'semibold' })]}>
          {props.name ? 'Next client' : 'Chairside'}
        </Text>
        <Text modifiers={[font({ size: 15, weight: 'bold' }), lineLimit(1)]}>
          {props.name ?? nobody}
        </Text>
        {props.name ? (
          <Text modifiers={[font({ size: 13 }), lineLimit(1)]}>
            {`${props.time}${props.service ? ` · ${props.service}` : ''}`}
          </Text>
        ) : null}
      </VStack>
    );
  }

  const header = (
    <HStack spacing={4}>
      <Image systemName="person.crop.circle" color={accent} size={13} />
      <Text modifiers={[font({ size: 13, weight: 'semibold' }), foregroundStyle(accent)]}>
        Next client
      </Text>
      <Spacer />
    </HStack>
  );

  if (!props.name || props.start === null) {
    return (
      <VStack alignment="leading" spacing={6} modifiers={root}>
        {header}
        <Spacer />
        <Text modifiers={[font({ size: 17, weight: 'semibold' }), minimumScaleFactor(0.8)]}>
          {nobody}
        </Text>
        {props.inChair ? (
          <Text modifiers={[font({ size: 13 }), foregroundStyle(secondary)]}>
            {`In the chair: ${props.inChair}`}
          </Text>
        ) : null}
      </VStack>
    );
  }

  const details = (
    <VStack alignment="leading" spacing={2}>
      <Text modifiers={[font({ size: 22, weight: 'bold' }), lineLimit(1), minimumScaleFactor(0.7)]}>
        {props.name}
      </Text>
      {props.service ? (
        <Text modifiers={[font({ size: 14 }), foregroundStyle(secondary), lineLimit(1)]}>
          {props.service}
        </Text>
      ) : null}
    </VStack>
  );
  const when = (
    <VStack alignment="leading" spacing={1}>
      <Text modifiers={[font({ size: 17, weight: 'semibold' })]}>{props.time}</Text>
      <Text
        date={new Date(props.start)}
        dateStyle="relative"
        modifiers={[font({ size: 13 }), foregroundStyle(secondary), lineLimit(1)]}
      />
    </VStack>
  );

  if (env.widgetFamily === 'systemMedium') {
    return (
      <VStack alignment="leading" spacing={8} modifiers={root}>
        {header}
        <Spacer />
        <HStack alignment="bottom">
          {details}
          <Spacer />
          <VStack alignment="trailing" spacing={1}>
            <Text modifiers={[font({ size: 17, weight: 'semibold' })]}>{props.time}</Text>
            <Text
              date={new Date(props.start)}
              dateStyle="relative"
              modifiers={[font({ size: 13 }), foregroundStyle(secondary)]}
            />
          </VStack>
        </HStack>
        <Text modifiers={[font({ size: 12 }), foregroundStyle(secondary)]}>
          {`${props.remaining === 1 ? 'Last client today' : `${props.remaining} clients still to come`}${props.inChair ? ` · ${props.inChair} in the chair` : ''}`}
        </Text>
      </VStack>
    );
  }

  return (
    <VStack alignment="leading" spacing={6} modifiers={root}>
      {header}
      <Spacer />
      {details}
      <HStack modifiers={[frame({ maxWidth: 1000, alignment: 'leading' })]}>{when}</HStack>
    </VStack>
  );
};

export default createWidget<NextClientProps>('ChairsideNextClient', NextClientWidget, {
  name: null,
  service: null,
  time: null,
  start: null,
  inChair: null,
  remaining: 0,
  today: false,
});
