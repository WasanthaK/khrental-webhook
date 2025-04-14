// Evia Sign Webhook Server
// This server receives webhook events from Evia Sign, stores them, and processes them
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { processSignatureEvent } from './services/signatureWebhookService.js';
import { testConnection, insertWebhookEvent, markWebhookEventProcessed, logWebhookDelivery } from './services/supabaseClient.js';
import supabase from './services/supabaseClient.js';
import http from 'http';
import { Server } from 'socket.io';
import { EventEmitter } from 'events';
import { saveDocument, findAgreementForWebhookEvent } from './services/documentStorageService.js';

// Load environment variables
dotenv.config();

// Set up file paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Express app setup
const app = express();
const PORT = process.env.PORT || 3030; // Changed to 3030 as default

// Add middleware
app.use(cors());
app.use(morgan('dev'));
app.use(express.json({ limit: '10mb' })); // Global JSON parsing middleware

// Add a specific health check endpoint for Azure
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Azure-specific middleware for proper handling of proxy settings
if (process.env.WEBSITE_SITE_NAME) {
  console.log('Running in Azure environment, applying Azure-specific settings');
  
  // Trust the Azure proxy for proper IP address handling
  app.set('trust proxy', true);
  
  // Add Azure-specific error handling
  app.use((err, req, res, next) => {
    console.error('Azure middleware error:', err);
    logToFile(`Azure middleware error: ${err.message}`);
    next(err);
  });
}

// Verify the webhook URL from .env
const webhookUrl = process.env.VITE_EVIA_WEBHOOK_URL || process.env.EVIA_SIGN_WEBHOOK_URL || `http://localhost:${PORT}/webhook/evia-sign`;

// Database file paths
const DB_DIR = path.join(__dirname, 'data');
const EVENTS_DB_PATH = path.join(DB_DIR, 'webhook-events.json');
const LOGS_PATH = path.join(DB_DIR, 'webhook-logs.txt');

// Initialize a list to store recent webhooks (limited to 50)
const recentWebhooks = [];
const MAX_STORED_WEBHOOKS = 50;

// Simple JSON-based database for local event storage
const localDb = {
  addEvent: function(event) {
    try {
      if (!fs.existsSync(EVENTS_DB_PATH)) {
        fs.writeFileSync(EVENTS_DB_PATH, JSON.stringify({ events: [] }, null, 2));
      }
      
      // Read existing events
      const data = JSON.parse(fs.readFileSync(EVENTS_DB_PATH, 'utf8'));
      
      // Add new event with timestamp
      const newEvent = {
        ...event,
        localStorageTime: new Date().toISOString()
      };
      
      data.events.unshift(newEvent);
      
      // Keep only the most recent 100 events
      if (data.events.length > 100) {
        data.events = data.events.slice(0, 100);
      }
      
      // Write back to file
      fs.writeFileSync(EVENTS_DB_PATH, JSON.stringify(data, null, 2));
      
      return { success: true, message: 'Event stored locally' };
    } catch (error) {
      console.error('Error storing event in local DB:', error);
      return { success: false, error: error.message };
    }
  },
  getEvents: function() {
    try {
      if (!fs.existsSync(EVENTS_DB_PATH)) {
        return { events: [] };
      }
      
      return JSON.parse(fs.readFileSync(EVENTS_DB_PATH, 'utf8'));
    } catch (error) {
      console.error('Error reading local events:', error);
      return { events: [] };
    }
  }
};

// Add a utility function to filter out schema cache warnings
function filterLogMessage(message) {
  // Don't log schema cache or column-related warnings/errors
  if (message && typeof message === 'string') {
    // Filter out specific error patterns
    if (message.includes("processed_at") && message.includes("schema cache")) {
      return null; // Don't log this message at all
    }
    if (message.includes("schema cache") || message.includes("column") || message.includes("Schema cache")) {
      return null; // Don't log schema-related errors
    }
    if (message.toLowerCase().includes("does not exist in the current schema")) {
      return null; // Don't log schema-related errors
    }
  }
  return message;
}

// Track webhook event count for status page
let eventCount = 0;

