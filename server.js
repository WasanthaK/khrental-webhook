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

// Verify the webhook URL from .env
const webhookUrl = process.env.VITE_EVIA_WEBHOOK_URL || process.env.EVIA_SIGN_WEBHOOK_URL || `http://localhost:${PORT}/webhook/evia-sign`;

// Database file paths
const DB_DIR = path.join(__dirname, 'data');
const EVENTS_DB_PATH = path.join(DB_DIR, 'webhook-events.json');
const LOGS_PATH = path.join(DB_DIR, 'webhook-logs.txt');

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
    fs.appendFileSync(LOGS_PATH, logEntry);
  } catch (err) {
    console.error('Error writing to log:', err);
  }
}

// Function to store webhook events in the local JSON database
async function storeEventLocally(event) {
  try {
    return db.addEvent(event);
  } catch (error) {
    console.error('Error storing event locally:', error);
    logToFile(`Error storing event locally: ${error.message}`);
    throw error; // Re-throw to allow caller to handle
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
        </style>
      </head>
      <body>
        <h1>Evia Sign Webhook Server</h1>
        <div class="card">
          <h2>Server Status: <span class="status">Running</span></h2>
          <p><strong>Server started at:</strong> ${new Date().toISOString()}</p>
          <p><strong>Port:</strong> ${PORT}</p>
          <p><strong>Events processed:</strong> ${eventCount}</p>
          <p><strong>Webhook endpoint:</strong><br/>
            <code class="webhook-url">POST ${process.env.EVIA_SIGN_WEBHOOK_URL || `http://localhost:${PORT}/webhook/evia-sign`}</code>
          </p>
        </div>
        
        <div class="card">
          <h2>Webhook Testing</h2>
          <p>To test the webhook, send a POST request to the webhook endpoint with a JSON payload.</p>
          <pre>
curl -X POST ${process.env.EVIA_SIGN_WEBHOOK_URL || `http://localhost:${PORT}/webhook/evia-sign`} \\
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
          </ul>
        </div>
      </body>
    </html>
  `);
});

// Add a JSON status endpoint
app.get('/status', (req, res) => {
  res.json({
    status: 'running',
    webhookUrl: process.env.EVIA_SIGN_WEBHOOK_URL || `http://localhost:${PORT}/webhook/evia-sign`,
    serverStarted: new Date().toISOString(),
    eventsProcessed: eventCount,
    port: PORT
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

// Evia Sign webhooks - both paths supported for compatibility
const handleEviaSignWebhook = async (req, res) => {
  try {
    // Log that we received a webhook
    console.log('Received Evia Sign webhook');
    
    // Validate webhook data
    if (!req.body || !req.body.RequestId || !req.body.EventId) {
      console.error('Invalid webhook data: missing RequestId or EventId');
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid webhook data. RequestId and EventId are required.'
      });
    }
    
    // Log the request body for debugging
    console.log(`Processing webhook: RequestId=${req.body.RequestId}, EventId=${req.body.EventId}`);
    
    // Process the webhook
    const result = await processSignatureEvent(req.body);
    
    if (!result.success) {
      console.error('Error processing webhook:', result.error);
      return res.status(500).json({ success: false, error: result.error });
    }
    
    console.log('Webhook processed successfully:', result);
    return res.status(200).json({ success: true, result });
  } catch (error) {
    console.error('Exception in webhook handler:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

// Both routes for maximum compatibility
app.post('/webhook/evia-sign', handleEviaSignWebhook);
app.post('/webhook/eviasign', handleEviaSignWebhook);

// Custom 404 response
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Resource not found',
    validEndpoints: [
      { method: 'GET', path: '/', description: 'Health check' },
      { method: 'POST', path: '/webhook/evia-sign', description: 'Evia Sign webhook endpoint' },
      { method: 'POST', path: '/webhook/eviasign', description: 'Evia Sign alternate webhook endpoint' }
    ]
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: err.message
  });
});

// Start the server
const server = app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`🚀 Webhook endpoints:`);
  console.log(`   - http://localhost:${PORT}/webhook/eviasign (no dash)`);
  console.log(`   - http://localhost:${PORT}/webhook/evia-sign (with dash)`);
  
  // Test Supabase connection on startup
  testConnection().then((result) => {
    if (result.success) {
      console.log('✅ Supabase connection test successful');
    } else {
      console.error(`❌ Supabase connection test failed: ${result.error}`);
    }
  }).catch(err => {
    console.error('❌ Supabase connection test threw exception:', err);
  });
});

// Add error handling
server.on('error', (err) => {
  console.error(`❌ Error starting server: ${err.message}`);
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Is another instance of the server running?`);
    console.error('Try changing the PORT in .env file or stopping the other server.');
  }
  logToFile(`Error starting server: ${err.message}`);
  process.exit(1);
});