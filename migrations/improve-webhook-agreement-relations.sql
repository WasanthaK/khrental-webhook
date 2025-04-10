-- Improve webhook_events and agreements tables relationship
-- This migration script adds proper typing, constraints, and indexes

-- 0. First drop any views that depend on the columns we're modifying
DROP VIEW IF EXISTS agreement_signature_status;

-- 1. Then modify the webhook_events table
ALTER TABLE webhook_events
ALTER COLUMN request_id TYPE UUID USING 
    CASE 
        WHEN request_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' 
        THEN request_id::UUID 
        ELSE NULL 
    END;

-- 2. Create a proper index on webhook_events.request_id
DROP INDEX IF EXISTS idx_webhook_events_request_id;
CREATE INDEX idx_webhook_events_request_id ON webhook_events(request_id);

-- 3. Modify the agreements table to use UUID for eviasignreference
-- Create temporary column first to avoid data loss
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT FROM information_schema.columns 
    WHERE table_name = 'agreements' AND column_name = 'eviasignreference_uuid'
  ) THEN
    ALTER TABLE agreements ADD COLUMN eviasignreference_uuid UUID;
  END IF;
END $$;

-- Update the new column with converted values where possible
UPDATE agreements
SET eviasignreference_uuid = 
    CASE 
        WHEN eviasignreference::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' 
        THEN eviasignreference::UUID 
        ELSE NULL 
    END
WHERE eviasignreference IS NOT NULL AND eviasignreference_uuid IS NULL;

-- Create an index for faster lookups
DROP INDEX IF EXISTS idx_agreements_eviasignreference_uuid;
CREATE INDEX idx_agreements_eviasignreference_uuid ON agreements(eviasignreference_uuid);

-- 4. Create proper view to lookup agreements by request ID 
CREATE OR REPLACE VIEW agreement_signature_status AS
SELECT 
    a.id as agreement_id,
    a.eviasignreference_uuid as request_id,
    a.status as agreement_status,
    a.signature_status,
    a.signatories_status,
    w.event_id as last_event_id,
    w.event_type as last_event_type,
    w.event_time as last_event_time
FROM 
    agreements a
LEFT JOIN (
    SELECT 
        request_id, 
        event_id,
        event_type,
        event_time,
        ROW_NUMBER() OVER (PARTITION BY request_id ORDER BY event_time DESC) as rn
    FROM 
        webhook_events
) w ON a.eviasignreference_uuid = w.request_id AND w.rn = 1
WHERE 
    a.eviasignreference_uuid IS NOT NULL;

-- 5. Add comment to explain the change
COMMENT ON VIEW agreement_signature_status IS 'This view shows the current status of all agreements with their signature status from webhook events';

-- 6. Create function to keep agreement signature status in sync with webhook events
CREATE OR REPLACE FUNCTION update_agreement_from_webhook()
RETURNS TRIGGER AS $$
DECLARE
    status_map TEXT;
    signatory_data JSONB;
    current_signatories JSONB;
    column_exists BOOLEAN;
