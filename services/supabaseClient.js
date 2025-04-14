// supabaseClient.js for webhook server
// Provides database connectivity and operations for webhook processing

import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import crypto from 'crypto';

// Load environment variables
dotenv.config();

// Constants
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HTTP_TIMEOUT = 15000; // 15 seconds

// Set up logging
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOGS_DIR = path.join(__dirname, '..', 'data');
const LOGS_PATH = path.join(LOGS_DIR, 'webhook-logs.txt');

// Ensure logs directory exists
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

// Get environment variables
const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;

/**
 * Write a log message to file and console
 * @param {string} message - Message to log
 * @param {string} level - Log level (info, warn, error)
 */
const log = (message, level = 'info') => {
  try {
    // Format message with timestamp and level
    const timestamp = new Date().toISOString();
    const prefix = level === 'error' ? '[ERROR]' : level === 'warn' ? '[WARN]' : '[INFO]';
    const logMessage = `[${timestamp}] ${prefix} ${message}`;
    
    // Write to file for errors and warnings
    if (level === 'error' || level === 'warn') {
      fs.appendFileSync(LOGS_PATH, `${logMessage}\n`);
    }
    
    // Output to console
    if (level === 'error') {
      console.error(`[SUPABASE] ${message}`);
    } else {
      console.log(`[SUPABASE] ${message}`);
    }
  } catch (err) {
    console.error('Error writing to log:', err);
  }
};

// Validate environment variables
if (!SUPABASE_URL) {
  log('Missing SUPABASE_URL environment variable', 'error');
}

if (!SUPABASE_SERVICE_KEY) {
  log('Missing SUPABASE_SERVICE_KEY environment variable', 'error');
}

/**
 * Custom fetch with timeout handling
 * @param {string} url - URL to fetch
 * @param {Object} options - Fetch options
 */
const customFetch = (url, options = {}) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), HTTP_TIMEOUT);
  
  return fetch(url, {
    ...options,
    signal: controller.signal
  }).finally(() => clearTimeout(timeoutId));
};

// Initialize Supabase client
let supabase = null;

if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
  try {
    log('Initializing Supabase client');
    
    // Create client with optimized settings
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
      realtime: {
        enabled: false, // Disable realtime to avoid schema cache issues
      }
    });
    
    // Prime the schema cache to avoid issues
    setTimeout(async () => {
      try {
        const { error } = await supabase.from('webhook_events').select('id').limit(1);
        if (error) {
          log(`Schema cache priming error: ${error.message}`, 'warn');
        } else {
          log('Schema cache primed successfully', 'info');
        }
      } catch (e) {
        log(`Error priming schema cache: ${e.message}`, 'error');
      }
    }, 1000);
    
    log('Supabase client initialized successfully');
  } catch (error) {
    log(`Error initializing Supabase client: ${error.message}`, 'error');
  }
} else {
  log('Supabase client not initialized due to missing environment variables', 'error');
}

/**
 * Test database connection
 * @returns {Promise<Object>} Connection test result
 */
const testConnection = async () => {
  log('Testing Supabase connection...', 'info');
  
  try {
    // First test direct HTTP connection
    const response = await fetch(`${SUPABASE_URL}/rest/v1/?apikey=${SUPABASE_SERVICE_KEY}`);
    
    if (!response.ok) {
      log(`Direct HTTP test failed with status ${response.status}`, 'error');
      return { success: false, error: `HTTP test failed with status ${response.status}` };
    }
    
    // Then test the Supabase client
    const { data, error } = await supabase
      .from('webhook_events')
      .select('id')
      .limit(5);
      
    if (error) {
      log(`Supabase client test failed: ${error.message}`, 'error');
      return { success: false, error: error.message };
    }
    
    log('Supabase connection test successful', 'info');
    return { success: true, count: data?.length || 0 };
  } catch (error) {
    log(`Connection test error: ${error.message}`, 'error');
    return { success: false, error: error.message };
  }
};

/**
 * Validates and normalizes a UUID string
 * @param {string} uuid - UUID to validate
 * @returns {Object} The validation result
 */