// Update the logToFile function to use this filter
function logToFile(message) {
  try {
    // Filter out messages we want to ignore
    const filteredMessage = filterLogMessage(message);
    if (filteredMessage === null) {
      return; // Skip logging this message entirely
    }
    
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${filteredMessage}\n`;
    
    // Write to standard log location
    fs.appendFileSync(LOGS_PATH, logEntry);
    
    // Check if we're in Azure environment and write to Azure logs
    if (process.env.WEBSITE_SITE_NAME) {
      try {
        // Azure App Service log path
        const azureLogPath = path.join('D:\\home\\LogFiles', 'webhook-logs.txt');
        fs.appendFileSync(azureLogPath, logEntry);
      } catch (azureErr) {
        console.error('Error writing to Azure logs:', azureErr);
      }
    }
  } catch (err) {
    console.error('Error writing to log:', err);
  }
}

// Create an event emitter for database processing
const webhookProcessor = new EventEmitter();
// Set higher max listeners limit to avoid warnings
webhookProcessor.setMaxListeners(20);

// Function to broadcast webhook events to connected clients (dashboard only)
function broadcastWebhook(webhookData) {
  try {
    // Add timestamp if not present
    const webhook = { 
      ...webhookData, 
      receivedAt: webhookData.receivedAt || new Date().toISOString() 
    };
    
    // Add to recent webhooks, maintaining max size
    recentWebhooks.unshift(webhook);
    if (recentWebhooks.length > MAX_STORED_WEBHOOKS) {
      recentWebhooks.pop();
    }
    
    // Broadcast to all connected clients
    io.emit('new-webhook', webhook);
    console.log(`Successfully broadcasted webhook to dashboard: EventId=${webhook.EventId}, RequestId=${webhook.RequestId}`);
    logToFile(`Broadcasted webhook to dashboard: EventId=${webhook.EventId}, RequestId=${webhook.RequestId}`);
  } catch (error) {
    console.error(`Error in broadcastWebhook: ${error.message}`, error);
    logToFile(`Error in broadcastWebhook function: ${error.message}`);
    // Don't rethrow - we want to continue processing
  }
}

// Function to store webhook events in the local JSON database
async function storeEventLocally(event) {
  try {
    console.log('Storing event locally as backup');
    return localDb.addEvent(event);
  } catch (error) {
    console.error('Error storing event locally:', error);
    logToFile(`Error storing event locally: ${error.message}`);
    // Don't throw error to prevent cascading failures
    return { success: false, error: error.message };
  }
}

// Add global unhandled promise rejection handler
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Promise Rejection:', reason);
  logToFile(`Unhandled Promise Rejection: ${reason?.stack || reason?.message || String(reason)}`);
  // Don't exit the process, just log the error
});

// Add global uncaught exception handler
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  logToFile(`Uncaught Exception: ${error?.stack || error?.message || String(error)}`);
  // Don't exit the process, just log the error
});

// Test Supabase connection on startup
testConnection()
  .then(result => {
    if (result.success) {
      console.log('✅ Initial Supabase connection test successful');
      
      // After successful connection, prime the schema cache
      try {
        // Just query the structure without inserting test data
        supabase
          .from('webhook_events')
          .select('*')
          .limit(1)
          .then(({data, error}) => {
            if (error) {
              console.error('[SUPABASE] Error priming schema cache:', error.message);
            } else {
              // Check for agreements that need UUID field population silently
              supabase
                .from('agreements')
                .select('id, eviasignreference, eviasignreference')
                .is('eviasignreference', null)
                .not('eviasignreference', 'is', null)
                .limit(50) // Limit to 50 to avoid timeouts
                .then(({ data: agreements, error: agreementsError }) => {
                  if (agreementsError) {
                    console.error('[SUPABASE] Error checking agreements:', agreementsError.message);
                    return;
                  }
                  
                  if (!agreements || agreements.length === 0) {
                    return;
                  }
                  
                  // Check which ones have UUIDs in eviasignreference
                  // This function checks if a string is a valid UUID
                  const isUUID = (str) => {
                    if (!str) {
                      return false;
                    }
                    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
                    return uuidPattern.test(str);
                  };
                  
                  // Filter agreements where eviasignreference is a valid UUID
                  const agreementsToUpdate = agreements.filter(a => isUUID(a.eviasignreference));
                  
                  if (agreementsToUpdate.length === 0) {
                    return;
                  }
                  
                  // Update up to 5 agreements at startup (to avoid long startup times)
                  const updateBatch = agreementsToUpdate.slice(0, 5);
                  
                  // Process updates sequentially
                  const processUpdates = async () => {
                    for (const agreement of updateBatch) {
                      try {
                        const { error: updateError } = await supabase
                          .from('agreements')
                          .update({ eviasignreference: agreement.eviasignreference })
                          .eq('id', agreement.id);
                        
                        if (updateError) {
                          console.error(`[SUPABASE] Error updating agreement ${agreement.id}: ${updateError.message}`);
                        }
                        
                        // Small delay to avoid rate limiting
                        await new Promise(resolve => setTimeout(resolve, 100));
                      } catch (err) {
                        console.error(`[SUPABASE] Exception updating agreement ${agreement.id}: ${err.message}`);
                      }
                    }
                  };
                  
                  // Run the updates
                  processUpdates().catch(err => {
                    console.error('[SUPABASE] Error in update process:', err.message);
                  });
                });
            }
          });
      } catch (e) {
        console.error('Error priming schema cache:', e);
      }
    } else {
      console.error(`❌ Supabase connection test failed: ${result.error}`);
    }
  }).catch(err => {
    console.error('❌ Supabase connection test threw exception:', err);
  });

// Ensure data directory exists
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
  console.log(`Created data directory: ${DB_DIR}`);
}

// Initialize events database if it doesn't exist
if (!fs.existsSync(EVENTS_DB_PATH)) {
  fs.writeFileSync(EVENTS_DB_PATH, JSON.stringify({ events: [] }, null, 2));
  console.log(`Initialized webhook events database: ${EVENTS_DB_PATH}`);
}

// Use regular JSON parser for all routes except webhook
app.use((req, res, next) => {
  if (req.path === '/webhook/evia-sign' && req.method === 'POST') {
    return next();
  }
  express.json({ limit: '50mb' })(req, res, next);
});

// Add a simple status page at the root
app.get('/', (req, res) => {
  const deployedUrl = process.env.EVIA_SIGN_WEBHOOK_URL || `http://localhost:${PORT}/webhook/evia-sign`;
  const isAzure = deployedUrl.includes('azurewebsites.net');
  
  res.send(`
    <html>
      <head>
        <title>Webhook Server Status</title>
        <style>
          body { font-family: system-ui, sans-serif; line-height: 1.5; max-width: 800px; margin: 0 auto; padding: 20px; }
          h1 { color: #2563eb; }
          .status { display: inline-block; padding: 4px 8px; border-radius: 4px; background: #22c55e; color: white; }
          .card { border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
          pre { background: #f3f4f6; padding: 12px; border-radius: 4px; overflow: auto; }
          .webhook-url { word-break: break-all; font-family: monospace; }
          .environment { display: inline-block; padding: 3px 7px; border-radius: 4px; font-size: 0.8rem; margin-left: 8px; }
          .env-prod { background: #ef4444; color: white; }
          .env-dev { background: #3b82f6; color: white; }
        </style>
      </head>
      <body>
        <h1>Evia Sign Webhook Server
          <span class="environment ${isAzure ? 'env-prod' : 'env-dev'}">${isAzure ? 'Production' : 'Development'}</span>
        </h1>
        <div class="card">
          <h2>Server Status: <span class="status">Running</span></h2>
          <p><strong>Server started at:</strong> ${new Date().toISOString()}</p>
          <p><strong>Port:</strong> ${PORT}</p>
          <p><strong>Events processed:</strong> ${eventCount}</p>
          <p><strong>Webhook endpoint:</strong><br/>
            <code class="webhook-url">POST ${deployedUrl}</code>
          </p>
        </div>
        
        <div class="card">
          <h2>Webhook Testing</h2>
          <p>To test the webhook, send a POST request to the webhook endpoint with a JSON payload.</p>
          <pre>
curl -X POST ${deployedUrl} \\
  -H "Content-Type: application/json" \\
  -d '{
  "RequestId": "test-request-id",
  "UserName": "Test User",
  "Email": "test@example.com", 
  "Subject": "Test Webhook", 
  "EventId": 1,
  "EventDescription": "SignRequestReceived",
  "EventTime": "${new Date().toISOString()}"
}'</pre>
        </div>
        
        <div class="card">
          <h2>Links</h2>
          <ul>
            <li><a href="/status">View JSON status</a></li>
            <li><a href="/logs">View recent logs</a></li>
            <li><a href="/dashboard">Live Webhook Dashboard</a></li>
          </ul>
        </div>
      </body>
    </html>
  `);
});

// Add a JSON status endpoint
app.get('/status', (req, res) => {
  const deployedUrl = process.env.EVIA_SIGN_WEBHOOK_URL || `http://localhost:${PORT}/webhook/evia-sign`;
  res.json({
    status: 'running',
    webhookUrl: deployedUrl,
    serverStarted: new Date().toISOString(),
    eventsProcessed: eventCount,
    port: PORT,
    environment: deployedUrl.includes('azurewebsites.net') ? 'production' : 'development'
  });
});

