// Webhook Database Testing Utility
// Tests and diagnoses database connectivity and operations for webhook events

import dotenv from 'dotenv';
import fetch from 'node-fetch';
import crypto from 'crypto';
import fs from 'fs';
import { createClient } from '@supabase/supabase-js';

// Load environment variables
dotenv.config();

// Configuration
const CONFIG = {
  outputFile: './webhook-db-test-results.json',
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseKey: process.env.SUPABASE_SERVICE_KEY,
  tableName: 'webhook_events',
};

// Create a test UUID
const TEST_UUID = crypto.randomUUID();

// Setup logging
function log(message, type = 'info') {
  const timestamp = new Date().toISOString();
  const prefix = type === 'error' ? '❌ ERROR:' : type === 'warn' ? '⚠️ WARNING:' : '✅ INFO:';
  console.log(`[${timestamp}] ${prefix} ${message}`);
}

// Initialize test results
const testResults = {
  timestamp: new Date().toISOString(),
  config: {
    supabaseUrl: CONFIG.supabaseUrl,
    tableName: CONFIG.tableName,
  },
  tests: {},
  errors: [],
  success: false,
};

// Create Supabase client
const supabase = CONFIG.supabaseUrl && CONFIG.supabaseKey 
  ? createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey)
  : null;

