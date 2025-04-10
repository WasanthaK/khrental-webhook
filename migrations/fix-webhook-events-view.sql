-- Drop the agreement_signature_status view that was created unnecessarily
-- We're using direct status fields on the agreements table instead of a separate view

-- First check if the view exists, then drop it
DO $$ 
BEGIN
  IF EXISTS (
    SELECT FROM pg_catalog.pg_views 
    WHERE schemaname = 'public' AND viewname = 'agreement_signature_status'
  ) THEN
    DROP VIEW IF EXISTS agreement_signature_status;
    RAISE NOTICE 'Dropped the agreement_signature_status view';
  ELSE
    RAISE NOTICE 'The agreement_signature_status view does not exist, nothing to drop';
  END IF;
END $$; 