const validateAndNormalizeUUID = (uuid) => {
  if (!uuid) {
    return { valid: false, value: null };
  }
  
  // Check if it's a valid UUID format
  if (UUID_REGEX.test(uuid)) {
    // Normalize to lowercase without spaces
    return { valid: true, value: uuid.trim().toLowerCase() };
  }
  
  // Not valid, generate a new one
  return { valid: false, value: crypto.randomUUID() };
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
      log('No event data provided for insertion', 'error');
      return { success: false, error: 'No event data provided' };
    }
    
    log(`Processing webhook: EventId=${eventData.EventId}, RequestId=${eventData.RequestId}`, 'info');
    
    // Validate and normalize the UUID for the eviasignreference column
    const { valid, value: validatedUuid } = validateAndNormalizeUUID(eventData.RequestId);
    
    if (!valid) {
      log(`Converting invalid RequestId '${eventData.RequestId}' to UUID: ${validatedUuid}`, 'warn');
    } else {
      log(`Using valid UUID: ${validatedUuid}`, 'info');
    }
    
    // Prepare record using all fields from the schema
    const record = {
      event_type: eventData.EventDescription || 'unknown',
      eviasignreference: validatedUuid,
      user_name: eventData.UserName || null,
      user_email: eventData.Email || null,
      subject: eventData.Subject || null,
      event_id: eventData.EventId !== undefined ? Number(eventData.EventId) : null,
      event_time: eventData.EventTime || new Date().toISOString(),
      raw_data: typeof eventData === 'object' ? JSON.stringify(eventData) : eventData,
      createdat: new Date().toISOString(),
      updatedat: new Date().toISOString(),
      processed: false
    };
    
    log(`Attempting to insert webhook event with UUID: ${validatedUuid}`, 'info');
    
    // First attempt with standard Supabase client
    try {
      const { data, error } = await supabase
        .from('webhook_events')
        .insert([record])
        .select();
        
      if (!error) {
        log(`Event inserted successfully with ID: ${data[0]?.id}`, 'info');
        return { success: true, id: data[0]?.id };
      } else {
        log(`Supabase client insert failed: ${error.message}`, 'warn');
        
        // Continue to fallback if primary method fails
        if (error.code === '23505') {
          log('Event already exists in database', 'warn');
          return { success: true, id: validatedUuid, warning: 'Event already exists' };
        }
      }
    } catch (clientError) {
      log(`Exception in Supabase client insert: ${clientError.message}`, 'warn');
    }
    
    // Fallback to direct HTTP method
    try {
      log('Attempting direct HTTP insert as fallback', 'info');
      
      const response = await fetch(
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
        const data = await response.json();
        log(`Event inserted via HTTP with ID: ${data[0]?.id}`, 'info');
        return { success: true, id: data[0]?.id };
      } else {
        const errorText = await response.text();
        log(`Direct HTTP insert failed: ${errorText}`, 'error');
        
        // Return best-effort ID for continued processing
        return { 
          success: true, 
          id: validatedUuid,
          warning: 'Database insertion failed, using validated UUID for processing'
        };
      }
    } catch (httpError) {
      log(`Exception in HTTP insert: ${httpError.message}`, 'error');
      
      // Return best-effort ID for continued processing
      return { 
        success: true, 
        id: validatedUuid,
        warning: 'Exception during insertion, using validated UUID for processing'
      };
    }
  } catch (error) {
    log(`Unexpected error in insertWebhookEvent: ${error.message}`, 'error');
    
    // Create a fallback ID if everything fails
    const fallbackId = crypto.randomUUID();
    
    return {
      success: true,
      id: fallbackId,
      warning: 'Unexpected error, using generated UUID for processing'
    };
  }
}

/**
 * Map event ID to event type description
 * @param {number} eventId - Event ID
 * @returns {string} Event type description
 */
function getEventTypeFromId(eventId) {
  const eventTypes = {
    1: 'SignRequestReceived',
    2: 'SignatoryCompleted',
    3: 'RequestCompleted'
  };
  
  return eventTypes[eventId] || 'Unknown';
}

/**
 * Mark a webhook event as processed
 * @param {string} eventId - Event ID to mark as processed
 * @param {Object} processingResult - Processing result data
 * @returns {Promise<Object>} Operation result
 */
async function markWebhookEventProcessed(eventId, processingResult = {}) {
  try {
    if (!eventId) {
      log('Cannot mark event as processed: missing event ID', 'error');
      return { success: false, error: 'Missing event ID' };
    }
    
    log(`Marking webhook event ${eventId} as processed`, 'info');
    
    // Prepare update data with all relevant fields from the schema
    const updateData = {
      processed: true,
      processedat: new Date().toISOString(),
      updatedat: new Date().toISOString()
    };
    
    // Log the update operation
    log(`Updating webhook event with data: ${JSON.stringify(updateData)}`, 'info');
    
    // Direct HTTP update - simple and reliable
    try {
      const response = await fetch(
        `${SUPABASE_URL}/rest/v1/webhook_events?id=eq.${encodeURIComponent(eventId)}`,
        {
          method: 'PATCH',
          headers: {
            'apikey': SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify(updateData)
        }
      );
      
      if (response.ok) {
        log(`Event ${eventId} marked as processed successfully`, 'info');
        return { success: true };
      } else {
        const errorText = await response.text();
        log(`HTTP update failed: ${errorText}`, 'error');
        
        // Fallback to Supabase client
        log('Trying Supabase client update as fallback', 'info');
        
        const { error } = await supabase
          .from('webhook_events')
          .update(updateData)
          .eq('id', eventId);
          
        if (!error) {
          log(`Event ${eventId} marked as processed via client`, 'info');
          return { success: true };
        } else {
          log(`Client update failed: ${error.message}`, 'error');
          return { success: false, error: error.message };
        }
      }
    } catch (error) {
      log(`Exception marking event as processed: ${error.message}`, 'error');
      return { success: false, error: error.message };
    }
  } catch (error) {
    log(`Unexpected error in markWebhookEventProcessed: ${error.message}`, 'error');
    return { success: false, error: error.message };
  }
}

/**
 * Log webhook delivery for monitoring
 * @param {Object} webhookData - Webhook data
 * @param {string} source - Source of the webhook
 * @returns {Promise<Object>} Operation result
 */
async function logWebhookDelivery(webhookData, source = 'direct') {
  try {
    log(`Received webhook from ${source}: EventId=${webhookData.EventId}, Type=${webhookData.EventDescription}`, 'info');
    return { success: true };
  } catch (error) {
    log(`Error logging webhook delivery: ${error.message}`, 'error');
    return { success: false, error: error.message };
  }
}

// Export functions and the Supabase client
export {
  testConnection,
  insertWebhookEvent,
  markWebhookEventProcessed,
  getEventTypeFromId,
  logWebhookDelivery
};

export default supabase;