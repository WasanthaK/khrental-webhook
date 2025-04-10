// Signature webhook service for Evia Sign webhook processing
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import supabaseImport, { insertWebhookEvent } from './supabaseClient.js';

// Use the imported supabase client
const supabase = supabaseImport;

// Load environment variables
dotenv.config();

// Set up file paths for logging
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOGS_DIR = path.join(__dirname, '..', 'data');
const LOGS_PATH = path.join(LOGS_DIR, 'signature-logs.txt');

// Ensure logs directory exists
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

// Event types for Evia Sign
const SIGNATURE_EVENT_TYPES = {
  // SignRequestReceived
  SIGN_REQUEST_RECEIVED: 1,
  // SignatoryCompleted - When one signatory completes but others haven't
  SIGNATORY_COMPLETED: 2, 
  // RequestCompleted - All signatories have completed
  REQUEST_COMPLETED: 3,
  // RequestRejected - Request was rejected
  REQUEST_REJECTED: 5
};

// Signature status mapping
const SIGNATURE_STATUS = {
  SEND_FOR_SIGNATURE: 'send_for_signature',
  SIGNING_IN_PROGRESS: 'in_progress',
  SIGNED_BY_LANDLORD: 'signed_by_landlord',
  SIGNED_BY_TENANT: 'signed_by_tenant',
  SIGNING_COMPLETE: 'signing_complete',
  REJECTED: 'rejected'
};

// Agreement states
const AGREEMENT_STATES = {
  CREATED: 'created',                    // Initial state
  DRAFT: 'draft',                        // Still being edited
  PENDING_ACTIVATION: 'pending_activation', // During signature process
  ACTIVE: 'active',                      // All signatures complete, agreement in effect
  REJECTED: 'rejected',                  // Someone rejected the agreement
  EXPIRED: 'expired',                    // Agreement reached its end date
  CANCELLED: 'cancelled'                 // Agreement was manually cancelled
};

// Helper function to log information
const logSignatureActivity = (message) => {
  try {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${message}\n`;
    fs.appendFileSync(LOGS_PATH, logEntry);
    console.log(`[SIGNATURE] ${message}`);
  } catch (err) {
    console.error('Error writing to signature log:', err);
  }
};

/**
 * Find an agreement by its Evia Sign reference ID
 * Tries multiple approaches to find the correct agreement
 */
const findAgreementByEviaReference = async (requestId) => {
  if (!requestId) {
    logSignatureActivity(`Error: No requestId provided`);
    return { success: false, error: 'No requestId provided' };
  }

  logSignatureActivity(`Looking for agreement with RequestId: ${requestId}`);
  
  // First try exact match on UUID
  let { data: agreements, error } = await supabase
    .from('agreements')
    .select('*')
    .eq('eviasignreference', requestId);
  
  if (error) {
    logSignatureActivity(`Error finding agreement with exact match: ${error.message}`);
  }
  
  // If no match, try alternate fields
  if (!agreements || agreements.length === 0) {
    logSignatureActivity(`No exact match found, trying signature_request_id`);
    
    const { data: altAgreements, error: altError } = await supabase
      .from('agreements')
      .select('*')
      .eq('signature_request_id', requestId);
      
    if (altError) {
      logSignatureActivity(`Error finding agreement with signature_request_id: ${altError.message}`);
    } else if (altAgreements && altAgreements.length > 0) {
      logSignatureActivity(`Found agreement by signature_request_id: ${altAgreements[0].id}`);
      return { success: true, agreement: altAgreements[0] };
    }
    
    // Try case insensitive search as a last resort
    logSignatureActivity(`No matches with exact fields, trying case-insensitive search`);
    const { data: caseInsensitiveMatches, error: caseError } = await supabase
      .from('agreements')
      .select('*')
      .ilike('eviasignreference', requestId);
      
    if (caseError) {
      logSignatureActivity(`Error in case-insensitive search: ${caseError.message}`);
    } else if (caseInsensitiveMatches && caseInsensitiveMatches.length > 0) {
      logSignatureActivity(`Found agreement by case-insensitive match: ${caseInsensitiveMatches[0].id}`);
      return { success: true, agreement: caseInsensitiveMatches[0] };
    }
    
    return { success: false, error: 'No matching agreement found' };
  }
  
  logSignatureActivity(`Found exact match, agreement ID: ${agreements[0].id}`);
  return { success: true, agreement: agreements[0] };
};

/**
 * Save signed document to storage from webhook data
 */
const saveSignedDocument = async (documentData, agreementId, documentName) => {
  try {
    logSignatureActivity(`Saving signed document for agreement ${agreementId}`);
    
    // Generate a filename based on agreement ID and timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `signed_${agreementId}_${timestamp}.pdf`;
    
    // For now, save it to the local file system for testing
    const documentsDir = path.join(LOGS_DIR, 'signed-documents');
    if (!fs.existsSync(documentsDir)) {
      fs.mkdirSync(documentsDir, { recursive: true });
    }
    
    const filePath = path.join(documentsDir, filename);
    
    // Convert base64 content to binary if needed
    let fileContent = documentData;
    if (typeof documentData === 'string' && documentData.startsWith('data:') || 
        documentData.startsWith('JVBERi')) {
      // It's probably a base64 encoded PDF
      try {
        // Handle different formats of base64 data
        let base64Data = documentData;
        if (documentData.includes('base64,')) {
          base64Data = documentData.split('base64,')[1];
        }
        fileContent = Buffer.from(base64Data, 'base64');
      } catch (e) {
        logSignatureActivity(`Error decoding base64 content: ${e.message}`);
        // Fall back to using the original content
        fileContent = documentData;
      }
    }
    
    // Write the file
    fs.writeFileSync(filePath, fileContent);
    logSignatureActivity(`Document saved to: ${filePath}`);
    
    // In a real implementation, you'd upload to cloud storage and return the URL
    // For this example, we'll just use a fake URL
    const documentUrl = `file://${filePath}`;
    
    return { 
      success: true, 
      url: documentUrl,
      path: filePath
    };
  } catch (error) {
    logSignatureActivity(`Error saving signed document: ${error.message}`);
    return { success: false, error: error.message };
  }
};

