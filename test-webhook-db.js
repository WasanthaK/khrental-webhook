// Test script to diagnose webhook server database operations
// Run with: node test-webhook-db.js

import supabase from './services/supabaseClient.js';
import { insertWebhookEvent } from './services/supabaseClient.js';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

// Load environment variables
dotenv.config();

// Set up file paths for logging
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOG_PATH = path.join(__dirname, 'db-test-log.txt');

// Helper function to log test results
function log(message) {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] ${message}\n`;
  fs.appendFileSync(LOG_PATH, logEntry);
  console.log(message);
}

// Test 1: Direct database connection
async function testDatabaseConnection() {
  log('======= TESTING DATABASE CONNECTION =======');
  try {
    // Simple query to test connection
    const { data, error } = await supabase
      .from('agreements')
      .select('id')
      .limit(1);
    
    if (error) {
      log(`❌ Database connection error: ${error.message}`);
      return false;
    }
    
    log(`✅ Database connection successful, found ${data?.length || 0} agreements`);
    return true;
  } catch (error) {
    log(`❌ Exception during database connection test: ${error.message}`);
    log(`Stack trace: ${error.stack}`);
    return false;
  }
}

// Test 2: Insert webhook event directly
async function testWebhookEventInsert() {
  log('\n======= TESTING WEBHOOK EVENT INSERT =======');
  try {
    // Create a test webhook event with a proper UUID
    const testEvent = {
      EventId: 1,
      EventDescription: "SignRequestReceived",
      RequestId: crypto.randomUUID(), // Use a proper UUID format
      EventTime: new Date().toISOString(),
      UserName: "Test User",
      Email: "test@example.com",
      Subject: "Test Webhook"
    };
    
    log(`Attempting to insert test webhook event: ${JSON.stringify(testEvent)}`);
    
    // 1. First try to insert directly using the Supabase client
    const directData = {
      event_type: testEvent.EventDescription,
      request_id: testEvent.RequestId, // This is now a valid UUID
      event_id: parseInt(testEvent.EventId, 10),
      event_time: testEvent.EventTime,
      user_name: testEvent.UserName,
      user_email: testEvent.Email,
      subject: testEvent.Subject,
      raw_data: JSON.stringify(testEvent),
      createdat: new Date().toISOString(),
      processed: false
    };
    
    log(`Direct insert data: ${JSON.stringify(directData)}`);
    
    const { data: directResult, error: directError } = await supabase
      .from('webhook_events')
      .insert(directData)
      .select('*');
    
    if (directError) {
      log(`❌ Direct insert error: ${directError.message}`);
      
      // Check if it's a schema mismatch
      if (directError.message.includes('does not exist') || 
          directError.message.includes('column') || 
          directError.message.includes('type')) {
        log('⚠️ This might be a schema mismatch issue. Checking webhook_events table columns...');
        
        const { data: columns, error: columnsError } = await supabase
          .from('information_schema.columns')
          .select('column_name, data_type')
          .eq('table_name', 'webhook_events');
        
        if (columnsError) {
          log(`❌ Could not get columns: ${columnsError.message}`);
        } else {
          log(`📋 webhook_events columns: ${JSON.stringify(columns)}`);
        }
      }
    } else {
      log(`✅ Direct insert successful: ${JSON.stringify(directResult)}`);
    }
    
    // 2. Now try to insert using the service function
    log('\nAttempting to insert using insertWebhookEvent service function...');
    const { data: serviceResult, error: serviceError } = await insertWebhookEvent(testEvent);
    
    if (serviceError) {
      log(`❌ Service insert error: ${serviceError.message}`);
    } else {
      log(`✅ Service insert successful: ${JSON.stringify(serviceResult)}`);
    }
    
    return !directError || !serviceError;
  } catch (error) {
    log(`❌ Exception during webhook insert test: ${error.message}`);
    log(`Stack trace: ${error.stack}`);
    return false;
  }
}

// Test 3: Find and update an agreement
async function testAgreementUpdate() {
  log('\n======= TESTING AGREEMENT UPDATE =======');
  try {
    // 1. First find an agreement
    const { data: agreements, error: findError } = await supabase
      .from('agreements')
      .select('id, status, signature_status, eviasignreference')
      .order('createdat', { ascending: false })
      .limit(1);
    
    if (findError) {
      log(`❌ Error finding agreement: ${findError.message}`);
      return false;
    }
    
    if (!agreements || agreements.length === 0) {
      log('❌ No agreements found to test with');
      return false;
    }
    
    const agreement = agreements[0];
    log(`Found agreement to update: ${JSON.stringify(agreement)}`);
    
    // 2. Try a simple update
    const testNote = `Test update from webhook test at ${new Date().toISOString()}`;
    const updateData = {
      notes: testNote,
      updatedat: new Date().toISOString()
    };
    
    log(`Attempting to update agreement with data: ${JSON.stringify(updateData)}`);
    
    const { data: updateResult, error: updateError } = await supabase
      .from('agreements')
      .update(updateData)
      .eq('id', agreement.id)
      .select('id, notes, updatedat');
    
    if (updateError) {
      log(`❌ Agreement update error: ${updateError.message}`);
      return false;
    }
    
    log(`✅ Agreement update successful: ${JSON.stringify(updateResult)}`);
    
    // 3. Try a signature status update with valid values
    const signatureData = {
      signature_status: 'pending_signature', // Use a known valid value from our schema
      status: 'awaiting_signature',          // Use a known valid value from our schema
      updatedat: new Date().toISOString()
    };
    
    log(`Attempting signature status update with: ${JSON.stringify(signatureData)}`);
    
    const { data: signatureResult, error: signatureError } = await supabase
      .from('agreements')
      .update(signatureData)
      .eq('id', agreement.id)
      .select('id, status, signature_status, updatedat');
    
    if (signatureError) {
      log(`❌ Signature status update error: ${signatureError.message}`);
      return false;
    }
    
    log(`✅ Signature status update successful: ${JSON.stringify(signatureResult)}`);
    return true;
  } catch (error) {
    log(`❌ Exception during agreement update test: ${error.message}`);
    log(`Stack trace: ${error.stack}`);
    return false;
  }
}

// Main test function
async function runTests() {
  log('=================================================');
  log('WEBHOOK SERVER DATABASE DIAGNOSTICS');
  log(`Test started at ${new Date().toISOString()}`);
  log('=================================================\n');
  
  try {
    // Test database connection
    const connectionOk = await testDatabaseConnection();
    if (!connectionOk) {
      log('❌ Database connection test failed. Aborting further tests.');
      return;
    }
    
    // Test webhook event insert
    const webhookInsertOk = await testWebhookEventInsert();
    if (!webhookInsertOk) {
      log('⚠️ Webhook event insert test failed. Continuing with other tests...');
    }
    
    // Test agreement update
    const agreementUpdateOk = await testAgreementUpdate();
    if (!agreementUpdateOk) {
      log('⚠️ Agreement update test failed.');
    }
    
    // Final summary
    log('\n=================================================');
    log('TEST SUMMARY:');
    log(`Database Connection: ${connectionOk ? '✅ PASS' : '❌ FAIL'}`);
    log(`Webhook Event Insert: ${webhookInsertOk ? '✅ PASS' : '❌ FAIL'}`);
    log(`Agreement Update: ${agreementUpdateOk ? '✅ PASS' : '❌ FAIL'}`);
    log('=================================================');
    
    if (connectionOk && webhookInsertOk && agreementUpdateOk) {
      log('🎉 All tests passed! The database operations should be working correctly.');
      log('If you are still experiencing issues with webhook processing, check the webhook event processing logic.');
    } else {
      log('⚠️ Some tests failed. Review the log above for details on what went wrong.');
    }
  } catch (error) {
    log(`❌ Unexpected error during tests: ${error.message}`);
    log(`Stack trace: ${error.stack}`);
  }
}

runTests().catch(error => {
  log(`FATAL ERROR: ${error.message}`);
  log(`Stack trace: ${error.stack}`);
}); 