BEGIN
    -- Map event_id to signature_status
    CASE NEW.event_id
        WHEN 1 THEN status_map := 'pending';
        WHEN 2 THEN status_map := 'in_progress';
        WHEN 3 THEN status_map := 'completed';
        ELSE status_map := NULL;
    END CASE;
    
    -- Only proceed if we have a valid status map and request_id
    IF status_map IS NULL OR NEW.request_id IS NULL THEN
        RETURN NEW;
    END IF;
    
    -- Handle signatory data for EventId 2 (SignatoryCompleted)
    IF NEW.event_id = 2 AND NEW.user_email IS NOT NULL THEN
        -- Create signatory info
        signatory_data := jsonb_build_object(
            'name', COALESCE(NEW.user_name, 'Unknown'),
            'email', NEW.user_email,
            'status', 'completed',
            'signedAt', COALESCE(NEW.event_time, NOW())
        );
        
        -- Get current signatories if any
        BEGIN
            -- Check if signatories_status column exists
            SELECT EXISTS (
                SELECT FROM information_schema.columns
                WHERE table_name = 'agreements' AND column_name = 'signatories_status'
            ) INTO column_exists;
            
            IF column_exists THEN
                SELECT signatories_status INTO current_signatories
                FROM agreements
                WHERE eviasignreference_uuid = NEW.request_id;
                
                -- Initialize if null
                IF current_signatories IS NULL THEN
                    current_signatories := '[]'::jsonb;
                END IF;
                
                -- Add or update signatory
                -- Check if signatory already exists
                BEGIN
                    WITH existing_signatory AS (
                        SELECT jsonb_array_elements(current_signatories) ->> 'email' as email
                    )
                    SELECT 
                        CASE 
                            WHEN EXISTS (SELECT 1 FROM existing_signatory WHERE email = NEW.user_email) THEN
                                (
                                    SELECT jsonb_agg(
                                        CASE 
                                            WHEN (x ->> 'email') = NEW.user_email THEN signatory_data
                                            ELSE x
                                        END
                                    )
                                    FROM jsonb_array_elements(current_signatories) x
                                )
                            ELSE
                                jsonb_insert(current_signatories, '{0}', signatory_data)
                        END INTO current_signatories;
                EXCEPTION
                    WHEN OTHERS THEN
                        -- If there's an error processing the JSON, just create a new array
                        current_signatories := jsonb_build_array(signatory_data);
                END;
            END IF;
        EXCEPTION
            WHEN OTHERS THEN
                -- If there's an error, just continue without updating signatories
                NULL;
        END;
    END IF;
    
    -- Update agreement based on event type
    IF NEW.event_id = 3 THEN
        -- For completed events (signed)
        BEGIN
            UPDATE agreements
            SET 
                status = 'signed',
                updatedat = NOW()
            WHERE 
                eviasignreference_uuid = NEW.request_id;
                
            -- Now check and update signature-specific fields if they exist
            PERFORM column_name FROM information_schema.columns 
            WHERE table_name = 'agreements' AND column_name = 'signature_status';
            IF FOUND THEN
                UPDATE agreements
                SET signature_status = status_map
                WHERE eviasignreference_uuid = NEW.request_id;
            END IF;
            
            PERFORM column_name FROM information_schema.columns 
            WHERE table_name = 'agreements' AND column_name = 'signature_completed_at';
            IF FOUND THEN
                UPDATE agreements
                SET signature_completed_at = COALESCE(NEW.event_time, NOW())
                WHERE eviasignreference_uuid = NEW.request_id;
            END IF;
        EXCEPTION
            WHEN OTHERS THEN
                -- Log the error but don't fail the trigger
                RAISE NOTICE 'Error updating signed status: %', SQLERRM;
        END;
    ELSIF NEW.event_id = 2 THEN
        -- For signatory completed events (partially signed)
        BEGIN
            UPDATE agreements
            SET 
                status = 'partially_signed',
                updatedat = NOW()
            WHERE 
                eviasignreference_uuid = NEW.request_id;
                
            -- Update signature_status if it exists
            PERFORM column_name FROM information_schema.columns 
            WHERE table_name = 'agreements' AND column_name = 'signature_status';
            IF FOUND THEN
                UPDATE agreements
                SET signature_status = status_map
                WHERE eviasignreference_uuid = NEW.request_id;
            END IF;
            
            -- Update signatories_status if it exists and we have data
            IF column_exists AND current_signatories IS NOT NULL THEN
                UPDATE agreements
                SET signatories_status = current_signatories
                WHERE eviasignreference_uuid = NEW.request_id;
            END IF;
        EXCEPTION
            WHEN OTHERS THEN
                -- Log the error but don't fail the trigger
                RAISE NOTICE 'Error updating partially signed status: %', SQLERRM;
        END;
    ELSIF NEW.event_id = 1 THEN
        -- For sign request received events (pending signature)
        BEGIN
            UPDATE agreements
            SET 
                status = 'pending_signature',
                updatedat = NOW()
            WHERE 
                eviasignreference_uuid = NEW.request_id;
                
            -- Update signature_status if it exists
            PERFORM column_name FROM information_schema.columns 
            WHERE table_name = 'agreements' AND column_name = 'signature_status';
            IF FOUND THEN
                UPDATE agreements
                SET signature_status = status_map
                WHERE eviasignreference_uuid = NEW.request_id;
            END IF;
            
            -- Update signature_sent_at if it exists
            PERFORM column_name FROM information_schema.columns 
            WHERE table_name = 'agreements' AND column_name = 'signature_sent_at';
            IF FOUND THEN
                UPDATE agreements
                SET signature_sent_at = COALESCE(NEW.event_time, NOW())
                WHERE eviasignreference_uuid = NEW.request_id;
            END IF;
        EXCEPTION
            WHEN OTHERS THEN
                -- Log the error but don't fail the trigger
                RAISE NOTICE 'Error updating pending signature status: %', SQLERRM;
        END;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to automatically update agreements when webhook events are inserted
DROP TRIGGER IF EXISTS webhook_event_trigger ON webhook_events;
CREATE TRIGGER webhook_event_trigger
AFTER INSERT ON webhook_events
FOR EACH ROW
EXECUTE FUNCTION update_agreement_from_webhook();

-- Instructions for applying this migration:
-- 1. After applying this migration, test with a webhook event to ensure the trigger works
-- 2. Once confirmed working, you can safely drop the old eviasignreference column and rename eviasignreference_uuid to eviasignreference
-- 3. Run: ALTER TABLE agreements DROP COLUMN eviasignreference, RENAME COLUMN eviasignreference_uuid TO eviasignreference 