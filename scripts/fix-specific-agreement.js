// Script to fix and test the specific agreement with UUID 8944dac9-5830-41f3-9edb-8facfeb10a8f
// Updated to work with eviasignreference field directly, not using eviasignreference_uuid

import dotenv from 'dotenv';
import { processSignatureEvent, logSignatureActivity } from '../services/signatureWebhookService.js';
import supabase from '../services/supabaseClient.js';

// Load environment variables
dotenv.config();

const AGREEMENT_ID = '8944dac9-5830-41f3-9edb-8facfeb10a8f';

/**
 * Find agreement by ID
 * @param {string} agreementId - The agreement ID
 * @returns {Promise<Object>} - The agreement object or null if not found
 */
async function findAgreementById(agreementId) {
  console.log(`Looking for agreement with ID: ${agreementId}`);
  
  const { data, error } = await supabase
    .from('agreements')
    .select('*')
    .eq('id', agreementId)
    .single();
    
  if (error) {
    console.error('Error fetching agreement:', error.message);
    return null;
  }
  
  return data;
}

/**
 * Log agreement lifecycle activity
 * @param {string} message - The message to log
 */
function logAgreementLifecycle(message) {
  console.log(`[AGREEMENT] ${message}`);
}

/**
 * Find the latest webhook event for an agreement reference
 * @param {string} reference - The eviasignreference to search for
 */
async function findLatestWebhookEvent(reference) {
  console.log(`Looking for webhook events with RequestId: ${reference}`);

  const { data, error } = await supabase
    .from('webhook_events')
    .select('*')
    .eq('RequestId', reference)
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) {
    console.error('Error fetching webhook events:', error.message);
    return null;
  }

  if (!data || data.length === 0) {
    console.log('No webhook events found');
    return null;
  }

  console.log(`Found latest event: ${data[0].EventId} - ${data[0].EventDescription}`);
  return data[0];
}

/**
 * Fix and test the specific agreement
 */
async function fixSpecificAgreement() {
  console.log(`🔧 Fixing agreement: ${AGREEMENT_ID}`);

  // 1. Check if agreement exists
  const agreement = await findAgreementById(AGREEMENT_ID);
  if (!agreement) {
    console.error(`❌ Agreement not found with ID: ${AGREEMENT_ID}`);
    return;
  }

  console.log(`✅ Agreement found:`);
  console.log(`ID: ${agreement.id}`);
  console.log(`Status: ${agreement.status}`);
  console.log(`Signature Status: ${agreement.signature_status}`);
  console.log(`eviasignreference: ${agreement.eviasignreference}`);
  
  if (!agreement.eviasignreference) {
    console.error('❌ Agreement has no eviasignreference value');
    return;
  }

  // 2. Fetch the latest webhook event
  const latestEvent = await findLatestWebhookEvent(agreement.eviasignreference);
  if (!latestEvent) {
    console.error('❌ No webhook events found for this agreement');
    return;
  }

  // 3. Process the event to update the agreement
  console.log(`\n🔄 Processing latest webhook event to update agreement status...`);
  const result = await processSignatureEvent(latestEvent);
  
  if (result.success) {
    console.log(`✅ Agreement updated successfully`);
    console.log(`New status: ${result.agreement.status}`);
    console.log(`New signature status: ${result.agreement.signature_status}`);
  } else {
    console.error(`❌ Failed to update agreement: ${result.error}`);
    console.error(`Details:`, result.details);
  }

  // 4. Verify the update
  const updatedAgreement = await findAgreementById(AGREEMENT_ID);
  if (updatedAgreement) {
    console.log(`\n🔍 Verification:`);
    console.log(`Current Status: ${updatedAgreement.status}`);
    console.log(`Current Signature Status: ${updatedAgreement.signature_status}`);
    console.log(`Updated At: ${updatedAgreement.updatedat}`);
  }
}

// Run the fix
fixSpecificAgreement()
  .then(() => {
    console.log('\n✨ Script completed');
    process.exit(0);
  })
  .catch(error => {
    console.error('Error running script:', error);
    process.exit(1);
  }); 