// Add a logs endpoint
app.get('/logs', (req, res) => {
  try {
    // Read the most recent logs (last 100 lines)
    const logs = fs.readFileSync(LOGS_PATH, 'utf8')
      .split('\n')
      .filter(line => line.trim())
      .slice(-100)
      .join('\n');
    
    res.send(`
      <html>
        <head>
          <title>Webhook Server Logs</title>
          <style>
            body { font-family: system-ui, sans-serif; line-height: 1.5; max-width: 1000px; margin: 0 auto; padding: 20px; }
            h1 { color: #2563eb; }
            pre { background: #f3f4f6; padding: 12px; border-radius: 4px; overflow: auto; }
            a { color: #2563eb; }
          </style>
        </head>
        <body>
          <h1>Webhook Server Logs</h1>
          <p><a href="/">Back to status page</a></p>
          <pre>${logs || 'No logs available'}</pre>
        </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send(`Error reading logs: ${err.message}`);
  }
});

// Function to process webhook events with detailed business logic
async function processWebhookEvent(webhookData) {
  try {
    console.log('Processing webhook event with business logic');
    logToFile('Processing webhook event with business logic');
    
    // Validate the webhook data again
    if (!webhookData || !webhookData.EventId) {
      console.error('Invalid webhook data for processing: missing required fields');
      logToFile('Error: Invalid webhook data for processing - missing required fields');
      return {
        success: false,
        error: 'Invalid webhook data for processing'
      };
    }
    
    // Delegate to the signature webhook service for actual business logic
    console.log(`Delegating to processSignatureEvent for webhook: EventId=${webhookData.EventId}`);
    logToFile(`Delegating to processSignatureEvent for webhook: EventId=${webhookData.EventId}`);
    
    const result = await processSignatureEvent(webhookData);
    
    if (result.success) {
      console.log('Signature event processed successfully:', JSON.stringify(result, null, 2));
      logToFile(`Signature event processed successfully: ${JSON.stringify(result)}`);
    } else {
      console.error('Error processing signature event:', JSON.stringify(result, null, 2));
      logToFile(`Error processing signature event: ${JSON.stringify(result)}`);
    }
    
    return result;
  } catch (error) {
    console.error('Exception in processWebhookEvent:', error);
    logToFile(`Exception in processWebhookEvent: ${error.message}`);
    console.log('STACK TRACE:', error.stack);
    
    return {
      success: false,
      error: `Exception in webhook processing: ${error.message}`
    };
  }
}

// Handle Evia webhook requests
async function handleEviaSignWebhook(req, res) {
  const startTime = Date.now();
  const webhookData = req.body;
  const processingId = `webhook-${Date.now()}`;

  try {
    // Initial logs
    console.log(`[${processingId}] ==== WEBHOOK RECEIVED - STARTING PROCESSING ====`);
    logToFile('==== WEBHOOK RECEIVED - STARTING PROCESSING ====');
    
    // Log webhook data for debugging
    console.log(`[${processingId}] Webhook headers:`, req.headers);
    console.log(`[${processingId}] Webhook data:`, JSON.stringify(webhookData, null, 2));
    
    // Validate webhook data
    if (!webhookData || !webhookData.EventId) {
      console.error(`[${processingId}] Invalid webhook data received`);
      logToFile(`Invalid webhook data received: ${JSON.stringify(webhookData)}`);
      return res.status(400).send('Invalid webhook data');
    }
    
    // Step 1: Identify event type
    const eventId = webhookData.EventId;
    let eventTypeName = 'Unknown';
    
    // Map event IDs to meaningful names
    switch (eventId) {
      case 1:
        eventTypeName = 'SignRequestReceived';
        console.log(`[${processingId}] Processing SignRequestReceived event`);
        break;
      case 2:
        eventTypeName = 'SignatoryCompleted';
        console.log(`[${processingId}] Processing SignatoryCompleted event - Signatory: ${webhookData.UserName || webhookData.Email || 'Unknown'}`);
        break;
      case 3:
        eventTypeName = 'RequestCompleted';
        console.log(`[${processingId}] Processing RequestCompleted event - All signatures complete`);
        break;
      case 5:
        eventTypeName = 'RequestRejected';
        console.log(`[${processingId}] Processing RequestRejected event`);
        break;
      default:
        console.log(`[${processingId}] Processing unknown event type: ${eventId}`);
    }
    
    logToFile(`[${processingId}] Event type: ${eventTypeName} (ID: ${eventId})`);
    
    // Store the webhook event in database first
    console.log(`[${processingId}] Storing webhook event in database...`);
    logToFile(`[${processingId}] Storing webhook event in database...`);
    
    const storedEvent = await insertWebhookEvent(webhookData);
    
    if (!storedEvent.success) {
      console.error(`[${processingId}] Failed to store webhook event:`, storedEvent.error);
      logToFile(`[${processingId}] Failed to store webhook event: ${storedEvent.error}`);
      // Continue processing even if storage fails
    } else {
      console.log(`[${processingId}] Webhook event stored with ID: ${storedEvent.id}`);
      logToFile(`[${processingId}] Webhook event stored with ID: ${storedEvent.id}`);
      
      if (storedEvent.warning) {
        console.warn(`[${processingId}] Storage warning: ${storedEvent.warning}`);
        logToFile(`[${processingId}] Storage warning: ${storedEvent.warning}`);
      }
      
      // Step 2: Handle document if present (only for RequestCompleted events)
      if (eventId === 3 && webhookData.Documents && webhookData.Documents.length > 0) {
        console.log(`[${processingId}] Detected signed document in webhook (RequestCompleted event)`);
        logToFile(`[${processingId}] Detected signed document in webhook (RequestCompleted event)`);
        
        try {
          // First try to find the related agreement
          const agreementId = await findAgreementForWebhookEvent(storedEvent.id);
          
          // Save the document and update both webhook_events and agreement tables
          for (let i = 0; i < webhookData.Documents.length; i++) {
            const document = webhookData.Documents[i];
            console.log(`[${processingId}] Processing document ${i+1} of ${webhookData.Documents.length}: ${document.DocumentName || 'Unnamed'}`);
            
            const saveResult = await saveDocument({
              content: document.DocumentContent,
              webhookEventId: storedEvent.id,
              agreementId: agreementId,
              documentName: document.DocumentName || `document_${i+1}.pdf`
            });
            
            if (saveResult.success) {
              console.log(`[${processingId}] Document saved successfully: ${saveResult.publicUrl}`);
              logToFile(`[${processingId}] Document saved successfully: ${saveResult.publicUrl}`);
              
              // Notify dashboard of document availability
              io.emit('webhook-event', {
                event: 'document-available',
                id: storedEvent.id,
                documentUrl: saveResult.publicUrl,
                agreementId: agreementId
              });
            } else {
              console.error(`[${processingId}] Failed to save document:`, saveResult.errors);
              logToFile(`[${processingId}] Failed to save document: ${saveResult.errors.join(', ')}`);
            }
          }
        } catch (docError) {
          console.error(`[${processingId}] Error processing document from webhook:`, docError);
          logToFile(`[${processingId}] Error processing document from webhook: ${docError.message}`);
        }
      }
    }
    
    // Small delay to allow DB triggers to run
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Extract event data
    const storedEventId = storedEvent.id || `fallback-${Date.now()}`;
    const eventTimestamp = webhookData.EventTime || new Date().toISOString();
    
    // Create a card for the dashboard
    try {
      // Step 3: Prepare event details based on event type
      const eventDetails = {
        id: storedEventId,
        type: eventTypeName,
        requestId: webhookData.RequestId,
        timestamp: eventTimestamp,
        eventId: webhookData.EventId
      };
      
      // Add event-type specific details
      switch (eventId) {
        case 1: // SignRequestReceived
          // Just basic event details
          break;
        case 2: // SignatoryCompleted
          // Add signatory details
          eventDetails.userName = webhookData.UserName;
          eventDetails.email = webhookData.Email;
          eventDetails.subject = webhookData.Subject;
          break;
        case 3: // RequestCompleted
          // Add document info
          eventDetails.userName = webhookData.UserName;
          eventDetails.email = webhookData.Email;
          eventDetails.subject = webhookData.Subject;
          eventDetails.hasDocuments = webhookData.Documents && webhookData.Documents.length > 0;
          eventDetails.documentCount = webhookData.Documents ? webhookData.Documents.length : 0;
          break;
        case 5: // RequestRejected
          // Add rejection details if available
          eventDetails.userName = webhookData.UserName;
          eventDetails.email = webhookData.Email;
          eventDetails.rejectReason = webhookData.RejectReason || 'No reason provided';
          break;
      }
      
      console.log(`[${processingId}] Broadcasting to dashboard...`);
      
      // Broadcast to all connected clients
      io.emit('webhook-event', {
        event: 'received',
        data: eventDetails
      });
      
      console.log(`[${processingId}] Event broadcast completed`);
      logToFile(`Event broadcast completed: ${eventTypeName}`);
    } catch (error) {
      console.error(`[${processingId}] Broadcast error:`, error);
      logToFile(`Broadcast error: ${error.message}`);
    }
    
    // Step 4: Process the webhook with business logic
    try {
      console.log(`[${processingId}] Calling processWebhookEvent for business logic processing`);
      logToFile(`[${processingId}] Calling processWebhookEvent for business logic processing`);
      
      const result = await processWebhookEvent(webhookData);
      
      if (result && result.success) {
        console.log(`[${processingId}] Webhook processing completed successfully`);
        logToFile(`Webhook processed: ${eventTypeName}`);
        
        // Step 5: Mark as processed
        await markWebhookEventProcessed(storedEventId);
        
        // Notify dashboard of completion
        io.emit('webhook-event', {
          event: 'processed',
          id: storedEventId,
          success: true,
          eventType: eventTypeName
        });
      } else {
        console.warn(`[${processingId}] Webhook processing completed with warnings:`, result?.warnings);
        logToFile(`Webhook processing warnings: ${JSON.stringify(result?.warnings)}`);
        
        // Mark as processed but capture the warnings
        await markWebhookEventProcessed(storedEventId);
        
        // Notify dashboard of completion with warnings
        io.emit('webhook-event', {
          event: 'processed',
          id: storedEventId,
          success: true,
          warnings: result?.warnings,
          eventType: eventTypeName
        });
      }
    } catch (error) {
      console.error(`[${processingId}] Error processing webhook:`, error);
      logToFile(`Error processing webhook: ${error.message}`);
      
      // Still mark as processed despite error
      await markWebhookEventProcessed(storedEventId);
      
      // Notify dashboard of error
      io.emit('webhook-event', {
        event: 'processed',
        id: storedEventId,
        success: false,
        error: error.message,
        eventType: eventTypeName
      });
    }
    
    // Send success response to webhook source
    const processingTime = Date.now() - startTime;
    console.log(`[${processingId}] Webhook processing completed in ${processingTime}ms`);
    logToFile(`Webhook processing completed in ${processingTime}ms`);
    
    return res.status(200).send('Webhook received and processed successfully');
  } catch (error) {
    console.error(`[${processingId}] CRITICAL ERROR in webhook handler:`, error);
    logToFile(`CRITICAL ERROR in webhook handler: ${error.message}`);
    
    // Always respond with success to avoid webhook retries that might cause issues
    return res.status(200).send('Webhook received (with processing errors)');
  }
}

// Add a dashboard route to display webhook events
app.get('/dashboard', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Evia Sign Webhook Dashboard</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
  <script src="/socket.io/socket.io.js"></script>
  <style>
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
      padding: 20px;
      background-color: #f8f9fa;
    }
    .webhook-card {
      margin-bottom: 15px;
      border-left: 5px solid #0d6efd;
      transition: all 0.3s ease;
    }
    .webhook-card.new {
      border-left-color: #20c997;
      background-color: rgba(32, 201, 151, 0.1);
    }
    .event-1 { border-left-color: #0dcaf0; }
    .event-2 { border-left-color: #0d6efd; }
    .event-3 { border-left-color: #198754; }
    .event-5 { border-left-color: #dc3545; }
    .card-header { 
      font-weight: 600;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .timestamp {
      font-size: 0.8rem;
      color: #6c757d;
    }
    .badge-event-1 { background-color: #0dcaf0; }
    .badge-event-2 { background-color: #0d6efd; }
    .badge-event-3 { background-color: #198754; }
    .badge-event-5 { background-color: #dc3545; }
    pre {
      background-color: #f8f9fa;
      padding: 10px;
      border-radius: 4px;
      max-height: 200px;
      overflow-y: auto;
    }
    #connection-status {
      position: fixed;
      top: 10px;
      right: 10px;
      z-index: 1000;
    }
    .navbar-brand {
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .stats {
      display: flex;
      gap: 20px;
      margin-bottom: 20px;
    }
    .stats-card {
      flex: 1;
      text-align: center;
      padding: 15px;
      border-radius: 8px;
      background-color: white;
      box-shadow: 0 2px 4px rgba(0,0,0,0.05);
    }
    .stats-value {
      font-size: 1.5rem;
      font-weight: 700;
    }
    .stats-label {
      color: #6c757d;
      font-size: 0.9rem;
    }
    .request-id-chip {
      font-family: monospace;
      background-color: #e9ecef;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 0.85rem;
    }
    .debug-links {
      display: flex;
      justify-content: center;
      margin-bottom: 15px;
      gap: 15px;
    }
  </style>
</head>
<body>
  <div id="connection-status" class="badge bg-secondary">Connecting...</div>

  <nav class="navbar navbar-expand-lg navbar-light bg-light mb-4">
    <div class="container-fluid">
      <span class="navbar-brand">
        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="currentColor" class="bi bi-activity" viewBox="0 0 16 16">
          <path fill-rule="evenodd" d="M6 2a.5.5 0 0 1 .47.33L10 12.036l1.53-4.208A.5.5 0 0 1 12 7.5h3.5a.5.5 0 0 1 0 1h-3.15l-1.88 5.17a.5.5 0 0 1-.94 0L6 3.964 4.47 8.171A.5.5 0 0 1 4 8.5H.5a.5.5 0 0 1 0-1h3.15l1.88-5.17A.5.5 0 0 1 6 2Z"/>
        </svg>
        Evia Sign Webhook Dashboard
      </span>
    </div>
  </nav>

  <div class="container-fluid">
    <!-- Debug links -->
    <div class="debug-links">
      <a href="/logs" class="btn btn-sm btn-outline-primary">View Standard Logs</a>
      <a href="/azure-logs" class="btn btn-sm btn-outline-primary">View Azure Logs</a>
      <a href="/status" class="btn btn-sm btn-outline-secondary">View Server Status</a>
    </div>

    <div class="stats mb-4">
      <div class="stats-card">
        <div class="stats-value" id="total-count">0</div>
        <div class="stats-label">Total Webhooks</div>
      </div>
      <div class="stats-card">
        <div class="stats-value" id="request-received-count">0</div>
        <div class="stats-label">Sign Requests</div>
      </div>
      <div class="stats-card">
        <div class="stats-value" id="signatory-completed-count">0</div>
        <div class="stats-label">Signatory Completions</div>
      </div>
      <div class="stats-card">
        <div class="stats-value" id="request-completed-count">0</div>
        <div class="stats-label">Completed Requests</div>
      </div>
      <div class="stats-card">
        <div class="stats-value" id="request-rejected-count">0</div>
        <div class="stats-label">Rejected Requests</div>
      </div>
    </div>
    
    <div class="row">
      <div class="col-12">
        <div class="d-flex justify-content-between align-items-center mb-3">
          <h5 class="mb-0">Recent Webhooks</h5>
          <div>
            <button id="clear-btn" class="btn btn-sm btn-outline-secondary">Clear</button>
            <button id="test-btn" class="btn btn-sm btn-primary ms-2">Send Test Webhook</button>
          </div>
        </div>
        <div id="webhooks-container"></div>
      </div>
    </div>
  </div>
  
  <script>
    // Add connection troubleshooting messages
    window.addEventListener('load', function() {
      setTimeout(function() {
        const status = document.getElementById('connection-status');
        if (status.textContent === 'Connecting...') {
          status.innerHTML = 'Connection issues. <a href="/azure-logs" style="color: white; text-decoration: underline;">Check logs</a>';
        }
      }, 5000); // After 5 seconds
    });
  
    // Connect to WebSocket
    const socket = io();
    const webhooksContainer = document.getElementById('webhooks-container');
    const connectionStatus = document.getElementById('connection-status');
    const clearBtn = document.getElementById('clear-btn');
    const testBtn = document.getElementById('test-btn');
    const totalCount = document.getElementById('total-count');
    const requestReceivedCount = document.getElementById('request-received-count');
    const signatoryCompletedCount = document.getElementById('signatory-completed-count');
    const requestCompletedCount = document.getElementById('request-completed-count');
    const requestRejectedCount = document.getElementById('request-rejected-count');
    
    let webhookCount = 0;
    let eventCounts = {
      '1': 0, // SignRequestReceived
      '2': 0, // SignatoryCompleted
      '3': 0, // RequestCompleted
      '5': 0  // RequestRejected
    };
    
    // Connection handlers
    socket.on('connect', () => {
      connectionStatus.className = 'badge bg-success';
      connectionStatus.textContent = 'Connected';
    });
    
    socket.on('disconnect', () => {
      connectionStatus.className = 'badge bg-danger';
      connectionStatus.textContent = 'Disconnected';
    });
    
    socket.on('connect_error', (error) => {
      console.error('Connection error:', error);
      connectionStatus.className = 'badge bg-danger';
      connectionStatus.innerHTML = 'Connection Error. <a href="/azure-logs" style="color: white; text-decoration: underline;">Check logs</a>';
      
      // Add connection error card
      const errorCard = document.createElement('div');
      errorCard.className = 'card webhook-card event-5'; // Red border
      errorCard.innerHTML = 
        '<div class="card-header">' +
        '  <div>' +
        '    <span class="badge bg-danger">Connection Error</span>' +
        '  </div>' +
        '  <span class="timestamp">' + new Date().toLocaleString() + '</span>' +
        '</div>' +
        '<div class="card-body">' +
        '  <p>There was an error connecting to the server. Check the following:</p>' +
        '  <ul>' +
        '    <li>Server is running</li>' +
        '    <li>WebSocket connections are enabled on Azure</li>' +
        '    <li>Check <a href="/azure-logs">Azure logs</a> for more details</li>' +
        '  </ul>' +
        '  <p>Error: ' + (error.message || 'Unknown error') + '</p>' +
        '</div>';
      
      // Add to container at the top
      webhooksContainer.insertBefore(errorCard, webhooksContainer.firstChild);
    });
    
    // Initial webhooks load
    socket.on('init-webhooks', (webhooks) => {
      webhooksContainer.innerHTML = '';
      webhookCount = webhooks.length;
      
      // Reset counters
      eventCounts = { '1': 0, '2': 0, '3': 0, '5': 0 };
      
      // Add all existing webhooks
      webhooks.forEach(webhook => {
        addWebhookCard(webhook, false);
        updateEventCounter(webhook.EventId);
      });
      
      updateCounters();
    });
    
    // New webhook received
    socket.on('new-webhook', (webhook) => {
      addWebhookCard(webhook, true);
      webhookCount++;
      updateEventCounter(webhook.EventId);
      updateCounters();
    });
    
    // Update all counter displays
    function updateCounters() {
      totalCount.textContent = webhookCount;
      requestReceivedCount.textContent = eventCounts['1'];
      signatoryCompletedCount.textContent = eventCounts['2'];
      requestCompletedCount.textContent = eventCounts['3'];
      requestRejectedCount.textContent = eventCounts['5'];
    }
    
    // Track event counts
    function updateEventCounter(eventId) {
      if (eventId && eventCounts[eventId] !== undefined) {
        eventCounts[eventId]++;
      }
    }
    
    // Add webhook card to the container
    function addWebhookCard(webhook, isNew) {
      const card = document.createElement('div');
      card.className = 'card webhook-card event-' + (webhook.EventId || 'unknown');
      if (isNew) card.classList.add('new');
      
      // Get event type badge
      const eventName = getEventName(webhook.EventId);
      const badgeClass = 'badge badge-event-' + (webhook.EventId || 'unknown');
      
      // Create uuid chip
      const requestIdChip = webhook.RequestId ? 
        '<span class="request-id-chip">' + webhook.RequestId + '</span>' : '';
      
      card.innerHTML = 
        '<div class="card-header">' +
        '  <div>' +
        '    <span class="badge ' + badgeClass + '">' + eventName + '</span>' +
        '    ' + requestIdChip +
        '  </div>' +
        '  <span class="timestamp">' + formatDate(webhook.receivedAt) + '</span>' +
        '</div>' +
        '<div class="card-body">' +
        '  <div class="row">' +
        '    <div class="col-md-6">' +
        '      <p class="mb-1"><strong>User:</strong> ' + (webhook.UserName || 'N/A') + '</p>' +
        '      <p class="mb-1"><strong>Email:</strong> ' + (webhook.Email || 'N/A') + '</p>' +
        '      <p class="mb-0"><strong>Subject:</strong> ' + (webhook.Subject || 'N/A') + '</p>' +
        '    </div>' +
        '    <div class="col-md-6">' +
        '      <p class="mb-1"><strong>Event Time:</strong> ' + formatDate(webhook.EventTime) + '</p>' +
        '      <p class="mb-0"><strong>Event ID:</strong> ' + (webhook.EventId || 'N/A') + '</p>' +
        '    </div>' +
        '  </div>' +
        '<hr>' +
        '<h6 class="mb-2">Raw Data:</h6>' +
        '<pre>' + JSON.stringify(webhook, null, 2) + '</pre>' +
        '</div>';
      
      // Add to container at the top
      webhooksContainer.insertBefore(card, webhooksContainer.firstChild);
      
      // Animate new items
      if (isNew) {
        setTimeout(() => {
          card.classList.remove('new');
        }, 3000);
      }
    }
    
    // Format date for display
    function formatDate(dateString) {
      if (!dateString) return 'N/A';
      try {
        const date = new Date(dateString);
        return date.toLocaleString();
      } catch (e) {
        return dateString;
      }
    }
    
    // Get event name from ID
    function getEventName(eventId) {
      const events = {
        '1': 'Sign Request Received',
        '2': 'Signatory Completed',
        '3': 'Request Completed',
        '5': 'Request Rejected'
      };
      return events[eventId] || 'Unknown Event';
    }
    
    // Clear button handler
    clearBtn.addEventListener('click', () => {
      webhooksContainer.innerHTML = '';
      socket.emit('clear-webhooks');
    });
    
    // Test webhook button handler
    testBtn.addEventListener('click', async () => {
      try {
        // Generate a random UUID for testing
        const uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
          const r = Math.random() * 16 | 0;
          const v = c === 'x' ? r : (r & 0x3 | 0x8);
          return v.toString(16);
        });
        
        // Placeholder data for test
        const testData = {
          RequestId: uuid,
          UserName: "Test User",
          Email: "test@example.com",
          Subject: "Test Webhook",
          EventId: 1,
          EventDescription: "SignRequestReceived",
          EventTime: new Date().toISOString()
        };
        
        // Show feedback that test is being sent
        connectionStatus.className = 'badge bg-warning';
        connectionStatus.textContent = 'Sending test...';
        
        // Send test webhook request
        const response = await fetch('/webhook/evia-sign', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(testData)
        });
        
        if (!response.ok) {
          throw new Error('HTTP error ' + response.status);
        }
        
        // Show success
        connectionStatus.className = 'badge bg-success';
        connectionStatus.textContent = 'Test sent!';
        setTimeout(() => {
          if (connectionStatus.textContent === 'Test sent!') {
            connectionStatus.textContent = 'Connected';
          }
        }, 3000);
        
        console.log('Test webhook sent successfully');
      } catch (error) {
        console.error('Error sending test webhook:', error);
        connectionStatus.className = 'badge bg-danger';
        connectionStatus.textContent = 'Test failed!';
        alert('Error sending test webhook: ' + error.message);
      }
    });
  </script>
</body>
</html>
  `);
});

// Register the webhook routes
app.post('/webhook/evia-sign', handleEviaSignWebhook);
app.post('/webhook/eviasign', handleEviaSignWebhook);

// Create HTTP server and Socket.IO instance
const server = http.createServer(app);
const io = new Server(server, {
  // Socket.IO configuration for Azure WebSockets
  transports: ['websocket', 'polling'],  // Try WebSocket first, fallback to polling
  pingTimeout: 60000,                    // Increase ping timeout for Azure
  pingInterval: 25000,                   // Ping clients more frequently to keep connection
  cors: {
    origin: "*",                         // Allow connections from any origin
    methods: ["GET", "POST"]
  }
});

// Set up Socket.IO connection
io.on('connection', (socket) => {
  console.log('Dashboard client connected');
  
  // Send existing webhooks to new clients
  socket.emit('init-webhooks', recentWebhooks);
  
  // Handle clear webhooks request
  socket.on('clear-webhooks', () => {
    recentWebhooks.length = 0;
    io.emit('init-webhooks', []);
  });
  
  socket.on('disconnect', () => {
    console.log('Dashboard client disconnected');
  });
});

// Set up the database processor listener
webhookProcessor.on('new-webhook', async (webhookData, storedEventId) => {
  const requestId = webhookData.RequestId || 'unknown';
  const eventId = webhookData.EventId || 'unknown';
  const processingId = new Date().toISOString().replace(/[:.]/g, '') + '-' + requestId.substring(0, 8);
  
  console.log(`\n=== [${processingId}] DATABASE PROCESSOR STARTING FOR WEBHOOK ===`);
  console.log(`[${processingId}] TIMESTAMP: ${new Date().toISOString()}`);
  console.log(`[${processingId}] RequestId: ${requestId}, EventId: ${eventId}, Type: ${webhookData.EventDescription || 'unknown'}`);
  logToFile(`=== [${processingId}] DATABASE PROCESSOR STARTING FOR WEBHOOK ===`);
  logToFile(`[${processingId}] RequestId: ${requestId}, EventId: ${eventId}, Type: ${webhookData.EventDescription || 'unknown'}`);
  
  try {
    // Process the webhook (detailed business logic)
    console.log(`\n=== [${processingId}] BEGINNING EVENT PROCESSING ===`);
    logToFile(`=== [${processingId}] BEGINNING EVENT PROCESSING ===`);
    try {
      // Event-specific processing
      console.log(`[${processingId}] Calling processWebhookEvent for business logic processing`);
      logToFile(`[${processingId}] Calling processWebhookEvent for business logic processing`);
      const processingStart = Date.now();
      const result = await processWebhookEvent(webhookData);
      const processingDuration = Date.now() - processingStart;
      
      console.log(`[${processingId}] Webhook processing completed in ${processingDuration}ms`);
      logToFile(`[${processingId}] Webhook processing completed in ${processingDuration}ms`);
      console.log(`[${processingId}] Processing result: `, JSON.stringify(result, null, 2));
      logToFile(`[${processingId}] Processing result: ${JSON.stringify(result)}`);
    
      // Mark as processed in Supabase only if we have an ID
      if (storedEventId) {
        console.log(`[${processingId}] Marking event ${storedEventId} as processed in database`);
        logToFile(`[${processingId}] Marking event ${storedEventId} as processed in database`);
        try {
          // Direct HTTP PATCH for debugging
          console.log(`[${processingId}] Using direct HTTP PATCH to mark processed...`);
          const updateStart = Date.now();
          const updateResponse = await fetch(
            `${process.env.SUPABASE_URL}/rest/v1/webhook_events?id=eq.${storedEventId}`,
            {
              method: 'PATCH',
              headers: {
                'apikey': process.env.SUPABASE_SERVICE_KEY,
                'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
                'Content-Type': 'application/json',
                'Prefer': 'return=representation'
              },
              body: JSON.stringify({
                processed: true,
                updatedat: new Date().toISOString()
              })
            }
          );
          const updateDuration = Date.now() - updateStart;
          
          if (updateResponse.ok) {
            console.log(`[${processingId}] Successfully marked event as processed via direct PATCH (took ${updateDuration}ms)`);
            logToFile(`[${processingId}] Successfully marked event as processed via direct PATCH (took ${updateDuration}ms)`);
            const updateData = await updateResponse.json();
            console.log(`[${processingId}] Update response: `, JSON.stringify(updateData, null, 2));
          } else {
            const errorText = await updateResponse.text();
            console.error(`[${processingId}] Failed to mark processed via direct PATCH: ${updateResponse.status} - ${errorText}`);
            logToFile(`[${processingId}] Failed to mark processed via direct PATCH: ${updateResponse.status} - ${errorText}`);
            
            // Fall back to supabaseClient method
            console.log(`[${processingId}] Falling back to markWebhookEventProcessed...`);
            logToFile(`[${processingId}] Falling back to markWebhookEventProcessed`);
            await markWebhookEventProcessed(storedEventId);
            console.log(`[${processingId}] Successfully marked event as processed via fallback`);
            logToFile(`[${processingId}] Successfully marked event as processed via fallback`);
          }
        } catch (markError) {
          console.error(`[${processingId}] Error marking webhook as processed: ${markError}`);
          logToFile(`[${processingId}] Error marking webhook as processed: ${markError.message}`);
          // Continue despite marking error
        }
      } else {
        console.log(`[${processingId}] No stored event ID available, skipping marking as processed`);
        logToFile(`[${processingId}] No stored event ID available, skipping marking as processed`);
      }
    } catch (processError) {
      console.error(`[${processingId}] Error processing webhook event: ${processError}`);
      logToFile(`[${processingId}] Error processing webhook event: ${processError.message}`);
      logToFile(`[${processingId}] Stack trace: ${processError.stack || 'No stack trace available'}`);
      
      // If we have a storedEventId, mark it as errored
      if (storedEventId) {
        try {
          console.log(`[${processingId}] Marking event ${storedEventId} as errored`);
          logToFile(`[${processingId}] Marking event ${storedEventId} as errored`);
          // Simple direct update to avoid schema issues
          const errorResponse = await fetch(
            `${process.env.SUPABASE_URL}/rest/v1/webhook_events?id=eq.${storedEventId}`,
            {
              method: 'PATCH',
              headers: {
                'apikey': process.env.SUPABASE_SERVICE_KEY,
                'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                processed: true,
                updatedat: new Date().toISOString(),
                error_message: processError.message.substring(0, 255) // Truncate if needed
              })
            }
          );
          
          if (errorResponse.ok) {
            console.log(`[${processingId}] Successfully marked event as errored`);
            logToFile(`[${processingId}] Successfully marked event as errored`);
          } else {
            const errorText = await errorResponse.text();
            console.error(`[${processingId}] Failed to mark as errored: ${errorText}`);
            logToFile(`[${processingId}] Failed to mark as errored: ${errorText}`);
          }
        } catch (markError) {
          console.error(`[${processingId}] Error marking webhook as errored: ${markError}`);
          logToFile(`[${processingId}] Error marking webhook as errored: ${markError.message}`);
        }
      }
    }
    
    console.log(`\n==== [${processingId}] WEBHOOK PROCESSING COMPLETE ====`);
    logToFile(`==== [${processingId}] WEBHOOK PROCESSING COMPLETE ====`);
    
  } catch (error) {
    // Handle any unexpected errors in the processor
    console.error(`[${processingId}] Critical error in webhook processor: ${error}`);
    logToFile(`[${processingId}] Critical error in webhook processor: ${error.message}`);
    console.log(`[${processingId}] STACK TRACE: ${error.stack}`);
    logToFile(`[${processingId}] Stack trace: ${error.stack || 'No stack trace available'}`);
  }
});

