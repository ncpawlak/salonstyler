import type { Href } from 'expo-router';

import type { IconName } from '@/components/ui';

export type SettingsSection = 'salon' | 'previews';

/** One row on the Settings screen. Each lives in its own file in `./rows/`. */
export type SettingsRow = {
  section: SettingsSection;
  /** Position within the section (ascending). Leave gaps so new rows slot in without edits. */
  order: number;
  title: string;
  subtitle?: string;
  icon: IconName;
  href: Href;
};

/** Declares a Settings row. Export it as the default of a new file in `./rows/`; that's all. */
export const defineSettingsRow = (row: SettingsRow): SettingsRow => row;

export const sortRows = (rows: SettingsRow[], section: SettingsSection) =>
  rows.filter((r) => r.section === section).sort((a, b) => a.order - b.order);
