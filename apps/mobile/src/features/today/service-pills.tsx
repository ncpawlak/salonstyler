import type { ServiceColorTag } from '@chairside/core';
import type { AppointmentServiceSnapshot } from '@chairside/db';
import { View } from 'react-native';

import { Text } from '@/components/ui';

import { COLOR_HEX } from '../services/colors';

export function serviceColor(tag: string | null | undefined): string {
  return COLOR_HEX[(tag ?? '') as ServiceColorTag] ?? COLOR_HEX.indigo;
}

/** Booked services as color-coded pills (the calendar's service colors). */
export function ServicePills({ services }: { services: readonly AppointmentServiceSnapshot[] }) {
  if (!services.length) return null;
  return (
    <View className="flex-row flex-wrap gap-2">
      {services.map((s, i) => {
        const hex = serviceColor(s.colorTag);
        return (
          <View
            key={`${s.serviceId}-${i}`}
            className="h-8 flex-row items-center gap-1.5 rounded-full px-3"
            style={{ backgroundColor: `${hex}1F` }}
          >
            <View className="h-2 w-2 rounded-full" style={{ backgroundColor: hex }} />
            <Text variant="footnote" className="font-medium" numberOfLines={1}>
              {s.variantName ? `${s.name} · ${s.variantName}` : s.name}
            </Text>
          </View>
        );
      })}
    </View>
  );
}
