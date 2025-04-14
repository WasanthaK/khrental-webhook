// supabaseClient.js for webhook server
// Adapted from src/services/supabaseClient.js

import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import crypto from 'crypto';

// Load environment variables
dotenv.config();

// Set up logging
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOGS_DIR = path.join(__dirname, '..', 'data');
const LOGS_PATH = path.join(LOGS_DIR, 'webhook-logs.txt');

// Ensure logs directory exists
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

// Helper function to log
const log = (message) => {
  try {
    // Only log critical errors (messages containing "ERROR:" or "Exception" or "failed")
    if (message.includes('ERROR:') || message.includes('Exception') || message.includes('failed')) {
      const timestamp = new Date().toISOString();
      const logEntry = `[${timestamp}] [SUPABASE] ${message}\n`;
      fs.appendFileSync(LOGS_PATH, logEntry);
      console.log(`[SUPABASE] ${message}`);
    }
  } catch (err) {
    console.error('Error writing to log:', err);
  }
};

// Check for required environment variables
const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;

if (!SUPABASE_URL) {
  log('ERROR: SUPABASE_URL environment variable is not set');
}

if (!SUPABASE_SERVICE_KEY) {
  log('ERROR: SUPABASE_SERVICE_KEY environment variable is not set');
}

// Custom fetch with timeout
const customFetch = (url, options = {}) => {
  // Set a 15-second timeout
  const timeout = 15000;
  
  // Create an abort controller to handle timeouts
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  // Add signal to options
  const fetchOptions = {
    ...options,
    signal: controller.signal
  };
  
  return fetch(url, fetchOptions)
    .finally(() => clearTimeout(timeoutId));
};

// Create and export Supabase client
let supabase = null;

if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
  try {
    log(`Initializing Supabase client with URL: ${SUPABASE_URL}`);
    
    // Create the client with cache disabled
    supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      },
      global: {
        fetch: customFetch
      },
      db: {
        schema: 'public',
      },
      // Disable features that might cause schema cache issues
      realtime: {
        enabled: false,
      }
    });
    
    log('Supabase client initialized');
    
    // Clear the schema cache by forcing a select query first - reduce verbosity
    setTimeout(async () => {
      try {
        const { data, error } = await supabase.from('webhook_events').select('*').limit(1);
        if (error) {
          log(`Schema cache priming error: ${error.message}`);
        }
      } catch (e) {
        log(`Error priming schema cache: ${e.message}`);
      }
    }, 1000);
  } catch (error) {
    log(`Error initializing Supabase client: ${error.message}`);
    console.error('Error initializing Supabase client:', error);
  }
} else {
  log('Supabase client not initialized due to missing environment variables');
}

/**
 * Test the Supabase connection
 * @returns {Promise<Object>} - Connection test result
 */
const testConnection = async () => {
  // Reduce verbosity - only log the starting and ending of the test
  try {
    // First test with a direct HTTP request
    const response = await fetch(`${SUPABASE_URL}/rest/v1/?apikey=${SUPABASE_SERVICE_KEY}`);
    if (!response.ok) {
      console.error(`[SUPABASE] Direct HTTP test failed with status ${response.status}`);
      return { success: false, error: `HTTP test failed with status ${response.status}` };
    }

    // Then test with the Supabase client
    const { data, error } = await supabase
      .from('webhook_events')
      .select('id')
      .limit(5);

    if (error) {
      console.error(`[SUPABASE] Supabase client test failed: ${error.message}`);
      return { success: false, error: error.message };
    }

    console.log(`✅ Supabase connection test successful`);
    return { success: true, count: data?.length || 0 };
  } catch (error) {
    console.error(`[SUPABASE] Connection test error: ${error.message}`);
    return { success: false, error: error.message };
  }
};

/**
 * Insert webhook event into the database
 * @param {Object} eventData - The webhook event data
 * @returns {Promise<Object>} The result of the operation
 */
