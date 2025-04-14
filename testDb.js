// Test script for debugging database connection and webhook events
import dotenv from 'dotenv';
import { testConnection, insertWebhookEvent } from './services/supabaseClient.js';
import supabase from './services/supabaseClient.js';
import fs from 'fs';

// Load environment variables
dotenv.config();

// Set up logging to a file
const logFile = './db-test-log.txt';
fs.writeFileSync(logFile, `Database Test Log - ${new Date().toISOString()}\n\n`);

function log(message) {
  const logMessage = typeof message === 'object' ? JSON.stringify(message, null, 2) : message;
  fs.appendFileSync(logFile, logMessage + '\n');
  console.log(message);
}

async function main() {
  log("=== Testing Database Connection ===");
  const connectionResult = await testConnection();
  log("Connection result:");
  log(connectionResult);

  log("\n=== Testing Webhook Events Table ===");
  
  // Try to query the webhook_events table
  try {
    log("Querying webhook_events table...");
    const { data, error } = await supabase
      .from('webhook_events')
      .select('*')
      .limit(5);
      
    if (error) {
      log("Error querying webhook_events:");
      log(error);
    } else {
      log(`Found ${data?.length || 0} webhook events`);
      if (data && data.length > 0) {
        log("First event:");
        log(data[0]);
      }
    }
  } catch (err) {
    log("Exception querying webhook_events:");
    log(err);
  }
  
  // Test inserting a webhook event
  log("\n=== Testing Webhook Event Insertion ===");
  const testEvent = {
    EventId: 1,
    EventDescription: "SignRequestReceived",
    RequestId: "test-" + Date.now(),
    Email: "test@example.com",
    UserName: "Test User",
    Subject: "Test Document",
    EventTime: new Date().toISOString()
  };
  
  try {
    log("Inserting test webhook event...");
    log("Test event data:");
    log(testEvent);
    const insertResult = await insertWebhookEvent(testEvent);
    log("Insert result:");
    log(insertResult);
  } catch (err) {
    log("Exception inserting webhook event:");
    log(err);
  }
  
  // Check if the event was stored
  try {
    log("\n=== Verifying Event Storage ===");
    const { data, error } = await supabase
      .from('webhook_events')
      .select('*')
      .eq('request_id', testEvent.RequestId)
      .limit(1);
      
    if (error) {
      log("Error verifying event storage:");
      log(error);
    } else {
      log(`Found ${data?.length || 0} matching events`);
      if (data && data.length > 0) {
        log("Stored event:");
        log(data[0]);
      } else {
        log("WARNING: Event was not found in the database after insert!");
      }
    }
  } catch (err) {
    log("Exception verifying event:");
    log(err);
  }
}

// Run the test
log("Starting database test");
main()
  .catch(err => {
    log("Unhandled error:");
    log(err);
  })
  .finally(() => {
    log("Test completed");
    log(`Results written to ${logFile}`);
  }); 