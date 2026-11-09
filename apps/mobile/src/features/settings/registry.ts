/// <reference types="expo/types" />
import { sortRows, type SettingsRow, type SettingsSection } from './row';

// Metro bundles every file in ./rows, so a new row needs no edit here or in the screen.
const context = require.context('./rows', false, /\.tsx?$/);
const rows: SettingsRow[] = context
  .keys()
  .filter((key) => !/\.test\.tsx?$/.test(key))
  .map((key) => (context(key) as { default: SettingsRow }).default);

export const settingsRows = (section: SettingsSection) => sortRows(rows, section);