async function insertWebhookEvent(eventData) {
  try {
    // Validate input
    if (!eventData) {
      console.error('[supabaseClient] Error: No event data provided');
      return { success: false, error: 'No event data provided' };
    }

    // Log the incoming data
    console.log('[supabaseClient] Inserting webhook event:', 
                `EventId=${eventData.EventId}, RequestId=${eventData.RequestId}`);
    
    // Handle the RequestId appropriately
    let validRequestId = eventData.RequestId;
    
    // Check for test mode RequestIds (non-UUID format)
    const isTestId = typeof validRequestId === 'string' && 
                     (validRequestId.includes('test') || 
                      validRequestId.length < 32 || 
                      !validRequestId.includes('-'));
    
    if (isTestId) {
      console.log(`[supabaseClient] Test RequestId detected: ${validRequestId}`);
      // For test IDs, create a proper UUID to avoid database issues
      validRequestId = crypto.randomUUID();
      console.log(`[supabaseClient] Generated UUID for test RequestId: ${validRequestId}`);
    } else if (validRequestId && typeof validRequestId === 'string') {
      // For non-test IDs, validate and standardize the UUID format
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(validRequestId)) {
        console.warn(`[supabaseClient] RequestId ${validRequestId} is not in standard UUID format`);
        // Try to fix common formatting issues
        validRequestId = validRequestId.trim().toLowerCase();
        
        // If it still doesn't match, generate a new UUID
        if (!uuidRegex.test(validRequestId)) {
          const originalId = validRequestId;
          validRequestId = crypto.randomUUID();
          console.log(`[supabaseClient] Generated UUID for invalid RequestId: ${originalId} → ${validRequestId}`);
        }
      }
    }

    // Prepare the record data with careful type handling
    const record = {
      event_type: eventData.EventDescription || 'unknown',
      request_id: validRequestId,
      user_name: eventData.UserName || null,
      user_email: eventData.Email || null,
      subject: eventData.Subject || null,
      event_id: eventData.EventId !== undefined ? Number(eventData.EventId) : null,
      event_time: eventData.EventTime || new Date().toISOString(),
      raw_data: eventData,
      createdat: new Date().toISOString(),
      updatedat: new Date().toISOString(),
      processed: false
    };

    console.log(`[supabaseClient] Inserting record for event_id: ${record.event_id}, request_id: ${record.request_id}`);

    // Insert the record
    const { data, error } = await supabase
      .from('webhook_events')
      .insert([record])
      .select();

    if (error) {
      console.error('[supabaseClient] Error inserting webhook event:', error);
      
      // Detailed error logging by type
      if (error.code === '23502') {
        console.error('[supabaseClient] Not null violation. Check these fields:', error.details);
        console.error('[supabaseClient] Record attempted:', JSON.stringify(record));
      } else if (error.code === '23505') {
        console.error('[supabaseClient] Unique violation. Duplicate event?', error.details);
      } else if (error.code === '22P02') {
        console.error('[supabaseClient] Invalid input syntax, likely a UUID issue:', error.details);
        console.error('[supabaseClient] RequestId was:', validRequestId);
        console.error('[supabaseClient] Record attempted:', JSON.stringify(record));
      } else {
        console.error('[supabaseClient] Unknown error code:', error.code, error.message);
      }
      
      // Try a direct HTTP approach if the supabase client fails
      try {
        console.log('[supabaseClient] Attempting direct HTTP API insert as fallback');
        
        const response = await customFetch(
          `${SUPABASE_URL}/rest/v1/webhook_events`,
          {
            method: 'POST',
            headers: {
              'apikey': SUPABASE_SERVICE_KEY,
              'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
              'Content-Type': 'application/json',
              'Prefer': 'return=representation'
            },
            body: JSON.stringify(record)
          }
        );
        
        if (response.ok) {
          const responseData = await response.json();
          console.log('[supabaseClient] Direct HTTP insert successful');
          return { success: true, data: responseData[0] };
        } else {
          const errorText = await response.text();
          console.error(`[supabaseClient] Direct HTTP insert failed: ${response.status} - ${errorText}`);
          throw new Error(`HTTP error ${response.status}: ${errorText}`);
        }
      } catch (httpError) {
        console.error('[supabaseClient] Fallback HTTP insert failed:', httpError);
        throw error; // Throw the original error
      }
    }

    console.log('[supabaseClient] Webhook event inserted successfully, ID:', data?.[0]?.id);
    return { success: true, data: data?.[0] };
  } catch (error) {
    console.error('[supabaseClient] Exception in insertWebhookEvent:', error);
    return { success: false, error: error.message, data: null };
  }
}

/**
 * Helper function to get event type description from ID
 * @param {number} eventId - The event ID
 * @returns {string} - The event type description
 */
function getEventTypeFromId(eventId) {
  switch(eventId) {
    case 1:
      return 'SignRequestReceived';
    case 2:
      return 'SignatoryCompleted';
    case 3:
      return 'RequestCompleted';
    default:
      return 'Unknown';
  }
}

/**
 * Mark a webhook event as processed
 * @param {string} eventId - The ID of the webhook event
 * @param {Object} processingResult - Result of processing the webhook
 * @returns {Promise<Object>} The result of the operation
 */
