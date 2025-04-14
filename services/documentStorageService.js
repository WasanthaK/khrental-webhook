// documentStorageService.js - Handles document storage operations
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import supabase from './supabaseClient.js';

// Set up file paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DOCS_DIR = path.join(__dirname, '..', 'data', 'documents');

// Ensure documents directory exists
if (!fs.existsSync(DOCS_DIR)) {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
}

/**
 * Log a message related to document storage
 * @param {string} message - The message to log
 * @param {string} level - Log level (info, warn, error)
 */
const logDocumentActivity = (message, level = 'info') => {
  const prefix = level === 'error' ? '[ERROR]' : level === 'warn' ? '[WARN]' : '[INFO]';
  console.log(`[DOC-STORAGE] ${prefix} ${message}`);
};

/**
 * Save a document to both local storage and Supabase
 * @param {Object} options - The options for saving the document
 * @param {string} options.content - Document content (base64 encoded)
 * @param {string} options.webhookEventId - The ID of the related webhook event
 * @param {string} options.agreementId - The ID of the related agreement (if available)
 * @param {string} options.documentName - The name of the document
 * @returns {Promise<Object>} The result of the save operation
 */
export async function saveDocument({ content, webhookEventId, agreementId, documentName = 'signed_document.pdf' }) {
  try {
    logDocumentActivity(`Processing document for webhook event ${webhookEventId}`);
    
    // Track operation outcomes
    const result = {
      success: false,
      localPath: null,
      supabasePath: null,
      publicUrl: null,
      agreementUpdated: false,
      errors: []
    };
    
    // 1. Prepare document content
    let documentBuffer;
    try {
      // Handle different base64 formats
      let base64Content = content;
      if (typeof content === 'string') {
        if (content.includes('base64,')) {
          base64Content = content.split('base64,')[1];
        }
        documentBuffer = Buffer.from(base64Content, 'base64');
      } else if (Buffer.isBuffer(content)) {
        documentBuffer = content;
      } else {
        throw new Error('Document content is in an unsupported format');
      }
    } catch (error) {
      logDocumentActivity(`Error processing document content: ${error.message}`, 'error');
      result.errors.push(`Content processing: ${error.message}`);
      return result;
    }
    
    // 2. Save document locally first
    try {
      // Create unique filename and path
      const timestamp = new Date().toISOString().replace(/[:.-]/g, '_');
      
      // Use agreement folder structure if available, otherwise use webhook ID
      let localFilename, localFolderPath;
      if (agreementId) {
        localFolderPath = path.join(DOCS_DIR, 'agreements', agreementId);
        localFilename = `signed_agreement_${timestamp}.pdf`;
      } else {
        localFolderPath = path.join(DOCS_DIR, 'webhooks', webhookEventId);
        localFilename = `document_${timestamp}.pdf`;
      }
      
      // Create folder if it doesn't exist
      if (!fs.existsSync(localFolderPath)) {
        fs.mkdirSync(localFolderPath, { recursive: true });
      }
      
      const localPath = path.join(localFolderPath, localFilename);
      
      // Write to disk
      fs.writeFileSync(localPath, documentBuffer);
      logDocumentActivity(`Document saved locally to: ${localPath}`);
      
      // Update result
      result.localPath = localPath;
      result.localSuccess = true;
    } catch (error) {
      logDocumentActivity(`Error saving document locally: ${error.message}`, 'error');
      result.errors.push(`Local save: ${error.message}`);
      // Continue to Supabase upload even if local save fails
    }
    
    // 3. Upload to Supabase storage
    try {
      // Create filename
      const timestamp = new Date().toISOString().replace(/[:.-]/g, '_');
      const filename = documentName ? 
        `${path.basename(documentName, path.extname(documentName))}_${timestamp}.pdf` : 
        `document_${timestamp}.pdf`;
      
      // Create storage path - use agreements folder structure for consistency
      let storagePath;
      if (agreementId) {
        // Use the agreements folder structure, which is your standard convention
        storagePath = `agreements/${agreementId}/${filename}`;
      } else {
        // Fallback to webhook folder if no agreement ID is available
        storagePath = `webhooks/${webhookEventId}/${filename}`;
      }
      
      logDocumentActivity(`Uploading to Supabase storage: ${storagePath}`);
      
      // Perform the upload
      const { data, error } = await supabase.storage
        .from('files') // Use 'files' bucket to match your existing implementation
        .upload(storagePath, documentBuffer, {
          contentType: 'application/pdf',
          upsert: true
        });
      
      if (error) {
        throw new Error(`Supabase upload error: ${error.message}`);
      }
      
      // Get the public URL
      const { data: urlData } = supabase.storage
        .from('files')
        .getPublicUrl(storagePath);
      
      if (!urlData || !urlData.publicUrl) {
        throw new Error('Failed to get public URL from Supabase');
      }
      
      // Update result
      result.supabasePath = storagePath;
      result.publicUrl = urlData.publicUrl;
      logDocumentActivity(`Document uploaded to Supabase: ${urlData.publicUrl}`);
      
      // 4. Update webhook_events record with document info
      try {
        const { error: updateError } = await supabase
          .from('webhook_events')
          .update({
            document_url: urlData.publicUrl,
            document_path: storagePath,
            updatedat: new Date().toISOString()
          })
          .eq('id', webhookEventId);
        
        if (updateError) {
          logDocumentActivity(`Error updating webhook event with document URL: ${updateError.message}`, 'warn');
          result.errors.push(`Webhook update: ${updateError.message}`);
        } else {
          logDocumentActivity(`Updated webhook_events record ${webhookEventId} with document URL`);
        }
      } catch (webhookUpdateError) {
        logDocumentActivity(`Exception updating webhook record: ${webhookUpdateError.message}`, 'error');
        result.errors.push(`Webhook update exception: ${webhookUpdateError.message}`);
      }
      
      // 5. Update agreement if agreementId is provided
      if (agreementId) {
        try {
          const { error: agreementError } = await supabase
            .from('agreements')
            .update({
              signed_document_url: urlData.publicUrl,
              pdfurl: urlData.publicUrl,
              signatureurl: urlData.publicUrl,
              updatedat: new Date().toISOString()
            })
            .eq('id', agreementId);
          
          if (agreementError) {
            logDocumentActivity(`Error updating agreement with document URL: ${agreementError.message}`, 'warn');
            result.errors.push(`Agreement update: ${agreementError.message}`);
          } else {
            logDocumentActivity(`Updated agreement ${agreementId} with document URL`);
            result.agreementUpdated = true;
          }
        } catch (agreementUpdateError) {
          logDocumentActivity(`Exception updating agreement: ${agreementUpdateError.message}`, 'error');
          result.errors.push(`Agreement update exception: ${agreementUpdateError.message}`);
        }
      }
      
      // Mark operation as successful if we have a public URL
      result.success = true;
    } catch (storageError) {
      logDocumentActivity(`Error in Supabase storage operations: ${storageError.message}`, 'error');
      result.errors.push(`Supabase storage: ${storageError.message}`);
    }
    
    return result;
  } catch (error) {
    logDocumentActivity(`Unexpected error in saveDocument: ${error.message}`, 'error');
    return {
      success: false,
      errors: [`Fatal error: ${error.message}`]
    };
  }
}