// Add an Azure logs endpoint
app.get('/azure-logs', (req, res) => {
  try {
    let logs = 'No logs available';
    
    // Check if running in Azure
    if (process.env.WEBSITE_SITE_NAME) {
      const azureLogPath = path.join('D:\\home\\LogFiles', 'webhook-logs.txt');
      
      if (fs.existsSync(azureLogPath)) {
        // Read the most recent logs (last 100 lines)
        logs = fs.readFileSync(azureLogPath, 'utf8')
          .split('\n')
          .filter(line => line.trim())
          .slice(-100)
          .join('\n');
      } else {
        logs = 'Azure log file does not exist yet. Will be created on next webhook event.';
      }
    } else {
      logs = 'Not running in Azure environment';
    }
    
    const html = '<!DOCTYPE html>' +
      '<html>' +
      '  <head>' +
      '    <title>Azure Webhook Logs</title>' +
      '    <style>' +
      '      body { font-family: system-ui, sans-serif; line-height: 1.5; max-width: 1000px; margin: 0 auto; padding: 20px; }' +
      '      h1 { color: #2563eb; }' +
      '      pre { background: #f3f4f6; padding: 12px; border-radius: 4px; overflow: auto; white-space: pre-wrap; }' +
      '      a { color: #2563eb; }' +
      '      .controls { margin-bottom: 15px; }' +
      '    </style>' +
      '  </head>' +
      '  <body>' +
      '    <h1>Azure Webhook Logs</h1>' +
      '    <div class="controls">' +
      '      <a href="/">Back to status page</a> | ' +
      '      <a href="/dashboard">Back to dashboard</a> | ' +
      '      <a href="/azure-logs" onclick="location.reload(); return false;">Refresh Logs</a>' +
      '    </div>' +
      '    <div>' +
      '      <strong>Azure Site:</strong> ' + (process.env.WEBSITE_SITE_NAME || 'Not running in Azure') +
      '    </div>' +
      '    <pre>' + logs + '</pre>' +
      '  </body>' +
      '</html>';
    
    res.send(html);
  } catch (err) {
    res.status(500).send('Error reading Azure logs: ' + err.message);
  }
});

