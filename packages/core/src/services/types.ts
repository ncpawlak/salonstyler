/**
 * Service builder types. See docs/PLAN.md §3 and Appendix A.
 *
 * Segments reuse the availability engine's `ServiceSegment` so a resolved service can be passed
 * straight to `findSlots({ service })` / `layoutService`.
 */
import type { DurationOverride, ServiceRequest, ServiceSegment } from '../availability/types.ts';

/** Calendar color tags. Mirrors the `color_tag` check in supabase/migrations/*_service_builder.sql. */
export const SERVICE_COLOR_TAGS = [
  'gray',
  'red',
  'orange',
  'amber',
  'green',
  'teal',
  'blue',
  'indigo',
  'purple',
  'pink',
] as const;
export type ServiceColorTag = (typeof SERVICE_COLOR_TAGS)[number];

/** Where an add-on's segments go in the service. */
export type AddonPlacement =
  /** Before the trailing `style` (finish) segments, e.g. toner before the blow-dry. */
  | 'before_finish'
  /** After the last segment, e.g. a blowout finish. */
  | 'end';

/** Hair length (or similar) variant: total minutes added across the hands-on busy/style segments. */
export interface ServiceVariant {
  id?: string;
  name: string;
  deltaMinutes: number;
}

export interface ServiceAddon {
  id?: string;
  name: string;
  segments: ServiceSegment[];
  placement: AddonPlacement;
  priceCents: number | null;
}

/** The bookable shape of a single service (DB-agnostic). */
export interface ServiceDefinition {
  id?: string;
  name: string;
  category: string;
  description?: string | null;
  priceCents: number | null;
  colorTag: ServiceColorTag;
  segments: ServiceSegment[];
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  consultationRequired: boolean;
  bookableOnline: boolean;
  newClientsOnly: boolean;
  variants: ServiceVariant[];
}

/** The minimal service shape the resolvers need. */
export interface ResolvableService {
  segments: readonly ServiceSegment[];
  bufferBeforeMinutes?: number;
  bufferAfterMinutes?: number;
  priceCents?: number | null;
}

export interface ComboItem {
  service: ResolvableService;
  /**
   * Drop the trailing `style` segments built so far before appending this service. E.g. in
   * "Balayage + Women's cut" the cut replaces the balayage's rinse/style.
   */
  replacesPreviousFinish?: boolean;
}

export interface ResolveOptions {
  variant?: Pick<ServiceVariant, 'deltaMinutes'> | null;
  addons?: readonly Pick<ServiceAddon, 'segments' | 'placement' | 'priceCents'>[];
  /** Per-client overrides, indexed into the final resolved segment list. */
  overrides?: DurationOverride[];
}

export interface ResolveComboOptions extends ResolveOptions {
  /** The combo's own price. Omit/null to sum the item prices. */
  priceCents?: number | null;
}

/** A resolved booking: a `ServiceRequest` for the availability engine plus totals. */
export interface ResolvedService extends ServiceRequest {
  segments: ServiceSegment[];
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  /** Client time: sum of segment minutes, excluding buffers. */
  totalMinutes: number;
  /** Hands-on minutes (busy + style). */
  handsOnMinutes: number;
  /** Processing minutes (the stylist is free for someone else). */
  processingMinutes: number;
  /** Service price (or combo price/sum) plus add-on prices; null when any part is unpriced. */
  priceCents: number | null;
}
