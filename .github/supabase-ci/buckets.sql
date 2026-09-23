-- The storage buckets the app uses. Production's were created outside the
-- migrations, so a fresh stack needs them created explicitly (FOLLOWUPS: move
-- this into a migration so a from-zero rebuild has them too).
insert into storage.buckets (id, name, public) values
  ('order-documents', 'order-documents', false),
  ('invoices',        'invoices',        false),
  ('kyc-documents',   'kyc-documents',   false),
  ('rfq-attachments', 'rfq-attachments', false),
  ('licence-certificates', 'licence-certificates', false),
  ('wa-media',        'wa-media',        false),
  ('public-assets',   'public-assets',   true)
on conflict (id) do nothing;
