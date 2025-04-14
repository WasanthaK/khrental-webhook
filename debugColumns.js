// Debug script to list column names in webhook_events table
import dotenv from 'dotenv';
import supabase from './services/supabaseClient.js';
import fs from 'fs';

// Load environment variables
dotenv.config();

// Set up logging to a file
const logFile = './columns-debug.txt';
fs.writeFileSync(logFile, `Webhook_events Columns Debug - ${new Date().toISOString()}\n\n`);

function log(message) {
  const logMessage = typeof message === 'object' ? JSON.stringify(message, null, 2) : message;
  fs.appendFileSync(logFile, logMessage + '\n');
  console.log(message);
}

async function main() {
  log("=== Examining webhook_events table structure ===");
  
  try {
    // Try a sample record to see column names
    const { data: sampleData, error: sampleError } = await supabase
      .from('webhook_events')
      .select('*')
      .limit(1);
      
    if (sampleError) {
      log("Error fetching sample record:");
      log(sampleError);
    } else if (sampleData && sampleData.length > 0) {
      log("\nSample record column names:");
      log(Object.keys(sampleData[0]));
      
      // Print all column names and their values
      log("\nDetailed column values:");
      const record = sampleData[0];
      for (const [key, value] of Object.entries(record)) {
        log(`${key}: ${typeof value} = ${JSON.stringify(value)}`);
      }
      
      // Create a test update object that matches the exact database column names
      const columnNames = Object.keys(record);
      log("\nCreating test update object with exact column names:");
      
      const updateData = {
        processed: true
      };
      
      // Find the timestamp column name
      const timestampColumn = columnNames.find(col => 
        col.toLowerCase().includes('update') || 
        col.toLowerCase().includes('updated'));
        
      if (timestampColumn) {
        updateData[timestampColumn] = new Date().toISOString();
        log(`Using timestamp column: ${timestampColumn}`);
      }
      
      log(updateData);
      
      // Test updating using these exact column names
      if (record.id) {
        log("\nTesting update with correct column names:");
        const { error: updateError } = await supabase
          .from('webhook_events')
          .update(updateData)
          .eq('id', record.id);
          
        if (updateError) {
          log("Update error:");
          log(updateError);
        } else {
          log("Update successful!");
        }
      }
    } else {
      log("No sample records found");
    }
  } catch (err) {
    log("Unhandled error:");
    log(err);
  }
}

// Run the test
log("Starting column debug");
main()
  .catch(err => {
    log("Unhandled error:");
    log(err);
  })
  .finally(() => {
    log("Debug completed");
    log(`Results written to ${logFile}`);
  }); 