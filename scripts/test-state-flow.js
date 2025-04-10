#!/usr/bin/env node

/**
 * This script tests the enhanced agreement state flow by simulating the webhook events
 * from different stages of the signature process.
 */

import { createClient } from '@supabase/supabase-js';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env') });

// Set up Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL || 'http://localhost:54321',
  process.env.SUPABASE_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'
);

// Import the signature webhook service
import { processSignatureEvent } from '../services/signatureWebhookService.js';

// Log agreement lifecycle activity
function logAgreementLifecycle(message) {
  console.log(`[AGREEMENT] ${message}`);
}

// Create a log writer
const logFile = path.resolve(__dirname, '../data/state-flow-test.log');
fs.writeFileSync(logFile, `State Flow Test - Started at ${new Date().toISOString()}\n\n`);

const appendLog = (message) => {
  console.log(message);
  fs.appendFileSync(logFile, message + '\n');
};

// Generate test IDs
const testAgreementId = uuidv4();
const testRequestId = uuidv4();

// Define the test events
const events = [
  {
    EventId: 1,
    EventDescription: 'SignRequestReceived',
    RequestId: testRequestId,
    UserName: 'Test User',
    Email: 'test@example.com',
    Subject: 'Test Agreement',
    EventTime: new Date().toISOString()
  },
  {
    EventId: 2,
    EventDescription: 'SignatoryCompleted',
    RequestId: testRequestId,
    UserName: 'John Landlord',
    Email: 'landlord@example.com',
    Subject: 'Test Agreement',
    SignatoryReference: 'landlord-ref-123',
    SignatoryType: 'landlord',
    EventTime: new Date(Date.now() + 1000 * 60).toISOString() // 1 minute later
  },
  {
    EventId: 2,
    EventDescription: 'SignatoryCompleted',
    RequestId: testRequestId,
    UserName: 'Jane Tenant',
    Email: 'tenant@example.com',
    Subject: 'Test Agreement',
    SignatoryReference: 'tenant-ref-456',
    SignatoryType: 'tenant',
    EventTime: new Date(Date.now() + 1000 * 60 * 2).toISOString() // 2 minutes later
  },
  {
    EventId: 3,
    EventDescription: 'RequestCompleted',
    RequestId: testRequestId,
    UserName: 'Admin User',
    Email: 'admin@example.com',
    Subject: 'Test Agreement',
    DocumentURL: 'https://test-document-url.com/signed-agreement.pdf',
    EventTime: new Date(Date.now() + 1000 * 60 * 3).toISOString() // 3 minutes later
  }
];

/**
 * Create a test agreement to use for the flow
 */
async function createTestAgreement() {
  appendLog('Creating test agreement...');

  // Create property first
  const { data: propertyData, error: propertyError } = await supabase
    .from('properties')
    .insert({
      name: 'Test Property',
      address: '123 Test Street, Test City, 12345',
      status: 'active',
      createdat: new Date().toISOString(),
      updatedat: new Date().toISOString()
    })
    .select();

  if (propertyError) {
    appendLog(`Error creating test property: ${propertyError.message}`);
    throw propertyError;
  }

  const propertyId = propertyData[0].id;
  appendLog(`Test property created with ID: ${propertyId}`);

  // Create agreement with the property reference
  const { data, error } = await supabase
    .from('agreements')
    .insert({
      id: testAgreementId,
      status: 'created',
      signature_status: 'pending_signature',
      eviasignreference: testRequestId,
      createdat: new Date().toISOString(),
      updatedat: new Date().toISOString(),
      propertyid: propertyId,
      notes: 'Test agreement for state flow verification',
      signatories_status: JSON.stringify([
        {
          email: 'landlord@example.com',
          name: 'John Landlord',
          type: 'landlord',
          status: 'pending',
          reference: 'landlord-ref-123'
        },
        {
          email: 'tenant@example.com',
          name: 'Jane Tenant',
          type: 'tenant',
          status: 'pending',
          reference: 'tenant-ref-456'
        }
      ])
    })
    .select();

  if (error) {
    appendLog(`Error creating test agreement: ${error.message}`);
    throw error;
  }

  appendLog(`Test agreement created with ID: ${testAgreementId}`);
  appendLog(`RequestId (eviasignreference): ${testRequestId}`);
  return data[0];
}

/**
 * Process each event in sequence and show the state transitions
 */