// Add an admin troubleshooting page
app.get('/admin', (req, res) => {
  const memory = process.memoryUsage();
  const formattedMemory = {};
  
  // Format memory values to MB for easier reading
  for (let key in memory) {
    formattedMemory[key] = Math.round(memory[key] / 1024 / 1024 * 100) / 100 + ' MB';
  }
  
  // Get system info
  const systemInfo = {
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    uptime: Math.floor(process.uptime() / 60) + ' minutes',
    totalMemory: formattedMemory.rss,
    heapTotal: formattedMemory.heapTotal,
    heapUsed: formattedMemory.heapUsed,
    external: formattedMemory.external,
    arrayBuffers: formattedMemory.arrayBuffers
  };
  
  // Check Azure environment
  const isAzure = !!process.env.WEBSITE_SITE_NAME;
  const azureInfo = isAzure ? {
    siteName: process.env.WEBSITE_SITE_NAME,
    nodeVersion: process.env.WEBSITE_NODE_DEFAULT_VERSION,
    scmType: process.env.SCM_TYPE,
    deploymentId: process.env.DEPLOYMENT_ID,
    instanceId: process.env.WEBSITE_INSTANCE_ID
  } : null;
  
  // Get info on connected socket clients
  const socketInfo = {
    connectedClients: Object.keys(io.sockets.sockets).length,
    roomCount: Object.keys(io.sockets.adapter.rooms).length
  };
  
  // Create the Azure environment section if running in Azure
  const azureSection = isAzure ? 
    '<div class="section">' +
    '  <h2>Azure Environment</h2>' +
    '  <div class="diagnostic"><strong>Site name:</strong> ' + azureInfo.siteName + '</div>' +
    '  <div class="diagnostic"><strong>Node version:</strong> ' + azureInfo.nodeVersion + '</div>' +
    '  <div class="diagnostic"><strong>Instance ID:</strong> ' + azureInfo.instanceId + '</div>' +
    '  <div class="diagnostic"><strong>Deployment ID:</strong> ' + azureInfo.deploymentId + '</div>' +
    '</div>' : '';
  
  // Create the restart button only if in Azure
  const restartButton = isAzure ? 
    '<a href="/admin/restart" class="btn btn-danger" onclick="return confirm(\'Are you sure you want to restart the server?\')">Restart Server</a>' : '';
  
  // Environment variables to display (with sensitive data masked)
  const envVars = {
    NODE_ENV: process.env.NODE_ENV,
    PORT: process.env.PORT,
    SUPABASE_URL: process.env.SUPABASE_URL ? '✓ Set' : '✗ Not set',
    SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY ? '✓ Set' : '✗ Not set',
    EVIA_SIGN_WEBHOOK_URL: process.env.EVIA_SIGN_WEBHOOK_URL
  };
  
  const html = '<!DOCTYPE html>' +
    '<html>' +
    '  <head>' +
    '    <title>Webhook Server Admin</title>' +
    '    <style>' +
    '      body { font-family: system-ui, sans-serif; line-height: 1.5; max-width: 1000px; margin: 0 auto; padding: 20px; }' +
    '      h1, h2 { color: #2563eb; }' +
    '      pre { background: #f3f4f6; padding: 12px; border-radius: 4px; overflow: auto; white-space: pre-wrap; }' +
    '      a { color: #2563eb; }' +
    '      .controls { margin-bottom: 15px; }' +
    '      .warning { color: #ef4444; font-weight: bold; }' +
    '      .section { margin-bottom: 20px; padding: 15px; border: 1px solid #e5e7eb; border-radius: 8px; }' +
    '      .btn { display: inline-block; padding: 8px 16px; background: #3b82f6; color: white; ' +
    '             border-radius: 4px; text-decoration: none; margin-right: 8px; }' +
    '      .btn-warning { background: #f59e0b; }' +
    '      .btn-danger { background: #ef4444; }' +
    '      .actions { margin: 20px 0; }' +
    '      .diagnostic { font-family: monospace; margin-bottom: 10px; }' +
    '    </style>' +
    '  </head>' +
    '  <body>' +
    '    <h1>Webhook Server Admin Panel</h1>' +
    '    <div class="controls">' +
    '      <a href="/">Home</a> | ' +
    '      <a href="/dashboard">Dashboard</a> | ' +
    '      <a href="/azure-logs">Azure Logs</a> |' +
    '      <a href="/logs">Server Logs</a>' +
    '    </div>' +
    '    ' +
    '    <div class="section">' +
    '      <h2>Server Status</h2>' +
    '      <div class="diagnostic"><strong>Timestamp:</strong> ' + new Date().toISOString() + '</div>' +
    '      <div class="diagnostic"><strong>Webhooks processed:</strong> ' + eventCount + '</div>' +
    '      <div class="diagnostic"><strong>Server uptime:</strong> ' + systemInfo.uptime + '</div>' +
    '      <div class="diagnostic"><strong>Memory usage:</strong> ' + systemInfo.heapUsed + ' / ' + systemInfo.heapTotal + '</div>' +
    '      <div class="diagnostic"><strong>WebSocket clients:</strong> ' + socketInfo.connectedClients + '</div>' +
    '    </div>' +
    '    ' +
    azureSection +
    '    ' +
    '    <div class="section">' +
    '      <h2>Actions</h2>' +
    '      <p>These actions can help recover from errors without a full app restart.</p>' +
    '      <div class="actions">' +
    '        <a href="/admin/clear-memory" class="btn" onclick="return confirm(\'Are you sure you want to run garbage collection?\')">Clear Memory</a>' +
    '        <a href="/admin/reset-connections" class="btn btn-warning" onclick="return confirm(\'Are you sure you want to reset all Socket.IO connections?\')">Reset WebSocket Connections</a>' +
    '        ' + restartButton +
    '      </div>' +
    '    </div>' +
    '    ' +
    '    <div class="section">' +
    '      <h2>System Information</h2>' +
    '      <pre>' + JSON.stringify(systemInfo, null, 2) + '</pre>' +
    '    </div>' +
    '    ' +
    '    <div class="section">' +
    '      <h2>Environment Variables</h2>' +
    '      <pre>' + JSON.stringify(envVars, null, 2) + '</pre>' +
    '    </div>' +
    '  </body>' +
    '</html>';
  
  res.send(html);
});

