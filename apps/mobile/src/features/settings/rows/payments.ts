import { defineSettingsRow } from '../row';

export default defineSettingsRow({
  section: 'salon',
  order: 80,
  title: 'Payments',
  subtitle: 'Stripe account, card payments and payouts',
  icon: 'card-outline',
  href: '/settings/payments',
});
