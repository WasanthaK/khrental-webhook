import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';

// Load environment variables
dotenv.config();

// Set up file paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOGS_PATH = path.join(__dirname, '..', 'data', 'verification-logs.txt');

// Ensure logs directory exists
const LOGS_DIR = path.dirname(LOGS_PATH);
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

// Helper function to log
const log = (message) => {
  try {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${message}\n`;
    fs.appendFileSync(LOGS_PATH, logEntry);
    console.log(message);
  } catch (err) {
    console.error('Error writing to log:', err);
  }
};

// Check for required environment variables
const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;

if (!SUPABASE_URL) {
  log('❌ ERROR: SUPABASE_URL environment variable is not set');
  process.exit(1);
}

if (!SUPABASE_SERVICE_KEY) {
  log('❌ ERROR: SUPABASE_SERVICE_KEY environment variable is not set');
  process.exit(1);
}

// Create Supabase client
let supabase = null;

try {
  log('🔄 Initializing Supabase client...');
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });
  log('✅ Supabase client initialized successfully');
} catch (error) {
  log(`❌ Failed to initialize Supabase client: ${error.message}`);
  process.exit(1);
}

// Main verification function
async function verifyDatabaseFlow() {
  log('\n🔍 Starting database flow verification...');
  
  // Step 1: Check if tables exist
  log('\n1️⃣ Checking if required tables exist...');
  
  try {
    // Check webhook_events table
    const { data: webhookEvents, error: webhookError } = await supabase
      .from('webhook_events')
      .select('*')
      .limit(1);
    
    if (webhookError) {
      log(`❌ Error accessing webhook_events table: ${webhookError.message}`);
      if (webhookError.message.includes('does not exist')) {
        log('❌ webhook_events table does not exist in the database');
      }
    } else {
      log('✅ webhook_events table exists and is accessible');
      if (webhookEvents && webhookEvents.length > 0) {
        const columns = Object.keys(webhookEvents[0]);
        log(`✅ webhook_events table has columns: ${columns.join(', ')}`);
        
        // Check for required columns
        const requiredColumns = ['id', 'event_type', 'request_id', 'event_id', 'processed'];
        const missingColumns = requiredColumns.filter(col => !columns.includes(col));
        if (missingColumns.length > 0) {
          log(`⚠️ Missing required columns in webhook_events table: ${missingColumns.join(', ')}`);
        } else {
          log('✅ All required columns exist in webhook_events table');
        }
      } else {
        log('ℹ️ webhook_events table exists but is empty');
      }
    }
    
    // Check agreements table
    const { data: agreements, error: agreementsError } = await supabase
      .from('agreements')
      .select('*')
      .limit(1);
    
    if (agreementsError) {
      log(`❌ Error accessing agreements table: ${agreementsError.message}`);
      if (agreementsError.message.includes('does not exist')) {
        log('❌ agreements table does not exist in the database');
      }
    } else {
      log('✅ agreements table exists and is accessible');
      if (agreements && agreements.length > 0) {
        const columns = Object.keys(agreements[0]);
        log(`✅ agreements table has columns: ${columns.join(', ')}`);
        
        // Check for required columns
        const requiredColumns = ['id', 'eviasignreference', 'status', 'signature_status'];
        const missingColumns = requiredColumns.filter(col => !columns.includes(col));
        if (missingColumns.length > 0) {
          log(`⚠️ Missing recommended columns in agreements table: ${missingColumns.join(', ')}`);
        } else {
          log('✅ All recommended columns exist in agreements table');
        }
      } else {
        log('ℹ️ agreements table exists but is empty');
      }
    }
  } catch (error) {
    log(`❌ Error checking tables: ${error.message}`);
  }
  
  // Step 2: Test permission to insert and update webhook_events
  log('\n2️⃣ Testing permissions for webhook_events table...');
  
  try {
    // Create a test event
    const testEventData = {
      event_type: 'verification_test',
      request_id: `test_${Date.now()}`,
      event_id: 9999,
      processed: false,
      event_time: new Date().toISOString()
    };
    
    log('🔄 Inserting test event into webhook_events table...');
    const { data: insertData, error: insertError } = await supabase
      .from('webhook_events')
      .insert(testEventData)
      .select();
    
    if (insertError) {
      log(`❌ Failed to insert test event: ${insertError.message}`);
    } else {
      log('✅ Successfully inserted test event');
      
      // Test updating the event
      const testEventId = insertData[0].id;
      log(`🔄 Updating test event with ID ${testEventId}...`);
      
      const { error: updateError } = await supabase
        .from('webhook_events')
        .update({ processed: true })
        .eq('id', testEventId);
      
      if (updateError) {
        log(`❌ Failed to update test event: ${updateError.message}`);
      } else {
        log('✅ Successfully updated test event');
      }
      
      // Clean up the test event
      log('🔄 Cleaning up test event...');
      const { error: deleteError } = await supabase
        .from('webhook_events')
        .delete()
        .eq('id', testEventId);
      
      if (deleteError) {
        log(`⚠️ Failed to delete test event: ${deleteError.message}`);
      } else {
        log('✅ Successfully cleaned up test event');
      }
    }
  } catch (error) {
    log(`❌ Error testing webhook_events permissions: ${error.message}`);
  }
  
  // Step 3: Test permission to insert and update agreements
  log('\n3️⃣ Testing permissions for agreements table...');
  let testAgreementId = null;
  
  try {
    // First check if we can create a test agreement
    log('🔄 Checking if we can create a test agreement...');
    
    const testAgreementData = {
      status: 'pending',
      signature_status: 'pending_signature',
      eviasignreference: `test_${Date.now()}`,
      eviasignreference_uuid: null
    };
    
    const { data: agreementData, error: agreementError } = await supabase
      .from('agreements')
      .insert(testAgreementData)
      .select();
    
    if (agreementError) {
      log(`⚠️ Unable to create test agreement: ${agreementError.message}`);
      log('ℹ️ This is normal if using service role without insert permissions on agreements');
      log('ℹ️ Will try to update an existing agreement instead');
      
      // Try to find an existing agreement to test with
      const { data: existingAgreements, error: findError } = await supabase
        .from('agreements')
        .select('id')
        .is('eviasignreference', null)
        .limit(1);
      
      if (findError) {
        log(`❌ Failed to find existing agreement: ${findError.message}`);
      } else if (existingAgreements && existingAgreements.length > 0) {
        testAgreementId = existingAgreements[0].id;
        log(`✅ Found existing agreement to test with: ${testAgreementId}`);
      } else {
        log('❌ No suitable agreements found for testing');
      }
    } else {
      testAgreementId = agreementData[0].id;
      log(`✅ Successfully created test agreement with ID: ${testAgreementId}`);
    }
    
    // If we have an agreement ID, test updating it
    if (testAgreementId) {
      log(`🔄 Testing update on agreement ${testAgreementId}...`);
      
      // Test with a UUID format string
      const testUuid = '12345678-1234-1234-1234-123456789012';
      
      const { error: updateError } = await supabase
        .from('agreements')
        .update({ 
          eviasignreference: testUuid,
          signature_status: 'pending_signature'
        })
        .eq('id', testAgreementId);
      
      if (updateError) {
        log(`❌ Failed to update agreement: ${updateError.message}`);
      } else {
        log('✅ Successfully updated agreement');
        
        // Check if update was actually applied
        const { data: verifyData, error: verifyError } = await supabase
          .from('agreements')
          .select('eviasignreference, signature_status')
          .eq('id', testAgreementId)
          .single();
        
        if (verifyError) {
          log(`❌ Failed to verify agreement update: ${verifyError.message}`);
        } else if (verifyData.eviasignreference === testUuid) {
          log('✅ Confirmed agreement was properly updated');
        } else {
          log(`⚠️ Agreement update may not have been applied correctly. Expected: ${testUuid}, Got: ${verifyData.eviasignreference}`);
        }
        
        // Reset the test value
        const { error: resetError } = await supabase
          .from('agreements')
          .update({ 
            eviasignreference: null
          })
          .eq('id', testAgreementId);
        
        if (resetError) {
          log(`⚠️ Failed to reset test agreement: ${resetError.message}`);
        } else {
          log('✅ Successfully reset test agreement');
        }
      }
    }
  } catch (error) {
    log(`❌ Error testing agreements permissions: ${error.message}`);
  }
  
  // Step 4: Simulate the webhook flow
  log('\n4️⃣ Simulating webhook flow...');
  
  try {
    if (testAgreementId) {
      // Step 1: Create a test webhook event
      const testRequestId = `test_flow_${Date.now()}`;
      log(`🔄 Updating agreement ${testAgreementId} with test RequestId ${testRequestId}...`);
      
      // Update the agreement with our test RequestId
      const { error: prepError } = await supabase
        .from('agreements')
        .update({ 
          eviasignreference: testRequestId,
          status: 'pending',
          signature_status: 'pending_signature'
        })
        .eq('id', testAgreementId);
      
      if (prepError) {
        log(`❌ Failed to prepare agreement for test: ${prepError.message}`);
      } else {
        log('✅ Successfully prepared agreement for test');
        
        // Step 2: Create a test webhook event
        log('🔄 Creating test webhook event...');
        const testEventData = {
          event_type: 'SignatoryCompleted',
          request_id: testRequestId,
          event_id: 2, // Signatory completed
          processed: false,
          event_time: new Date().toISOString()
        };
        
        const { data: eventData, error: eventError } = await supabase
          .from('webhook_events')
          .insert(testEventData)
          .select();
        
        if (eventError) {
          log(`❌ Failed to create test webhook event: ${eventError.message}`);
        } else {
          const testEventId = eventData[0].id;
          log(`✅ Successfully created test webhook event with ID: ${testEventId}`);
          
          // Step 3: Simulate processing the agreement
          log('🔄 Simulating agreement update...');
          
          const { error: updateError } = await supabase
            .from('agreements')
            .update({ 
              signature_status: 'partially_signed',
              updatedat: new Date().toISOString()
            })
            .eq('id', testAgreementId);
          
          if (updateError) {
            log(`❌ Failed to update agreement status: ${updateError.message}`);
          } else {
            log('✅ Successfully updated agreement status');
            
            // Step 4: Mark webhook event as processed
            log('🔄 Marking webhook event as processed...');
            
            const { error: markError } = await supabase
              .from('webhook_events')
              .update({ 
                processed: true
              })
              .eq('id', testEventId);
            
            if (markError) {
              log(`❌ Failed to mark webhook event as processed: ${markError.message}`);
            } else {
              log('✅ Successfully marked webhook event as processed');
              
              // Clean up the test event
              log('🔄 Cleaning up test event...');
              const { error: deleteError } = await supabase
                .from('webhook_events')
                .delete()
                .eq('id', testEventId);
              
              if (deleteError) {
                log(`⚠️ Failed to delete test event: ${deleteError.message}`);
              } else {
                log('✅ Successfully cleaned up test event');
              }
              
              // Reset the agreement
              log('🔄 Resetting agreement...');
              const { error: resetError } = await supabase
                .from('agreements')
                .update({ 
                  eviasignreference: null,
                  signature_status: 'pending_signature'
                })
                .eq('id', testAgreementId);
              
              if (resetError) {
                log(`⚠️ Failed to reset agreement: ${resetError.message}`);
              } else {
                log('✅ Successfully reset agreement');
              }
            }
          }
        }
      }
    } else {
      log('⚠️ Cannot simulate webhook flow without a test agreement');
    }
  } catch (error) {
    log(`❌ Error simulating webhook flow: ${error.message}`);
  }
  
  // Final summary
  log('\n✅ Database flow verification completed.');
  log('Check the logs above for any issues that need to be addressed.');
  log(`A detailed log has been saved to: ${LOGS_PATH}`);
}

// Run the verification
verifyDatabaseFlow()
  .catch(error => {
    log(`❌ Unhandled error in verification script: ${error.message}`);
    process.exit(1);
  })
  .finally(() => {
    log('Verification script completed');
  });

/**
 * Test function to verify we can create a new agreement
 */
async function testCreateAgreement() {
  try {
    const templateId = await getRandomTemplateId();
    
    if (!templateId) {
      log("❌ No template found to create agreement with");
      return null;
    }
    
    const agreement = {
      templateid: templateId,
      renteeid: uuidv4(),
      propertyid: uuidv4(),
      status: "draft",
      startdate: new Date(),
      enddate: new Date(Date.now() + 86400000 * 365), // 1 year from now
      eviasignreference: uuidv4(), // Use eviasignreference instead of eviasignreference_uuid
      createdat: new Date(),
      updatedat: new Date()
    };
    
    const { data, error } = await supabase
      .from('agreements')
      .insert(agreement)
      .select('id')
      .single();
      
    if (error) {
      log(`❌ Error creating test agreement: ${error.message}`);
      return null;
    }
    
    return data.id;
  } catch (err) {
    log(`❌ Exception in testCreateAgreement: ${err.message}`);
    return null;
  }
}

/**
 * Test function to insert a webhook event
 */
async function testInsertWebhookEvent() {
  try {
    // Create a webhook event with the right structure
    const webhookEvent = {
      event_type: "SignatoryCompleted",
      request_id: uuidv4(),
      user_name: "Test User",
      user_email: "test@example.com",
      subject: "Test Agreement",
      event_id: 2,
      event_time: new Date(),
      raw_data: { test: "data" },
      processed: false,
      createdat: new Date(),
      updatedat: new Date()
    };
    
    // Try inserting using our service first
    try {
      const createdEvent = await insertWebhookEvent(webhookEvent);
      if (createdEvent && createdEvent.id) {
        return createdEvent.id;
      }
    } catch (err) {
      log(`❌ Service insert error: ${err.message}`);
    }
    
    // As a fallback, try direct insertion
    const { data, error } = await supabase
      .from('webhook_events')
      .insert(webhookEvent)
      .select('id')
      .single();
    
    if (error) {
      log(`❌ Direct insert error: ${error.message}`);
      return null;
    }
    
    return data.id;
  } catch (err) {
    log(`❌ Exception in testInsertWebhookEvent: ${err.message}`);
    return null;
  }
} 