async function processEvents() {
  appendLog('\nProcessing events in sequence:');

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    appendLog(`\n[${i + 1}/${events.length}] Processing ${event.EventDescription} event...`);
    
    // Process the event
    const result = await processSignatureEvent(event);
    
    // Check if successful
    if (!result.success) {
      appendLog(`❌ Event processing failed: ${result.error}`);
      appendLog(`Details: ${JSON.stringify(result.details, null, 2)}`);
      continue;
    }
    
    // Log the updated agreement state
    appendLog('✅ Event processed successfully');
    appendLog(`   Agreement Status: ${result.agreement.status}`);
    appendLog(`   Signature Status: ${result.agreement.signature_status}`);
    
    // Verify the signatories status
    if (result.agreement.signatories_status) {
      let signatoryStatus = '';
      try {
        const signatories = typeof result.agreement.signatories_status === 'string' 
          ? JSON.parse(result.agreement.signatories_status)
          : result.agreement.signatories_status;
        
        signatoryStatus = signatories.map(sig => 
          `${sig.name} (${sig.type}): ${sig.status}`
        ).join(', ');
      } catch (e) {
        signatoryStatus = 'Error parsing signatories: ' + e.message;
      }
      appendLog(`   Signatories: ${signatoryStatus}`);
    }

    // For the final event, verify that the document URL is updated
    if (event.EventId === 3) {
      if (result.agreement.signed_document_url) {
        appendLog(`   Signed Document URL: ${result.agreement.signed_document_url}`);
      } else {
        appendLog(`❌ No signed document URL found in the agreement`);
      }
    }

    // Wait a short time between events
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

/**
 * Verify test expectations
 */
async function verifyResults() {
  appendLog('\nVerifying final results...');
  
  // Get the final agreement state
  const { data, error } = await supabase
    .from('agreements')
    .select('*')
    .eq('id', testAgreementId)
    .single();
  
  if (error) {
    appendLog(`❌ Error retrieving final agreement state: ${error.message}`);
    return false;
  }
  
  // Verify status
  if (data.status !== 'completed') {
    appendLog(`❌ Expected agreement status to be 'completed', got '${data.status}'`);
    return false;
  }
  
  // Verify signature status
  if (data.signature_status !== 'signed') {
    appendLog(`❌ Expected signature status to be 'signed', got '${data.signature_status}'`);
    return false;
  }
  
  // Verify signatories
  try {
    const signatories = typeof data.signatories_status === 'string' 
      ? JSON.parse(data.signatories_status)
      : data.signatories_status;
    
    const allSigned = signatories.every(sig => sig.status === 'completed');
    if (!allSigned) {
      appendLog(`❌ Expected all signatories to be 'completed', but found incomplete ones`);
      return false;
    }
    
    appendLog('✅ All signatories are marked as completed');
  } catch (e) {
    appendLog(`❌ Error parsing signatories: ${e.message}`);
    return false;
  }
  
  // Verify document URL
  if (!data.signed_document_url) {
    appendLog(`❌ Expected signed_document_url to be set`);
    return false;
  }
  
  appendLog('✅ Signed document URL is set correctly');
  return true;
}

/**
 * Clean up the test data
 */
async function cleanupTestData() {
  appendLog('\nCleaning up test data...');
  
  // Delete the test agreement
  const { error: deleteError } = await supabase
    .from('agreements')
    .delete()
    .eq('id', testAgreementId);
  
  if (deleteError) {
    appendLog(`Error deleting test agreement: ${deleteError.message}`);
  } else {
    appendLog('Test agreement deleted successfully');
  }
  
  // Get the property ID from the agreement before deleting
  const { data: agreementData } = await supabase
    .from('agreements')
    .select('propertyid')
    .eq('id', testAgreementId)
    .single();
  
  if (agreementData && agreementData.propertyid) {
    // Delete the test property
    const { error: propertyDeleteError } = await supabase
      .from('properties')
      .delete()
      .eq('id', agreementData.propertyid);
    
    if (propertyDeleteError) {
      appendLog(`Error deleting test property: ${propertyDeleteError.message}`);
    } else {
      appendLog('Test property deleted successfully');
    }
  }
}

/**
 * Main function to run the test
 */
async function runTest() {
  try {
    // Create the test agreement
    const testAgreement = await createTestAgreement();
    
    // Process all the events
    await processEvents();
    
    // Verify the results
    const success = await verifyResults();
    
    // Clean up (optional - can comment out to keep test data for inspection)
    await cleanupTestData();
    
    if (success) {
      appendLog('\n✅ State flow test completed successfully');
    } else {
      appendLog('\n❌ State flow test failed: Results verification failed');
    }
  } catch (error) {
    appendLog(`\n❌ State flow test failed: ${error.message}`);
    console.error(error);
  }
}

// Execute the test
runTest().catch(error => {
  console.error('Unhandled error:', error);
  process.exit(1);
}); 