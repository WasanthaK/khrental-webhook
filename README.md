# Webhook Server for KH Rentals

This is the webhook server responsible for handling Evia Sign webhook events for the KH Rentals application.

## Overview

The webhook server:
- Receives webhook events from Evia Sign
- Processes agreement signature status updates
- Stores webhook events in Supabase
- Updates agreement records in the database
- Downloads signed documents from Evia Sign

## Local Development

### Prerequisites

- Node.js 22
- Supabase project with proper tables
- Evia Sign account with webhook configuration

### Setup

1. Install dependencies:
   ```bash
   cd webhook-server
   npm install
   ```

2. Create a `.env` file in the webhook-server directory:
   ```
   PORT=3030
   SUPABASE_URL=https://your-supabase-project.supabase.co
   SUPABASE_SERVICE_KEY=your-supabase-service-key
   EVIA_SIGN_WEBHOOK_URL=http://localhost:3030/webhook/evia-sign
   ```

3. Start the server:
   ```bash
   npm start
   ```

## Azure Deployment

The webhook server is designed to be deployed to Azure App Service. The configuration is handled by GitHub Actions.

### Deployment Steps

1. Create an Azure App Service with Node.js 22 runtime
2. Configure the following App Settings in Azure:
   - `PORT`: 8080
   - `SUPABASE_URL`: Your Supabase URL
   - `SUPABASE_SERVICE_KEY`: Your Supabase service key 
   - `EVIA_SIGN_WEBHOOK_URL`: Your webhook endpoint URL

3. Set the startup command in Azure App Service:
   ```
   cd webhook-server && node server.js
   ```

