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

// Initialize a list to store recent webhooks (limited to 50)
const recentWebhooks = [];
const MAX_STORED_WEBHOOKS = 50;

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

// Function to broadcast webhook events to connected clients
function broadcastWebhook(webhookData) {
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

// Handle Evia Sign webhooks
const handleEviaSignWebhook = async (req, res) => {
  try {
    const webhookData = req.body;
    
    // Add received timestamp
    webhookData.receivedAt = new Date().toISOString();
    
    // Log webhook
    console.log(`Processing webhook: RequestId=${webhookData.RequestId}, EventId=${webhookData.EventId}`);
    
    // Broadcast to dashboard
    broadcastWebhook(webhookData);
    
    // Increment event count for status page
    eventCount++;
    
    // Process the webhook
    const result = await processSignatureEvent(webhookData);
    
    // Store the webhook event in Supabase
    try {
      const storedEvent = await insertWebhookEvent(webhookData);
      
      // Check if we've stored the event successfully
      if (storedEvent && storedEvent.id) {
        const marked = await markWebhookEventProcessed(storedEvent.id, result);
        if (!marked) {
          console.warn(`Warning: Could not mark webhook event ${storedEvent.id} as processed`);
        }
      }
    } catch (dbError) {
      console.error('Error storing webhook event in database:', dbError);
      logToFile(`Error storing webhook event: ${dbError.message}`);
      
      // Store locally as backup if database fails
      await storeEventLocally(webhookData);
    }
    
    res.status(200).json({ success: true, message: 'Webhook processed successfully' });
  } catch (error) {
    console.error('Error processing webhook:', error);
    logToFile(`Error processing webhook: ${error.message}`);
    
    // Still try to store the event locally even if processing failed
    if (req.body) {
      try {
        await storeEventLocally(req.body);
      } catch (storeError) {
        console.error('Could not store event locally:', storeError);
      }
    }
    
    // Return 200 to the webhook sender to prevent retries
    // But include the error in the response
    res.status(500).json({ 
      success: false, 
      message: `Error: ${error.message}` 
    });
  }
};

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
        \`<span class="request-id-chip">\${webhook.RequestId}</span>\` : '';
      
      card.innerHTML = \`
        <div class="card-header">
          <div>
            <span class="badge \${badgeClass}">\${eventName}</span>
            \${requestIdChip}
          </div>
          <span class="timestamp">\${formatDate(webhook.receivedAt)}</span>
        </div>
        <div class="card-body">
          <div class="row">
            <div class="col-md-6">
              <p class="mb-1"><strong>User:</strong> \${webhook.UserName || 'N/A'}</p>
              <p class="mb-1"><strong>Email:</strong> \${webhook.Email || 'N/A'}</p>
              <p class="mb-0"><strong>Subject:</strong> \${webhook.Subject || 'N/A'}</p>
            </div>
            <div class="col-md-6">
              <p class="mb-1"><strong>Event Time:</strong> \${formatDate(webhook.EventTime)}</p>
              <p class="mb-0"><strong>Event ID:</strong> \${webhook.EventId || 'N/A'}</p>
            </div>
          </div>
          <hr>
          <h6 class="mb-2">Raw Data:</h6>
          <pre>\${JSON.stringify(webhook, null, 2)}</pre>
        </div>
      \`;
      
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
        
        // Send test webhook request
        const response = await fetch('/webhook/evia-sign', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(testData)
        });
        
        if (!response.ok) {
          throw new Error(\`HTTP error \${response.status}\`);
        }
        
        console.log('Test webhook sent successfully');
      } catch (error) {
        console.error('Error sending test webhook:', error);
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
const io = new Server(server);

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

// Start the server
server.listen(PORT, () => {
  console.log(`Webhook server running on port ${PORT}`);
  console.log(`Webhook endpoint: ${webhookUrl}`);
  console.log(`Dashboard available at: http://localhost:${PORT}/dashboard`);
});