// Admin routes for troubleshooting
app.get('/admin/clear-memory', (req, res) => {
  if (global.gc) {
    global.gc();
    res.send('<html><body><h1>Memory Cleared</h1><p>Garbage collection completed. <a href="/admin">Back to Admin</a></p></body></html>');
  } else {
    res.send('<html><body><h1>Error</h1><p>Garbage collection not available. Start Node with --expose-gc flag. <a href="/admin">Back to Admin</a></p></body></html>');
  }
});

app.get('/admin/reset-connections', (req, res) => {
  // Close all socket connections
  io.sockets.disconnectSockets();
  
  res.send('<html><body><h1>WebSocket Connections Reset</h1><p>All Socket.IO connections have been closed. <a href="/admin">Back to Admin</a></p></body></html>');
});

app.get('/admin/restart', (req, res) => {
  res.send('<html><body><h1>Server Restarting</h1><p>The server will restart in 5 seconds.</p><script>setTimeout(function() { window.location = "/admin"; }, 8000);</script></body></html>');
  
  // Schedule restart after response is sent
  setTimeout(() => {
    console.log('Server restart requested through admin panel');
    logToFile('Server restart requested through admin panel');
    process.exit(0); // Azure App Service will restart the app
  }, 5000);
});

// Admin endpoint to create SQL functions for emergency updates
app.post('/admin/create-sql-functions', async (req, res) => {
  try {
    console.log('Creating SQL functions for emergency webhook updates');
    
    // Create a function to update webhook_events
    const createFnResult = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/create_emergency_functions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': process.env.SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`
      },
      body: JSON.stringify({
        sql_function: `
          CREATE OR REPLACE FUNCTION update_webhook_processed(p_id uuid)
          RETURNS void AS $$
          BEGIN
            UPDATE webhook_events SET processed = true, updatedat = NOW() WHERE id = p_id;
          END;
          $$ LANGUAGE plpgsql;
          
          CREATE OR REPLACE FUNCTION emergency_update_webhook(webhook_id uuid)
          RETURNS text AS $$
          DECLARE
            result text;
          BEGIN
            UPDATE webhook_events SET processed = true WHERE id = webhook_id;
            GET DIAGNOSTICS result = ROW_COUNT;
            RETURN result || ' rows updated';
          END;
          $$ LANGUAGE plpgsql;
        `
      })
    });
    
    if (createFnResult.ok) {
      console.log('SQL functions created successfully');
      res.status(200).send('SQL functions created successfully');
    } else {
      const errorText = await createFnResult.text();
      console.error('Failed to create SQL functions:', errorText);
      res.status(500).send('Failed to create SQL functions: ' + errorText);
    }
  } catch (error) {
    console.error('Error creating SQL functions:', error);
    res.status(500).send('Error creating SQL functions: ' + error.message);
  }
});

