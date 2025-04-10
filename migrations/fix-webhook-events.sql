-- Fix webhook_events table to work with existing database schema
-- This script removes dependencies on eviasignreference_uuid

-- 1. Create a backup of the webhook_event_trigger function
CREATE OR REPLACE FUNCTION update_agreement_from_webhook_backup()
RETURNS TRIGGER AS $$
BEGIN
    -- Just a placeholder function to store the original
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 2. Drop the existing trigger that's causing errors
DROP TRIGGER IF EXISTS webhook_event_trigger ON webhook_events;

-- 3. Create a new version of the trigger function that uses eviasignreference instead
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
                WHERE eviasignreference = NEW.request_id::text;
                
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
                eviasignreference = NEW.request_id::text;
                
            -- Now check and update signature-specific fields if they exist
            PERFORM column_name FROM information_schema.columns 
            WHERE table_name = 'agreements' AND column_name = 'signature_status';
            IF FOUND THEN
                UPDATE agreements
                SET signature_status = status_map
                WHERE eviasignreference = NEW.request_id::text;
            END IF;
            
            PERFORM column_name FROM information_schema.columns 
            WHERE table_name = 'agreements' AND column_name = 'signature_completed_at';
            IF FOUND THEN
                UPDATE agreements
                SET signature_completed_at = COALESCE(NEW.event_time, NOW())
                WHERE eviasignreference = NEW.request_id::text;
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
                eviasignreference = NEW.request_id::text;
                
            -- Update signature_status if it exists
            PERFORM column_name FROM information_schema.columns 
            WHERE table_name = 'agreements' AND column_name = 'signature_status';
            IF FOUND THEN
                UPDATE agreements
                SET signature_status = status_map
                WHERE eviasignreference = NEW.request_id::text;
            END IF;
            
            -- Update signatories_status if it exists and we have data
            IF column_exists AND current_signatories IS NOT NULL THEN
                UPDATE agreements
                SET signatories_status = current_signatories
                WHERE eviasignreference = NEW.request_id::text;
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
                eviasignreference = NEW.request_id::text;
                
            -- Update signature_status if it exists
            PERFORM column_name FROM information_schema.columns 
            WHERE table_name = 'agreements' AND column_name = 'signature_status';
            IF FOUND THEN
                UPDATE agreements
                SET signature_status = status_map
                WHERE eviasignreference = NEW.request_id::text;
            END IF;
            
            -- Update signature_sent_at if it exists
            PERFORM column_name FROM information_schema.columns 
            WHERE table_name = 'agreements' AND column_name = 'signature_sent_at';
            IF FOUND THEN
                UPDATE agreements
                SET signature_sent_at = COALESCE(NEW.event_time, NOW())
                WHERE eviasignreference = NEW.request_id::text;
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

-- 4. Create a new trigger using the updated function
CREATE TRIGGER webhook_event_trigger
AFTER INSERT ON webhook_events
FOR EACH ROW
EXECUTE FUNCTION update_agreement_from_webhook(); 