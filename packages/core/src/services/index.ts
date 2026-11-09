export * from './types.ts';
export {
  DEFAULT_SEGMENT_LABELS,
  applyAddons,
  applyClientAdjustment,
  applyVariant,
  combineServices,
  describeSegments,
  finishIndex,
  formatDuration,
  resolveCombo,
  resolveService,
  segmentLabel,
  totalMinutes,
  validateAddonSegments,
} from './resolve.ts';
export { HAIR_LENGTH_VARIANTS, STARTER_CATEGORIES, STARTER_MENU } from './starter-menu.ts';
export type {
  StarterAddon,
  StarterCombo,
  StarterComboItem,
  StarterMenu,
  StarterService,
} from './starter-menu.ts';
