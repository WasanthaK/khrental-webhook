-- Update agreement status constraints to include the new lifecycle states
-- Drop the existing constraint if it exists
ALTER TABLE agreements DROP CONSTRAINT IF EXISTS agreements_status_check;

-- Create a new constraint with the updated status values that includes the new lifecycle states
ALTER TABLE agreements 
ADD CONSTRAINT agreements_status_check 
CHECK (status IN (
    -- Original statuses
    'draft', 
    'review', 
    'pending', 
    'signed', 
    'expired', 
    'cancelled',
    
    -- New lifecycle states
    'created',
    'pending_activation',
    'active',
    'rejected',
    
    -- Transitional states
    'partially_signed',
    'pending_signature'
));

-- Update signature_status constraint to make signature steps more explicit
ALTER TABLE agreements DROP CONSTRAINT IF EXISTS agreements_signature_status_check;

ALTER TABLE agreements
ADD CONSTRAINT agreements_signature_status_check 
CHECK (signature_status IN (
    -- Original statuses
    'pending', 
    'in_progress', 
    'completed', 
    'failed',
    
    -- New signature steps
    'send_for_signature',
    'signed_by_landlord',
    'signed_by_tenant',
    'signing_complete',
    'rejected'
));

-- Add comment to explain the change
COMMENT ON COLUMN agreements.status IS 'Current lifecycle state of the agreement (created, pending_activation, active, expired, etc.)';
COMMENT ON COLUMN agreements.signature_status IS 'Current step in the signature process (send_for_signature, signed_by_xx, signing_complete, etc.)'; 