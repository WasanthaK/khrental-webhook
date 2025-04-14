// Debug script: Direct webhook insertion test
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import crypto from 'crypto';

// Load environment variables
dotenv.config();

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;

// Debug logger
function log(message, type = 'INFO') {
  console.log(`[${type}] ${message}`);
}

// Create a test record
const testUuid = crypto.randomUUID();
const timestamp = new Date().toISOString();

const testRecord = {
  event_type: 'TestEvent',
  eviasignreference: testUuid,
  user_name: 'Test User',
  user_email: 'test@example.com',
  subject: 'Test Document',
  event_id: 999,
  event_time: timestamp,
  raw_data: JSON.stringify({
    testId: Date.now().toString(),
    message: 'Test webhook data'
  }),
  createdat: timestamp,
  updatedat: timestamp,
  processed: false
};

// Log the exact record we're sending
log('Attempting to insert test record:');
log(JSON.stringify(testRecord, null, 2));
log(`UUID: ${testUuid}`);

// First check if table exists and columns are correct
async function checkTable() {
  log('Checking table structure...', 'STEP');
  
  try {
    // Use a direct GET request to examine the structure
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/webhook_events?limit=1`,
      {
        method: 'GET',
        headers: {
          'apikey': SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
        }
      }
    );
    
    log(`Table check response status: ${response.status}`);
    
    if (response.ok) {
      const data = await response.json();
      if (data && data.length > 0) {
        log('Table exists and has records.');
        log('Column names:');
        log(Object.keys(data[0]).join(', '));
      } else {
        log('Table exists but is empty.');
      }
      return true;
    } else {
      const errorText = await response.text();
      log(`Table check failed: ${errorText}`, 'ERROR');
      return false;
    }
  } catch (error) {
    log(`Exception checking table: ${error.message}`, 'ERROR');
    return false;
  }
}

// Try to insert a test record
async function insertRecord() {
  log('Inserting test record...', 'STEP');
  
  try {
    // Direct HTTP POST
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
        body: JSON.stringify(testRecord)
      }
    );
    
    log(`Insert response status: ${response.status}`);
    
    if (response.ok) {
      const data = await response.json();
      log('Test record inserted successfully!');
      log(JSON.stringify(data, null, 2));
      return true;
    } else {
      const errorText = await response.text();
      log(`Insert failed: ${errorText}`, 'ERROR');
      
      if (errorText.includes('schema cache')) {
        log('Schema cache issue detected. This is likely the root cause.', 'ERROR');
        log('The table column names may have changed or the table was recreated.', 'ERROR');
      }
      
      return false;
    }
  } catch (error) {
    log(`Exception inserting record: ${error.message}`, 'ERROR');
    return false;
  }
}

// Check if the record was inserted
async function verifyRecord() {
  log('Verifying record insertion...', 'STEP');
  
  try {
    // Query by UUID
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/webhook_events?eviasignreference=eq.${encodeURIComponent(testUuid)}`,
      {
        method: 'GET',
        headers: {
          'apikey': SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
        }
      }
    );
    
    log(`Verification response status: ${response.status}`);
    
    if (response.ok) {
      const data = await response.json();
      if (data && data.length > 0) {
        log('Record found in database!');
        log(`Record ID: ${data[0].id}`);
        return true;
      } else {
        log('Record NOT FOUND in database.', 'ERROR');
        return false;
      }
    } else {
      const errorText = await response.text();
      log(`Verification failed: ${errorText}`, 'ERROR');
      return false;
    }
  } catch (error) {
    log(`Exception verifying record: ${error.message}`, 'ERROR');
    return false;
  }
}

// Run all steps
async function runTest() {
  log('\n===== DIRECT WEBHOOK INSERT TEST =====\n', 'START');
  
  // Run checks sequentially
  const tableExists = await checkTable();
  if (!tableExists) {
    log('Table check failed. Stopping test.', 'FAIL');
    return;
  }
  
  const inserted = await insertRecord();
  if (!inserted) {
    log('Insert failed. Stopping test.', 'FAIL');
    return;
  }
  
  const verified = await verifyRecord();
  if (!verified) {
    log('Verification failed. The record may not have been saved correctly.', 'FAIL');
    return;
  }
  
  log('\n===== TEST COMPLETED SUCCESSFULLY =====\n', 'SUCCESS');
}

// Run the test
runTest().catch(error => {
  log(`Unhandled error: ${error.message}`, 'ERROR');
}); 