// Test functions
const tests = {
  // Test database connectivity
  async testConnection() {
    log('Testing database connectivity...');
    testResults.tests.connection = { success: false };

    try {
      // Direct HTTP request
      const response = await fetch(`${CONFIG.supabaseUrl}/rest/v1/`, {
        headers: {
          'apikey': CONFIG.supabaseKey,
          'Authorization': `Bearer ${CONFIG.supabaseKey}`
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP connection failed with status ${response.status}`);
      }

      testResults.tests.connection.success = true;
      log('Database connection successful');
      return true;
    } catch (error) {
      testResults.tests.connection.error = error.message;
      testResults.errors.push({
        test: 'connection',
        error: error.message,
      });
      log(`Database connection failed: ${error.message}`, 'error');
      return false;
    }
  },

  // Test table existence and structure
  async testTableStructure() {
    log(`Testing '${CONFIG.tableName}' table structure...`);
    testResults.tests.tableStructure = { success: false };

    try {
      // Try to get one record to check table structure
      const { data, error } = await supabase
        .from(CONFIG.tableName)
        .select('*')
        .limit(1);

      if (error) {
        throw new Error(`Table structure query failed: ${error.message}`);
      }

      const columns = data && data.length > 0 
        ? Object.keys(data[0]) 
        : [];

      log(`Table exists with ${columns.length} columns`);
      testResults.tests.tableStructure.success = true;
      testResults.tests.tableStructure.columns = columns;

      // Check for required columns
      const requiredColumns = [
        'id', 'event_type', 'eviasignreference', 'event_id', 
        'processed', 'createdat', 'updatedat'
      ];

      const missingColumns = requiredColumns.filter(col => !columns.includes(col));
      
      if (missingColumns.length > 0) {
        log(`Missing required columns: ${missingColumns.join(', ')}`, 'warn');
        testResults.tests.tableStructure.missingColumns = missingColumns;
        return false;
      }

      return true;
    } catch (error) {
      testResults.tests.tableStructure.error = error.message;
      testResults.errors.push({
        test: 'tableStructure',
        error: error.message,
      });
      log(`Table structure test failed: ${error.message}`, 'error');
      return false;
    }
  },

  // Test record insertion
  async testInsert() {
    log('Testing record insertion...');
    testResults.tests.insert = { success: false };

    try {
      // Create test record
      const testRecord = {
        event_type: 'TestEvent',
        eviasignreference: TEST_UUID,
        user_name: 'Test User',
        user_email: 'test@example.com',
        subject: 'Database Test',
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

      // Insert via direct HTTP
      const response = await fetch(
        `${CONFIG.supabaseUrl}/rest/v1/${CONFIG.tableName}`,
        {
          method: 'POST',
          headers: {
            'apikey': CONFIG.supabaseKey,
            'Authorization': `Bearer ${CONFIG.supabaseKey}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation'
          },
          body: JSON.stringify(testRecord)
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP insert failed (${response.status}): ${errorText}`);
      }

      const data = await response.json();
      const insertedId = data[0]?.id;

      log(`Record inserted successfully with ID: ${insertedId}`);
      testResults.tests.insert.success = true;
      testResults.tests.insert.recordId = insertedId;
      testResults.tests.insert.uuid = TEST_UUID;

      return insertedId;
    } catch (error) {
      testResults.tests.insert.error = error.message;
      testResults.errors.push({
        test: 'insert',
        error: error.message,
      });
      log(`Record insertion failed: ${error.message}`, 'error');
      
      // Try Supabase client as fallback
      try {
        log('Trying insertion with Supabase client as fallback...');
        
        const testRecord = {
          event_type: 'TestEvent',
          eviasignreference: TEST_UUID,
          user_name: 'Test User',
          user_email: 'test@example.com',
          subject: 'Database Test',
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
        
        const { data, error } = await supabase
          .from(CONFIG.tableName)
          .insert([testRecord])
          .select();
          
        if (error) {
          throw new Error(`Supabase client insert failed: ${error.message}`);
        }
        
        const insertedId = data[0]?.id;
        log(`Record inserted successfully via client with ID: ${insertedId}`);
        testResults.tests.insert.success = true;
        testResults.tests.insert.recordId = insertedId;
        testResults.tests.insert.uuid = TEST_UUID;
        
        return insertedId;
      } catch (fallbackError) {
        log(`Fallback insertion also failed: ${fallbackError.message}`, 'error');
        return null;
      }
    }
  },

  // Test record retrieval
  async testRetrieval() {
    log('Testing record retrieval...');
    testResults.tests.retrieval = { success: false };

    try {
      // Query by UUID
      const { data, error } = await supabase
        .from(CONFIG.tableName)
        .select('*')
        .eq('eviasignreference', TEST_UUID)
        .limit(1);

      if (error) {
        throw new Error(`Record retrieval failed: ${error.message}`);
      }

      if (!data || data.length === 0) {
        throw new Error('Test record not found');
      }

      log(`Record retrieved successfully with ID: ${data[0].id}`);
      testResults.tests.retrieval.success = true;
      testResults.tests.retrieval.record = data[0];

      return data[0];
    } catch (error) {
      testResults.tests.retrieval.error = error.message;
      testResults.errors.push({
        test: 'retrieval',
        error: error.message,
      });
      log(`Record retrieval failed: ${error.message}`, 'error');
      return null;
    }
  },

  // Test record update
  async testUpdate() {
    log('Testing record update...');
    testResults.tests.update = { success: false };

    try {
      // Get the record first
      const { data, error } = await supabase
        .from(CONFIG.tableName)
        .select('id')
        .eq('eviasignreference', TEST_UUID)
        .limit(1);

      if (error || !data || data.length === 0) {
        throw new Error('Cannot find test record for update');
      }

      const recordId = data[0].id;

      // Update the record
      const updateData = {
        processed: true,
        updatedat: new Date().toISOString()
      };

      const response = await fetch(
        `${CONFIG.supabaseUrl}/rest/v1/${CONFIG.tableName}?id=eq.${encodeURIComponent(recordId)}`,
        {
          method: 'PATCH',
          headers: {
            'apikey': CONFIG.supabaseKey,
            'Authorization': `Bearer ${CONFIG.supabaseKey}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify(updateData)
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP update failed (${response.status}): ${errorText}`);
      }

      log(`Record updated successfully`);
      testResults.tests.update.success = true;

      return true;
    } catch (error) {
      testResults.tests.update.error = error.message;
      testResults.errors.push({
        test: 'update',
        error: error.message,
      });
      log(`Record update failed: ${error.message}`, 'error');
      return false;
    }
  },

  // Test record deletion (cleanup)
  async testCleanup() {
    log('Cleaning up test records...');
    testResults.tests.cleanup = { success: false };

    try {
      const { error } = await supabase
        .from(CONFIG.tableName)
        .delete()
        .eq('eviasignreference', TEST_UUID);

      if (error) {
        throw new Error(`Cleanup failed: ${error.message}`);
      }

      log('Test records cleaned up successfully');
      testResults.tests.cleanup.success = true;

      return true;
    } catch (error) {
      testResults.tests.cleanup.error = error.message;
      testResults.errors.push({
        test: 'cleanup',
        error: error.message,
      });
      log(`Cleanup failed: ${error.message}`, 'warn');
      return false;
    }
  }
};

// Run all tests
async function runTests() {
  log('\n=== WEBHOOK DATABASE TEST SUITE ===\n');
  
  if (!CONFIG.supabaseUrl || !CONFIG.supabaseKey) {
    log('Missing Supabase credentials. Check your .env file.', 'error');
    testResults.errors.push({
      test: 'setup',
      error: 'Missing Supabase credentials',
    });
    return false;
  }

  try {
    // Chain tests sequentially
    await tests.testConnection();
    await tests.testTableStructure();
    const insertedId = await tests.testInsert();
    
    // Only run these if insertion succeeded
    if (insertedId) {
      await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for processing
      await tests.testRetrieval();
      await tests.testUpdate();
      await tests.testCleanup();
    }
    
    // Determine overall success
    const allTests = Object.values(testResults.tests);
    const failedTests = allTests.filter(test => !test.success);
    
    testResults.success = failedTests.length === 0;
    
    return testResults.success;
  } catch (error) {
    log(`Test suite failed: ${error.message}`, 'error');
    testResults.errors.push({
      test: 'suite',
      error: error.message,
    });
    return false;
  } finally {
    // Save test results
    fs.writeFileSync(
      CONFIG.outputFile, 
      JSON.stringify(testResults, null, 2)
    );
    
    log(`\nTest results saved to ${CONFIG.outputFile}`);
    
    // Print summary
    log('\n=== TEST SUMMARY ===');
    for (const [name, result] of Object.entries(testResults.tests)) {
      const status = result.success ? 'PASSED' : 'FAILED';
      log(`${name}: ${status}`);
    }
    
    log(`\nOverall result: ${testResults.success ? 'SUCCESS' : 'FAILURE'}`);
    
    if (testResults.errors.length > 0) {
      log('\nErrors:');
      testResults.errors.forEach((err, i) => {
        log(`${i+1}. ${err.test}: ${err.error}`, 'error');
      });
    }
    
    log('\n=== TEST COMPLETE ===\n');
  }
}

// Run the tests
runTests().catch(error => {
  log(`Unhandled error: ${error.message}`, 'error');
}); 