// Start the server
server.listen(PORT, () => {
  console.log(`Webhook server running on port ${PORT}`);
  console.log(`Webhook endpoint: ${webhookUrl}`);
  console.log(`Dashboard available at: http://localhost:${PORT}/dashboard`);
  
  // Set up self-ping for Azure to avoid idle timeouts
  if (process.env.WEBSITE_SITE_NAME) {
    console.log('Setting up self-ping mechanism to keep Azure app alive');
    
    // Get the Azure site URL
    const azureURL = `https://${process.env.WEBSITE_SITE_NAME}.azurewebsites.net`;
    
    // Ping the health endpoint every 5 minutes to prevent idle shutdown
    setInterval(async () => {
      try {
        const response = await fetch(`${azureURL}/health`);
        if (response.ok) {
          console.log(`Self-ping successful at ${new Date().toISOString()}`);
        } else {
          console.error(`Self-ping failed with status ${response.status}`);
        }
      } catch (error) {
        console.error('Error during self-ping:', error.message);
      }
    }, 5 * 60 * 1000); // 5 minutes
    
    // Log startup to Azure logs
    logToFile(`=== SERVER STARTED IN AZURE ENVIRONMENT (${process.env.WEBSITE_SITE_NAME}) ===`);
    logToFile(`Webhook endpoint: ${webhookUrl}`);
  }
});