/**
 * Determine the signature type based on email/name patterns
 */
const determineSignatoryType = (email, name) => {
  if (!email && !name) {
    return null;
  }
  
  const emailLower = (email || '').toLowerCase();
  const nameLower = (name || '').toLowerCase();
  
  // Check for landlord/owner patterns
  if (emailLower.includes('landlord') || 
      emailLower.includes('owner') || 
      emailLower.includes('admin') ||
      nameLower.includes('landlord') || 
      nameLower.includes('owner') || 
      nameLower.includes('admin')) {
    return 'landlord';
  }
  
  // Check for tenant/rentee patterns
  if (emailLower.includes('tenant') || 
      emailLower.includes('renter') || 
      emailLower.includes('rentee') ||
      nameLower.includes('tenant') || 
      nameLower.includes('renter') || 
      nameLower.includes('rentee')) {
    return 'tenant';
  }
  
  // Default to tenant if no clear pattern is found
  return 'tenant';
};

/**
 * Process signature webhook event from Evia Sign
 * This is the main entry point for webhook processing
 */
export async function processSignatureEvent(webhookData) {
  try {
    // Validate webhook data
    if (!webhookData || !webhookData.RequestId || !webhookData.EventId) {
      logSignatureActivity('Invalid webhook data: missing RequestId or EventId');
      return { success: false, error: 'Invalid webhook data' };
    }
    
    const requestId = webhookData.RequestId;
    const eventId = webhookData.EventId;
    const eventDescription = webhookData.EventDescription;
    
    logSignatureActivity(`Processing event ${eventId} (${eventDescription}) for request ${requestId}`);
    
    // Find the agreement
    const { success, agreement, error } = await findAgreementByEviaReference(requestId);
    
    if (!success || !agreement) {
      logSignatureActivity(`Agreement not found: ${error}`);
      return { success: false, error: error || 'Agreement not found' };
    }
    
    logSignatureActivity(`Found agreement ID: ${agreement.id}, current status: ${agreement.status || 'none'}`);
    
    // Process based on event type
    let updateData = {
      updatedat: new Date().toISOString()
    };
    
    // Initialize signatories_status if not present
    let signatoryData = agreement.signatories_status || [];
    if (typeof signatoryData === 'string') {
      try {
        signatoryData = JSON.parse(signatoryData);
      } catch (e) {
        signatoryData = [];
      }
    }
    
    // Switch based on event ID
    switch (eventId) {
      case SIGNATURE_EVENT_TYPES.SIGN_REQUEST_RECEIVED:
        logSignatureActivity('Processing SignRequestReceived event');
        updateData.status = AGREEMENT_STATES.PENDING_ACTIVATION;
        updateData.signature_status = SIGNATURE_STATUS.SEND_FOR_SIGNATURE;
        updateData.signature_sent_at = new Date().toISOString();
        break;
        
      case SIGNATURE_EVENT_TYPES.SIGNATORY_COMPLETED:
        logSignatureActivity('Processing SignatoryCompleted event');
        // Determine signatory type
        const signatoryType = determineSignatoryType(webhookData.Email, webhookData.UserName);
        
        // Get signatory name - clean it up if needed
        const signatoryName = webhookData.UserName || webhookData.Email.split('@')[0];
        
        // Update signature status to include the actual name who signed
        updateData.signature_status = signatoryType === 'landlord' 
          ? `signed_by_${signatoryName.replace(/\s+/g, '_')}` 
          : `signed_by_${signatoryName.replace(/\s+/g, '_')}`;
        
        // Keep agreement in pending state until all signatures complete
        updateData.status = AGREEMENT_STATES.PENDING_ACTIVATION;
        
        // Update signatories status array
        const newSignatory = {
          name: webhookData.UserName || 'Unknown',
          email: webhookData.Email,
          type: signatoryType,
          status: 'completed',
          signedAt: webhookData.EventTime || new Date().toISOString()
        };
        
        // Check if signatory already exists
        const existingIndex = signatoryData.findIndex(s => s.email === webhookData.Email);
        if (existingIndex >= 0) {
          // Update existing signatory
          signatoryData[existingIndex] = {
            ...signatoryData[existingIndex],
            ...newSignatory
          };
        } else {
          // Add new signatory
          signatoryData.push(newSignatory);
        }
        
        updateData.signatories_status = signatoryData;
        break;
        
      case SIGNATURE_EVENT_TYPES.REQUEST_COMPLETED:
        logSignatureActivity('Processing RequestCompleted event');
        updateData.status = AGREEMENT_STATES.ACTIVE;
        updateData.signature_status = SIGNATURE_STATUS.SIGNING_COMPLETE;
        updateData.signature_completed_at = new Date().toISOString();
        updateData.signeddate = new Date().toISOString();
        
        // Check if we have signed document data
        if (webhookData.Documents && webhookData.Documents.length > 0) {
          logSignatureActivity('Found signed document in webhook data');
          const document = webhookData.Documents[0];
          
          try {
            // Save locally first
            const saveResult = await saveSignedDocument(
              document.DocumentContent,
              agreement.id,
              document.DocumentName
            );
            
            if (saveResult.success) {
              logSignatureActivity(`Signed document saved locally: ${saveResult.url}`);
              updateData.signed_document_url = saveResult.url;
              
              // Now try to save to Supabase storage for web access
              try {
                // Buffer the document content
                const documentBuffer = Buffer.from(document.DocumentContent, 'base64');
                
                // Save to Supabase storage
                const timestamp = new Date().toISOString().replace(/[:.-]/g, '_');
                const filename = `signed_agreement_${agreement.id}_${timestamp}.pdf`;
                const filePath = `agreements/${agreement.id}/${filename}`;
                
                logSignatureActivity(`Uploading to Supabase: ${filePath}`);
                
                // Use the supabase client to upload
                const { data: uploadData, error: uploadError } = await supabase.storage
                  .from('files')
                  .upload(filePath, documentBuffer, {
                    contentType: 'application/pdf',
                    upsert: true
                  });
                
                if (uploadError) {
                  throw new Error(`Supabase upload error: ${uploadError.message}`);
                }
                
                // Get public URL
                const { data: urlData } = supabase.storage
                  .from('files')
                  .getPublicUrl(filePath);
                
                if (urlData && urlData.publicUrl) {
                  logSignatureActivity(`Document uploaded to Supabase: ${urlData.publicUrl}`);
                  // Update both URLs to ensure max compatibility
                  updateData.signed_document_url = urlData.publicUrl;
                  updateData.pdfurl = urlData.publicUrl; 
                  updateData.signatureurl = urlData.publicUrl;
                }
              } catch (storageError) {
                logSignatureActivity(`Error uploading to Supabase storage: ${storageError.message}`);
                // Continue with local file if Supabase upload fails
              }
            } else {
              logSignatureActivity(`Failed to save signed document: ${saveResult.error}`);
            }
          } catch (docError) {
            logSignatureActivity(`Error processing document: ${docError.message}`);
          }
        } else {
          logSignatureActivity('No signed document attached in webhook');
        }
        break;
        
      case SIGNATURE_EVENT_TYPES.REQUEST_REJECTED:
        logSignatureActivity('Processing RequestRejected event');
        updateData.status = AGREEMENT_STATES.REJECTED;
        updateData.signature_status = SIGNATURE_STATUS.REJECTED;
        break;
        
      default:
        logSignatureActivity(`Unknown event type ${eventId}, no status update needed`);
        return { 
          success: true, 
          message: 'Webhook received but event type not recognized for processing'
        };
    }
    
    // Update the agreement in the database
    logSignatureActivity(`Updating agreement ${agreement.id} with new data`);
    const { error: updateError } = await supabase
      .from('agreements')
      .update(updateData)
      .eq('id', agreement.id);
    
    if (updateError) {
      logSignatureActivity(`Error updating agreement: ${updateError.message}`);
      return { success: false, error: updateError.message };
    }
    
    logSignatureActivity(`Agreement ${agreement.id} updated successfully`);
    return {
      success: true,
      agreementId: agreement.id,
      updates: updateData
    };
    
  } catch (error) {
    logSignatureActivity(`Error processing webhook: ${error.message}`);
    console.error('Error in processSignatureEvent:', error);
    return { success: false, error: error.message };
  }
}

// Export functions
export {
  SIGNATURE_EVENT_TYPES,
  SIGNATURE_STATUS,
  logSignatureActivity,
  findAgreementByEviaReference
}; 