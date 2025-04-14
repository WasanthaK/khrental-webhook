// Test script for testing the markWebhookEventProcessed function
import dotenv from 'dotenv';
import { markWebhookEventProcessed } from './services/supabaseClient.js';
import supabase from './services/supabaseClient.js';
import fs from 'fs';

// Load environment variables
dotenv.config();

// Set up logging to a file
const logFile = './process-test-log.txt';
fs.writeFileSync(logFile, `Process Test Log - ${new Date().toISOString()}\n\n`);

function log(message) {
  const logMessage = typeof message === 'object' ? JSON.stringify(message, null, 2) : message;
  fs.appendFileSync(logFile, logMessage + '\n');
  console.log(message);
}

async function main() {
  // First, get the most recent unprocessed event
  log("=== Looking for an unprocessed event ===");
  let eventId = null;
  
  try {
    const { data, error } = await supabase
      .from('webhook_events')
      .select('id, request_id, event_type, processed')
      .eq('processed', false)
      .order('createdat', { ascending: false })
      .limit(1);
      
    if (error) {
      log("Error finding an unprocessed event:");
      log(error);
      return;
    }
    
    if (!data || data.length === 0) {
      log("No unprocessed events found!");
      return;
    }
    
    eventId = data[0].id;
    log(`Found unprocessed event with ID: ${eventId}`);
    log(data[0]);
  } catch (err) {
    log("Exception finding an unprocessed event:");
    log(err);
    return;
  }
  
  // Test marking the event as processed
  log("\n=== Testing markWebhookEventProcessed ===");
  
  if (!eventId) {
    log("No event ID to process, exiting.");
    return;
  }
  
  try {
    log(`Marking event ${eventId} as processed...`);
    const processingResult = { success: true, message: "Test processing" };
    const result = await markWebhookEventProcessed(eventId, processingResult);
    log("Result:");
    log(result);
    
    // Verify the update
    log("\n=== Verifying Event Update ===");
    const { data, error } = await supabase
      .from('webhook_events')
      .select('*')
      .eq('id', eventId)
      .limit(1);
      
    if (error) {
      log("Error verifying update:");
      log(error);
    } else if (data && data.length > 0) {
      log("Updated event:");
      log(data[0]);
      log(`Event is now processed: ${data[0].processed}`);
    } else {
      log("WARNING: Could not find the event after update!");
    }
  } catch (err) {
    log("Exception marking event as processed:");
    log(err);
  }
}

// Run the test
log("Starting process test");
main()
  .catch(err => {
    log("Unhandled error:");
    log(err);
  })
  .finally(() => {
    log("Test completed");
    log(`Results written to ${logFile}`);
  }); 