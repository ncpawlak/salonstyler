import { Gauge, HStack, Image, Spacer, Text, VStack } from '@expo/ui/swift-ui';
import {
  containerBackground,
  font,
  foregroundStyle,
  gaugeStyle,
  scaleEffect,
  tint,
  widgetURL,
} from '@expo/ui/swift-ui/modifiers';
import { createWidget, type WidgetEnvironment } from 'expo-widgets';
import { PlatformColor } from 'react-native';

import type { DayBookedProps } from '@/features/glance/glance';

/** "Today booked" widget (#40): a donut of how much of today's open time is booked. */
const DayBookedWidget = (props: DayBookedProps, env: WidgetEnvironment) => {
  'widget';
  const accent = env.widgetRenderingMode === 'fullColor' ? '#4F46E5' : PlatformColor('label');
  const secondary = { type: 'hierarchical', style: 'secondary' } as const;
  const root = [
    containerBackground(PlatformColor('systemBackground'), 'widget'),
    widgetURL('chairside:///calendar'),
  ];
  const percent = props.today ? `${props.percent}%` : '–';
  const caption = !props.today
    ? 'Open Chairside'
    : !props.open
      ? 'Closed today'
      : `${props.clients} ${props.clients === 1 ? 'client' : 'clients'}`;

  if (env.widgetFamily === 'accessoryCircular') {
    return (
      <Gauge
        value={props.share}
        currentValueLabel={<Text modifiers={[font({ size: 14, weight: 'bold' })]}>{percent}</Text>}
        modifiers={[...root, gaugeStyle('circularCapacity')]}
      >
        <Text>Booked</Text>
      </Gauge>
    );
  }

  return (
    <VStack alignment="leading" spacing={6} modifiers={root}>
      <HStack spacing={4}>
        <Image systemName="calendar" color={accent} size={13} />
        <Text modifiers={[font({ size: 13, weight: 'semibold' }), foregroundStyle(accent)]}>
          Today
        </Text>
        <Spacer />
      </HStack>
      <Spacer />
      <HStack>
        <Spacer />
        <Gauge
          value={props.share}
          currentValueLabel={
            <Text modifiers={[font({ size: 13, weight: 'bold', design: 'rounded' })]}>
              {percent}
            </Text>
          }
          modifiers={[gaugeStyle('circularCapacity'), tint(accent), scaleEffect(1.5)]}
        >
          <Text>Booked</Text>
        </Gauge>
        <Spacer />
      </HStack>
      <Spacer />
      <Text modifiers={[font({ size: 15, weight: 'semibold' })]}>{`${percent} booked`}</Text>
      <Text modifiers={[font({ size: 12 }), foregroundStyle(secondary)]}>{caption}</Text>
    </VStack>
  );
};

export default createWidget<DayBookedProps>('ChairsideDayBooked', DayBookedWidget, {
  share: 0,
  percent: 0,
  clients: 0,
  open: true,
  today: false,
});