/**
 * Find agreement ID associated with a webhook event
 * @param {string} webhookEventId - The webhook event ID
 * @returns {Promise<string|null>} The agreement ID if found, null otherwise
 */
export async function findAgreementForWebhookEvent(webhookEventId) {
  try {
    // First get the webhook event to find the eviasignreference
    const { data: webhookEvent, error: webhookError } = await supabase
      .from('webhook_events')
      .select('eviasignreference')
      .eq('id', webhookEventId)
      .single();
    
    if (webhookError || !webhookEvent) {
      logDocumentActivity(`Error finding webhook event ${webhookEventId}: ${webhookError?.message || 'Not found'}`, 'warn');
      return null;
    }
    
    const eviasignReference = webhookEvent.eviasignreference;
    if (!eviasignReference) {
      logDocumentActivity(`Webhook event ${webhookEventId} has no eviasignreference`, 'warn');
      return null;
    }
    
    // Then find the agreement using the eviasignreference
    const { data: agreement, error: agreementError } = await supabase
      .from('agreements')
      .select('id')
      .eq('eviasignreference', eviasignReference)
      .single();
    
    if (agreementError || !agreement) {
      logDocumentActivity(`No agreement found for eviasignreference ${eviasignReference}`, 'warn');
      return null;
    }
    
    logDocumentActivity(`Found agreement ${agreement.id} for webhook event ${webhookEventId}`);
    return agreement.id;
  } catch (error) {
    logDocumentActivity(`Error finding agreement for webhook event: ${error.message}`, 'error');
    return null;
  }
}

// Export other utility functions
export default {
  saveDocument,
  findAgreementForWebhookEvent
}; 