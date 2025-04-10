// Test script for agreement lookup without relying on UUIDs
import dotenv from 'dotenv';
import { findAgreementByEviaReference, logSignatureActivity } from '../services/signatureWebhookService.js';
import supabase from '../services/supabaseClient.js';

// Load environment variables
dotenv.config();

/**
 * Run tests for agreement lookup
 */
async function runTests() {
  console.log('🔍 Testing agreement lookup without UUID fields');
  console.log('===============================================');

  // First, get a sample agreement reference
  const { data: sampleAgreements, error: sampleError } = await supabase
    .from('agreements')
    .select('id, eviasignreference, status')
    .not('eviasignreference', 'is', null)
    .limit(5);

  if (sampleError) {
    console.error('Error fetching sample agreements:', sampleError.message);
    return;
  }

  if (!sampleAgreements || sampleAgreements.length === 0) {
    console.log('No agreements found with eviasignreference set.');
    return;
  }

  console.log(`Found ${sampleAgreements.length} sample agreements for testing:`);
  console.table(sampleAgreements);

  // Test each agreement
  for (const agreement of sampleAgreements) {
    console.log(`\n🧪 Testing lookup for agreement ID ${agreement.id}`);
    console.log(`Reference: ${agreement.eviasignreference}`);
    
    // Test direct lookup
    console.log('\n1️⃣ Testing direct lookup with exact reference:');
    const directResult = await findAgreementByEviaReference(agreement.eviasignreference);
    
    if (directResult) {
      console.log('✅ Agreement found:', directResult.id);
    } else {
      console.log('❌ Agreement not found');
    }
    
    // Test partial lookup with first 8 chars
    if (agreement.eviasignreference && agreement.eviasignreference.length > 8) {
      const partialRef = agreement.eviasignreference.substring(0, 8);
      console.log(`\n2️⃣ Testing lookup with partial reference (${partialRef}):`);
      const partialResult = await findAgreementByEviaReference(partialRef);
      
      if (partialResult) {
        console.log('✅ Agreement found:', partialResult.id);
      } else {
        console.log('❌ Agreement not found');
      }
    }
  }
  
  console.log('\n✨ Tests completed');
}

// Run the tests
runTests()
  .then(() => {
    console.log('Script completed successfully');
    process.exit(0);
  })
  .catch(error => {
    console.error('Error running tests:', error);
    process.exit(1);
  }); 