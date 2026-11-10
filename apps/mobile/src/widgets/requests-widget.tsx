import { HStack, Image, Spacer, Text, VStack } from '@expo/ui/swift-ui';
import {
  containerBackground,
  font,
  foregroundStyle,
  monospacedDigit,
  widgetURL,
} from '@expo/ui/swift-ui/modifiers';
import { createWidget, type WidgetEnvironment } from 'expo-widgets';
import { PlatformColor } from 'react-native';

import type { RequestsProps } from '@/features/glance/glance';

/** "Requests" widget (#40): booking requests waiting for an answer. */
const RequestsWidget = (props: RequestsProps, env: WidgetEnvironment) => {
  'widget';
  const accent = env.widgetRenderingMode === 'fullColor' ? '#D97706' : PlatformColor('label');
  const secondary = { type: 'hierarchical', style: 'secondary' } as const;
  const root = [
    containerBackground(PlatformColor('systemBackground'), 'widget'),
    widgetURL('chairside:///inbox'),
  ];
  const label =
    props.count === 0
      ? 'No requests waiting'
      : props.count === 1
        ? '1 request waiting'
        : `${props.count} requests waiting`;

  if (env.widgetFamily === 'accessoryInline') {
    return <Text modifiers={root}>{label}</Text>;
  }

  if (env.widgetFamily === 'accessoryCircular') {
    return (
      <VStack spacing={0} modifiers={root}>
        <Image systemName="tray" size={12} />
        <Text
          modifiers={[font({ size: 22, weight: 'bold', design: 'rounded' }), monospacedDigit()]}
        >
          {`${props.count}`}
        </Text>
      </VStack>
    );
  }

  return (
    <VStack alignment="leading" spacing={6} modifiers={root}>
      <HStack spacing={4}>
        <Image systemName="tray.full" color={accent} size={13} />
        <Text modifiers={[font({ size: 13, weight: 'semibold' }), foregroundStyle(accent)]}>
          Requests
        </Text>
        <Spacer />
      </HStack>
      <Spacer />
      <Text modifiers={[font({ size: 44, weight: 'bold', design: 'rounded' }), monospacedDigit()]}>
        {`${props.count}`}
      </Text>
      <Text modifiers={[font({ size: 13 }), foregroundStyle(secondary)]}>
        {props.count === 0 ? 'All caught up' : 'Waiting for you'}
      </Text>
    </VStack>
  );
};

export default createWidget<RequestsProps>('ChairsideRequests', RequestsWidget, { count: 0 });
