// Quick webhook database test that only uses direct HTTP
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import crypto from 'crypto';

// Load environment variables
dotenv.config();

const { SUPABASE_URL, SUPABASE_SERVICE_KEY, SUPABASE_ANON_KEY } = process.env;

// Generate a UUID for testing
const testUuid = crypto.randomUUID();

// Create a test webhook record
const testRecord = {
  event_type: "TestEvent",
  eviasignreference: testUuid,
  user_name: "Test User",
  user_email: "test@example.com",
  subject: "Test Subject",
  event_id: 999,
  event_time: new Date().toISOString(),
  raw_data: JSON.stringify({
    test: true,
    timestamp: Date.now()
  }),
  createdat: new Date().toISOString(),
  updatedat: new Date().toISOString(),
  processed: false
};

// Function to insert a test record using direct HTTP
async function insertTestRecord() {
  console.log('Inserting test record with direct HTTP...');
  console.log(`Test UUID: ${testUuid}`);
  
  try {
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
    
    console.log(`Response status: ${response.status}`);
    
    if (response.ok) {
      const data = await response.json();
      console.log('Insertion successful!');
      console.log('Response:', JSON.stringify(data, null, 2));
    } else {
      const errorText = await response.text();
      console.error(`Insertion failed: ${response.status}`);
      console.error(`Error: ${errorText}`);
    }
  } catch (error) {
    console.error('Exception during insertion:', error);
  }
}

// Function to verify the record was inserted
async function checkTestRecord() {
  console.log('\nVerifying test record...');
  
  try {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/webhook_events?eviasignreference=eq.${encodeURIComponent(testUuid)}&limit=1`,
      {
        method: 'GET',
        headers: {
          'apikey': SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
        }
      }
    );
    
    console.log(`Response status: ${response.status}`);
    
    if (response.ok) {
      const data = await response.json();
      if (data && data.length > 0) {
        console.log('Record found in database!');
        console.log('Record ID:', data[0].id);
      } else {
        console.log('Record NOT FOUND in database.');
      }
    } else {
      const errorText = await response.text();
      console.error(`Query failed: ${response.status}`);
      console.error(`Error: ${errorText}`);
    }
  } catch (error) {
    console.error('Exception during verification:', error);
  }
}

// Run the test
async function runTest() {
  console.log('QUICK WEBHOOK DATABASE TEST');
  console.log('==========================');
  console.log(`Supabase URL: ${SUPABASE_URL}`);
  
  await insertTestRecord();
  
  // Wait a moment to ensure processing
  console.log('\nWaiting for database processing...');
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  await checkTestRecord();
  
  console.log('\nTEST COMPLETE');
}

runTest().catch(error => {
  console.error('Unhandled error:', error);
}); 