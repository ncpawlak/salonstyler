-- Register service recipes (#18, 20261109480000) with the full data export (#46). This sorts
-- after both migrations so the table exists. Later features register in their own migration.
select private.register_data_export('service_recipes');
