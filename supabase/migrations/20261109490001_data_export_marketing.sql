-- Register marketing (#27, 20261109490000) with the full data export (#46). Sorts after both.
-- clients.marketing_token unlocks a client's unsubscribe link: it's unique and secret, so it
-- isn't exported and the restored salon issues fresh links. Consent (marketing_opt_in,
-- marketing_opted_out_at) and the settings.marketing_* columns travel with their tables.
select private.register_data_export('clients', array['marketing_token']);
select private.register_data_export('marketing_campaigns');
select private.register_data_export('marketing_messages', '{}',
  'Drafts, the send queue and the history; queued messages stay queued after a restore');
