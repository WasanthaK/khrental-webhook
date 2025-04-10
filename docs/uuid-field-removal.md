# UUID Field Removal Documentation

This document explains the changes made to the webhook server to remove the dependency on the `eviasignreference_uuid` field for agreement lookups.

## Background

Previously, the webhook server used a dual approach to find agreements:

1. It would look for agreements using the `eviasignreference_uuid` field if the webhook's `RequestId` was a valid UUID.
2. If no match was found, it would fall back to using the `eviasignreference` string field.

This approach created complexity and potential issues when the UUID field was not properly populated, leading to failed lookups even when the regular `eviasignreference` value existed in the database.

## Changes Made

We've simplified the agreement lookup process by:

1. Removing all code that attempts to update the `eviasignreference_uuid` field.
2. Modifying `findAgreementByEviaReference` to only use the `eviasignreference` field.
3. Implementing more robust partial matching for cases where only a portion of the reference ID matches.
4. Adding better logging throughout the lookup process.

### Key Files Modified

- `services/agreementService.js`:
  - Simplified `findAgreementByEviaReference()` to use only the `eviasignreference` field
  - Modified `updateAgreementStatus()` to stop updating the `eviasignreference_uuid` field
  - Updated `processAgreementEvent()` to remove the UUID-related logic

## Testing the Changes

### 1. Testing Agreement Lookup

The `test-agreement-lookup.js` script tests the modified lookup logic to ensure agreements can still be found:

```bash
cd webhook-server
npm run test:lookup
```

This script:
- Finds agreements with `eviasignreference` values in the database
- Tests lookup with exact reference value
- Tests lookup with partial reference value (first 8 characters)

### 2. Testing a Specific Agreement

The `fix-specific-agreement.js` script (customized for agreement ID `8944dac9-5830-41f3-9edb-8facfeb10a8f`) tests:

```bash
cd webhook-server
npm run fix:specific
```

This script:
- Finds the specified agreement in the database
- Looks up related webhook events
- Processes the latest event to update the agreement status
- Verifies that the update succeeded

## Verifying in Production

To verify these changes don't break anything in a production environment:

1. Deploy the updated code to a staging environment first
2. Monitor webhook processing logs for any errors
3. Check that new webhook events properly update their corresponding agreements
4. Verify that the removal of UUID-related code doesn't cause any regressions

## Reverting if Needed

If issues are encountered, you can revert to the previous approach by:

1. Re-adding the UUID validation and update logic to `agreementService.js`
2. Running the `fix:agreements` script to repopulate any missing UUID fields

## Conclusion

These changes simplify the agreement lookup process and make it more robust without relying on the additional UUID field. The update maintains backward compatibility with all existing agreements in the database. 