import { defineSettingsRow } from '../row';

export default defineSettingsRow({
  section: 'salon',
  order: 90,
  title: 'Import from Vagaro',
  subtitle: 'Clients and upcoming appointments from a spreadsheet',
  icon: 'cloud-download-outline',
  href: '/import',
});