### Environment Variables

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| PORT | Port to run the server on | No | 3030 |
| SUPABASE_URL | Supabase project URL | Yes | - |
| SUPABASE_SERVICE_KEY | Supabase service key | Yes | - |
| EVIA_SIGN_WEBHOOK_URL | Webhook endpoint URL | Yes | - |

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/webhook/evia-sign` | POST | Evia Sign webhook endpoint |
| `/webhook/eviasign` | POST | Alternate endpoint (no dash) |
| `/status` | GET | Server status endpoint |
| `/logs` | GET | View server logs |

## Testing Locally

1. Start the server:
   ```bash
   npm start
   ```

2. Use a tool like Postman or curl to send test webhook payloads:
   ```bash
   curl -X POST http://localhost:3030/webhook/evia-sign \
     -H "Content-Type: application/json" \
     -d '{"RequestId":"test-request-id","UserName":"Test User","Email":"test@example.com","Subject":"Test Subject","EventId":1,"EventDescription":"SignRequestReceived","EventTime":"2023-04-01T12:00:00Z"}'
   ```

3. Verify that events are processed by checking the Supabase database.

## Webhook Event Types

| EventId | Description | Action |
|---------|-------------|--------|
| 1 | SignRequestReceived | Updates agreement to pending status |
| 2 | SignatoryCompleted | Records signatory completion |
| 3 | RequestCompleted | Marks agreement as completed, downloads document |
| 5 | RequestRejected | Marks agreement as rejected |

## Architecture

The webhook server follows these steps when processing events:

1. Receive webhook payload from Evia Sign
2. Store the event locally for backup
3. Process the agreement update first
4. Store the event in Supabase
5. Mark the webhook event as processed

This ensures data consistency between webhook events and agreement records.

## Updated Database Flow

The webhook server has been improved to ensure that agreements are always updated **before** webhook events are stored and marked as processed in the database. This change addresses a critical issue where webhook events might be marked as processed before the corresponding agreement updates were completed.

### Why This Matters

The correct processing order is essential for maintaining data integrity:

1. **Data Consistency**: By updating agreements first, we ensure that the agreement status always reflects the most recent webhook event.

2. **Recovery and Debugging**: If a webhook event is marked as processed but the agreement update fails, it creates inconsistency between webhook events and agreements data.

3. **Idempotency**: If a webhook is retried, previously processed events might prevent necessary agreement updates.

### How We've Fixed It

The webhook server now follows this improved flow:

1. Receive and validate webhook payload
2. Store event locally for backup/debugging
3. Process the agreement update first
4. Only after successful agreement processing, store the event in Supabase
5. Mark the webhook event as processed only after both steps succeed

### Verifying the Database Flow

You can verify that the database flow is working correctly with:

```bash
npm run verify
```

This script checks:
- If both webhook_events and agreements tables exist
- If the tables have the required columns
- If the server has proper permissions to update both tables
- Simulates the webhook flow to ensure agreements are updated before events

If the verification script reports any issues, check the detailed logs in `data/verification-logs.txt`.

## Enhanced Agreement State Flow

The webhook server now implements a comprehensive state flow for agreements that tracks both the agreement lifecycle state and the signature process separately.

### Agreement Lifecycle States

The `status` field on agreements now reflects the overall lifecycle state:

- **created**: When the agreement is first recorded
- **pending_activation**: When the signing process begins (document sent for signature)
- **active**: When all required signatories have signed (signing complete)
- **rejected**: If any signatory rejects the agreement
- **expired**: When an agreement reaches its end date (set by scheduled process)
- **cancelled**: When an agreement is manually cancelled

### Signature Status Steps

The `signature_status` field tracks the detailed steps in the signature process:

- **pending_signature**: Initial status before any signatures
- **send_for_signature**: The document has been sent to signatories
- **signed_by_{name}**: Dynamic status with actual signatory name (e.g., "signed_by_John_Smith")
- **signed**: All required signatories have signed
- **rejected**: A signatory has rejected the agreement

### Webhook Event Mapping

The server maps incoming webhook events from Evia Sign to both agreement states and signature statuses:

| Event ID | Description | Agreement State | Signature Status |
|----------|-------------|-----------------|------------------|
| 1 | SignRequestReceived | pending_activation | send_for_signature |
| 2 | SignatoryCompleted | pending_activation | signed_by_{signatory name} |
| 3 | RequestCompleted | active | signed |
| 5 | RequestRejected | rejected | rejected |

The system now uses the actual name of the signatory from `webhookData.UserName` for the `signature_status` field, replacing spaces with underscores for consistency.

### Signatory Tracking

Signatories are now tracked in the `signatories_status` JSON array field on the agreement record:

```json
[
  {
    "email": "john@example.com",
    "name": "John Smith",
    "type": "landlord",
    "status": "completed",
    "reference": "sig-ref-123"
  },
  {
    "email": "tenant@example.com",
    "name": "Jane Doe",
    "type": "tenant", 
    "status": "pending",
    "reference": "sig-ref-456"
  }
]
```

This detailed tracking allows the UI to show the exact status of each signatory and improves the user experience with personalized status messages.

### Document Storage

When an agreement is fully signed (EventId 3 - RequestCompleted), the webhook server:

1. Downloads the signed document from the provider
2. Stores it in Supabase Storage in the `agreements` bucket
3. Updates the agreement record with:
   - `signed_document_url`: Public URL for the document
   - `pdfurl`: Alternative reference to the document URL
   - `document_storage_path`: Internal storage path

### Testing the State Flow

You can test the state flow functionality with:

```bash
node scripts/test-state-flow.js
```

This script will:
1. Create a test agreement with test signatories
2. Simulate each webhook event in sequence
3. Verify the correct status and signatory updates for each event
4. Validate document storage for completed agreements
5. Clean up test data automatically

The test results are logged to `data/state-flow-test.log` for review.

### Handling UI Updates

The UI components have been updated to:
1. Show personalized signature statuses with actual names
2. Provide document download links for signed agreements
3. Enable agreement cancellation for pending agreements
4. Improve signatory display in the signature progress tracker

### Benefits of the Dual-State Tracking

This enhanced approach provides several advantages:

1. **Clear Status Separation**: Keeps agreement lifecycle state separate from the signature process state
2. **Detailed Audit Trail**: Provides more granular tracking of who signed and when
3. **Better User Experience**: Enables more specific UI feedback about the signing progress
4. **Future-Proof**: Easier to extend for additional states or events in the future

### Testing the State Flow

You can test the state flow functionality with:

```bash
npm run test:stateflow
```

This will simulate the complete signing flow from creation to completion. # khrental-webhook
