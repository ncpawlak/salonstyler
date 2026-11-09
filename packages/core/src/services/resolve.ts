import { applyDurationOverrides, validateSegments } from '../availability/segments.ts';
import type { SegmentKind, ServiceSegment } from '../availability/types.ts';
import type {
  ClientDurationAdjustment,
  ComboItem,
  ResolvableService,
  ResolveComboOptions,
  ResolvedService,
  ResolveOptions,
  ServiceAddon,
} from './types.ts';

const VARIANT_KINDS: ReadonlySet<SegmentKind> = new Set(['busy', 'style']);

export const DEFAULT_SEGMENT_LABELS: Record<SegmentKind, string> = {
  busy: 'Busy',
  processing: 'Process',
  style: 'Style',
};

export function segmentLabel(segment: ServiceSegment): string {
  return segment.label?.trim() || DEFAULT_SEGMENT_LABELS[segment.kind];
}

export function totalMinutes(segments: readonly ServiceSegment[]): number {
  return segments.reduce((sum, s) => sum + s.minutes, 0);
}

/** 45 -> "45m", 95 -> "1h35", 180 -> "3h00" (Appendix A style). */
export function formatDuration(minutes: number): string {
  const sign = minutes < 0 ? '-' : '';
  const m = Math.abs(Math.round(minutes));
  if (m < 60) return `${sign}${m}m`;
  return `${sign}${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
}

/** "Apply 30 → Process 35 → Style 30" */
export function describeSegments(segments: readonly ServiceSegment[]): string {
  return segments.map((s) => `${segmentLabel(s)} ${s.minutes}`).join(' → ');
}

function copy(segments: readonly ServiceSegment[]): ServiceSegment[] {
  return segments.map((s) => ({ ...s }));
}

/**
 * Spreads a variant's `deltaMinutes` over the hands-on (busy/style) segments, proportionally to
 * their length, in 5-minute steps when the delta allows (largest remainder; ties go to the earlier
 * segment). The total always changes by exactly `deltaMinutes`. Processing time is untouched.
 */
export function applyVariant(
  segments: readonly ServiceSegment[],
  deltaMinutes: number,
): ServiceSegment[] {
  const out = copy(segments);
  if (!Number.isInteger(deltaMinutes))
    throw new RangeError(`Variant minutes must be an integer, got ${deltaMinutes}`);
  if (deltaMinutes === 0) return out;
  const eligible = out.flatMap((s, i) => (VARIANT_KINDS.has(s.kind) ? [i] : []));
  if (eligible.length === 0) throw new RangeError('A variant needs a busy or style segment');

  const step = deltaMinutes % 5 === 0 ? 5 : 1;
  const units = Math.abs(deltaMinutes) / step;
  const sign = Math.sign(deltaMinutes);
  const weight = eligible.reduce((sum, i) => sum + out[i]!.minutes, 0);
  const shares = eligible.map((i) => (units * out[i]!.minutes) / weight);
  const alloc = shares.map(Math.floor);
  let left = units - alloc.reduce((a, b) => a + b, 0);
  const order = shares
    .map((s, k) => ({ k, frac: s - Math.floor(s) }))
    .sort((a, b) => b.frac - a.frac || a.k - b.k);
  for (const { k } of order) {
    if (left <= 0) break;
    alloc[k]! += 1;
    left -= 1;
  }
  eligible.forEach((i, k) => {
    out[i]!.minutes += sign * alloc[k]! * step;
  });
  validateSegments(out);
  return out;
}

/**
 * Applies a client's per-service duration change: to one segment when `segmentIndex` is set,
 * otherwise spread over the hands-on segments like a variant. The result must stay valid
 * (every segment at least a minute).
 */
export function applyClientAdjustment(
  segments: readonly ServiceSegment[],
  adjustment: ClientDurationAdjustment,
): ServiceSegment[] {
  const { deltaMinutes, segmentIndex } = adjustment;
  if (!Number.isInteger(deltaMinutes))
    throw new RangeError(`Override minutes must be an integer, got ${deltaMinutes}`);
  if (segmentIndex == null) return applyVariant(segments, deltaMinutes);
  const out = copy(segments);
  const seg = out[segmentIndex];
  if (!seg) throw new RangeError(`Override segment out of range: ${segmentIndex}`);
  seg.minutes += deltaMinutes;
  validateSegments(out);
  return out;
}

/** Index where `before_finish` add-ons go: before the trailing run of `style` segments. */
export function finishIndex(segments: readonly ServiceSegment[]): number {
  let i = segments.length;
  while (i > 0 && segments[i - 1]!.kind === 'style') i--;
  return i;
}

export function validateAddonSegments(segments: readonly ServiceSegment[]): void {
  if (segments.length === 0) throw new RangeError('An add-on needs at least one segment');
  for (const s of segments) {
    if (!Number.isInteger(s.minutes) || s.minutes <= 0)
      throw new RangeError(`Segment minutes must be a positive integer, got ${s.minutes}`);
  }
}

/** Inserts add-on segments (in the given order) per their placement. */
export function applyAddons(
  segments: readonly ServiceSegment[],
  addons: readonly Pick<ServiceAddon, 'segments' | 'placement'>[],
): ServiceSegment[] {
  const head = copy(segments);
  const finish = head.splice(finishIndex(head));
  const tail: ServiceSegment[] = [];
  for (const addon of addons) {
    // Add-ons may start/end with processing (e.g. toner before the rinse); the result is validated.
    validateAddonSegments(addon.segments);
    (addon.placement === 'end' ? tail : head).push(...copy(addon.segments));
  }
  const out = [...head, ...finish, ...tail];
  validateSegments(out);
  return out;
}

/**
 * Builds a combo's segment list in order. Buffers come from the first (before) and last (after)
 * services. An item with `replacesPreviousFinish` drops the trailing `style` segments built so far.
 */
export function combineServices(items: readonly ComboItem[]): {
  segments: ServiceSegment[];
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
} {
  if (items.length === 0) throw new RangeError('A combo needs at least one service');
  const segments: ServiceSegment[] = [];
  items.forEach((item, i) => {
    validateSegments(item.service.segments);
    if (i > 0 && item.replacesPreviousFinish) segments.splice(finishIndex(segments));
    segments.push(...copy(item.service.segments));
  });
  validateSegments(segments);
  return {
    segments,
    bufferBeforeMinutes: items[0]!.service.bufferBeforeMinutes ?? 0,
    bufferAfterMinutes: items[items.length - 1]!.service.bufferAfterMinutes ?? 0,
  };
}

function finalize(
  base: { segments: ServiceSegment[]; bufferBeforeMinutes: number; bufferAfterMinutes: number },
  basePrice: number | null,
  options: ResolveOptions,
): ResolvedService {
  if (base.bufferBeforeMinutes < 0 || base.bufferAfterMinutes < 0)
    throw new RangeError('Buffers cannot be negative');
  let segments = base.segments;
  if (options.variant) segments = applyVariant(segments, options.variant.deltaMinutes);
  if (options.clientAdjustment)
    segments = applyClientAdjustment(segments, options.clientAdjustment);
  const addons = options.addons ?? [];
  if (addons.length > 0) segments = applyAddons(segments, addons);
  segments = applyDurationOverrides(segments, options.overrides);

  let priceCents = basePrice;
  for (const a of addons) {
    priceCents = priceCents === null || a.priceCents == null ? null : priceCents + a.priceCents;
  }
  const processingMinutes = totalMinutes(segments.filter((s) => s.kind === 'processing'));
  const total = totalMinutes(segments);
  return {
    segments,
    bufferBeforeMinutes: base.bufferBeforeMinutes,
    bufferAfterMinutes: base.bufferAfterMinutes,
    totalMinutes: total,
    handsOnMinutes: total - processingMinutes,
    processingMinutes,
    priceCents,
  };
}

/**
 * Resolves a service (+ variant, add-ons, per-client overrides) into the segment list the
 * availability engine books. Order: variant → client adjustment → add-ons → overrides.
 */
export function resolveService(
  service: ResolvableService,
  options: ResolveOptions = {},
): ResolvedService {
  validateSegments(service.segments);
  return finalize(
    {
      segments: copy(service.segments),
      bufferBeforeMinutes: service.bufferBeforeMinutes ?? 0,
      bufferAfterMinutes: service.bufferAfterMinutes ?? 0,
    },
    service.priceCents ?? null,
    options,
  );
}

/** Resolves a combo; the variant applies to the combined hands-on segments. */
export function resolveCombo(
  items: readonly ComboItem[],
  options: ResolveComboOptions = {},
): ResolvedService {
  const combined = combineServices(items);
  let price: number | null;
  if (options.priceCents != null) price = options.priceCents;
  else
    price = items.reduce<number | null>(
      (sum, item) =>
        sum === null || item.service.priceCents == null ? null : sum + item.service.priceCents,
      0,
    );
  return finalize(combined, price, options);
}
