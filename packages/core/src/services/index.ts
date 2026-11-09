export * from './types';
export {
  DEFAULT_SEGMENT_LABELS,
  applyAddons,
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
} from './resolve';
export { HAIR_LENGTH_VARIANTS, STARTER_CATEGORIES, STARTER_MENU } from './starter-menu';
export type {
  StarterAddon,
  StarterCombo,
  StarterComboItem,
  StarterMenu,
  StarterService,
} from './starter-menu';