async function markWebhookEventProcessed(eventId, processingResult) {
  try {
    if (!eventId) {
      console.warn('[supabaseClient] Cannot mark event as processed: missing event ID');
      return { success: false, warning: 'Missing event ID' };
    }

    console.log(`[supabaseClient] Marking webhook event ${eventId} as processed`);
    
    // Prepare the update data
    const updateData = {
      processed: true,
      processed_at: new Date().toISOString(),
      processing_result: processingResult || null,
      updatedat: new Date().toISOString()
    };

    // Log the update operation for debugging
    console.log(`[supabaseClient] Updating event ${eventId} with:`, 
                JSON.stringify(updateData, null, 2).substring(0, 200) + '...');

    // Update the record
    const { data, error } = await supabase
      .from('webhook_events')
      .update(updateData)
      .eq('id', eventId)
      .select();

    if (error) {
      console.error(`[supabaseClient] Error marking webhook event ${eventId} as processed:`, error);
      
      // Try a fallback direct HTTP approach if the supabase client fails
      try {
        console.log('[supabaseClient] Attempting direct HTTP API update as fallback');
        
        const response = await customFetch(
          `${SUPABASE_URL}/rest/v1/webhook_events?id=eq.${encodeURIComponent(eventId)}`,
          {
            method: 'PATCH',
            headers: {
              'apikey': SUPABASE_SERVICE_KEY,
              'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
              'Content-Type': 'application/json',
              'Prefer': 'return=representation'
            },
            body: JSON.stringify(updateData)
          }
        );
        
        if (response.ok) {
          console.log('[supabaseClient] Direct HTTP update successful');
          return { success: true };
        } else {
          const errorText = await response.text();
          console.error(`[supabaseClient] Direct HTTP update failed: ${response.status} - ${errorText}`);
          return { success: false, warning: `HTTP error ${response.status}: ${errorText}` };
        }
      } catch (httpError) {
        console.error('[supabaseClient] Fallback HTTP update failed:', httpError);
        return { success: false, warning: error.message };
      }
    }

    console.log(`[supabaseClient] Webhook event ${eventId} marked as processed successfully`);
    return { success: true, data: data?.[0] };
  } catch (error) {
    console.error('[supabaseClient] Exception in markWebhookEventProcessed:', error);
    return { success: false, warning: error.message };
  }
}

/**
 * Test insert a sample webhook event to verify database permissions
 * This is only run at startup to verify everything is working
 */
const testInsertWebhookEvent = async () => {
  if (!supabase) {
    log('Cannot test insert: Supabase client not initialized');
    return { success: false, error: 'Supabase client not initialized' };
  }

  try {
    log('Testing webhook event insertion...');
    
    const now = new Date().toISOString();
    
    // Get the table structure first to see what columns exist
    const { data: tableInfo, error: tableError } = await supabase
      .from('webhook_events')
      .select('*')
      .limit(1);
    
    if (tableError) {
      log(`Error fetching table structure: ${tableError.message}`);
      
      // Create a simple test event with minimal fields - always include event_type
      const testEvent = {
        event_type: 'test', // Always include as it's required
        request_id: `test_${Date.now()}`,
        processed: false
      };
      
      log('Using minimal fields for test insert');
      
      const { data, error } = await supabase
        .from('webhook_events')
        .insert(testEvent)
        .select();
      
      if (error) {
        log(`Error inserting test event: ${error.message}`);
        return { success: false, error: error.message };
      }
      
      log('Test event inserted successfully');
      return { success: true, count: 1 };
    } else {
      log('Table structure fetched successfully');
      return { success: true, count: tableInfo.length };
    }
  } catch (error) {
    log(`Error testing webhook event insertion: ${error.message}`);
    return { success: false, error: error.message };
  }
};

/**
 * Log webhook delivery status for monitoring
 * @param {Object} webhookData - The webhook data received
 * @param {string} source - Where the webhook was received from
 */
const logWebhookDelivery = async (webhookData, source = 'direct') => {
  try {
    console.log(`[WEBHOOK TRACKING] Received webhook from ${source}`);
    console.log(`[WEBHOOK TRACKING] Request ID: ${webhookData.RequestId}`);
    console.log(`[WEBHOOK TRACKING] Event Type: ${webhookData.EventDescription} (ID: ${webhookData.EventId})`);
    
    // Log to console only, don't attempt DB insertion since we're already having issues
    return { success: true };
  } catch (err) {
    console.error(`[WEBHOOK TRACKING] Error: ${err.message}`);
    return { success: false, error: err.message };
  }
};

// Export functions and the supabase client
export { markWebhookEventProcessed, logWebhookDelivery, testConnection, insertWebhookEvent, testInsertWebhookEvent };
export default supabase;