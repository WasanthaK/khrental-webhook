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


## database
| table_name                   | column_name               | data_type                   |
| ---------------------------- | ------------------------- | --------------------------- |
| action_records               | id                        | uuid                        |
| action_records               | propertyid                | uuid                        |
| action_records               | renteeid                  | uuid                        |
| action_records               | actiontype                | character varying           |
| action_records               | amount                    | numeric                     |
| action_records               | status                    | character varying           |
| action_records               | date                      | date                        |
| action_records               | comments                  | text                        |
| action_records               | relateddocs               | ARRAY                       |
| action_records               | createdat                 | timestamp with time zone    |
| action_records               | updatedat                 | timestamp with time zone    |
| agreement_templates          | id                        | uuid                        |
| agreement_templates          | language                  | character varying           |
| agreement_templates          | content                   | text                        |
| agreement_templates          | version                   | character varying           |
| agreement_templates          | createdat                 | timestamp with time zone    |
| agreement_templates          | updatedat                 | timestamp with time zone    |
| agreement_templates          | name                      | character varying           |
| agreements                   | id                        | uuid                        |
| agreements                   | templateid                | uuid                        |
| agreements                   | renteeid                  | uuid                        |
| agreements                   | propertyid                | uuid                        |
| agreements                   | status                    | character varying           |
| agreements                   | signeddate                | timestamp with time zone    |
| agreements                   | startdate                 | date                        |
| agreements                   | enddate                   | date                        |
| agreements                   | eviasignreference         | uuid                        |
| agreements                   | documenturl               | text                        |
| agreements                   | createdat                 | timestamp with time zone    |
| agreements                   | updatedat                 | timestamp with time zone    |
| agreements                   | terms                     | jsonb                       |
| agreements                   | notes                     | text                        |
| agreements                   | unitid                    | uuid                        |
| agreements                   | needs_document_generation | boolean                     |
| agreements                   | pdfurl                    | text                        |
| agreements                   | signatureurl              | text                        |
| agreements                   | signature_status          | text                        |
| agreements                   | signatories_status        | jsonb                       |
| agreements                   | signature_request_id      | text                        |
| agreements                   | signature_sent_at         | timestamp with time zone    |
| agreements                   | signature_completed_at    | timestamp with time zone    |
| agreements                   | signature_pdf_url         | text                        |
| agreements                   | signed_document_url       | text                        |
| agreements                   | processedcontent          | text                        |
| app_users                    | id                        | uuid                        |
| app_users                    | auth_id                   | uuid                        |
| app_users                    | email                     | character varying           |
| app_users                    | name                      | character varying           |
| app_users                    | role                      | character varying           |
| app_users                    | user_type                 | character varying           |
| app_users                    | contact_details           | jsonb                       |
| app_users                    | skills                    | ARRAY                       |
| app_users                    | availability              | jsonb                       |
| app_users                    | notes                     | text                        |
| app_users                    | status                    | character varying           |
| app_users                    | id_copy_url               | text                        |
| app_users                    | invited                   | boolean                     |
| app_users                    | active                    | boolean                     |
| app_users                    | last_login                | timestamp without time zone |
| app_users                    | createdat                 | timestamp without time zone |
| app_users                    | updatedat                 | timestamp without time zone |
| app_users                    | associated_property_ids   | ARRAY                       |
| app_users                    | permanent_address         | text                        |
| app_users                    | national_id               | character varying           |
| camera_monitoring            | id                        | uuid                        |
| camera_monitoring            | cameraid                  | uuid                        |
| camera_monitoring            | monitoringdate            | date                        |
| camera_monitoring            | statusupdate              | character varying           |
| camera_monitoring            | notes                     | text                        |
| camera_monitoring            | createdat                 | timestamp with time zone    |
| camera_monitoring            | updatedat                 | timestamp with time zone    |
| cameras                      | id                        | uuid                        |
| cameras                      | propertyid                | uuid                        |
| cameras                      | locationdescription       | text                        |
| cameras                      | cameratype                | character varying           |
| cameras                      | installationdetails       | text                        |
| cameras                      | datapackageinfo           | jsonb                       |
| cameras                      | status                    | character varying           |
| cameras                      | createdat                 | timestamp with time zone    |
| cameras                      | updatedat                 | timestamp with time zone    |
| evia_sign_config             | id                        | uuid                        |
| evia_sign_config             | config_key                | text                        |
| evia_sign_config             | config_value              | text                        |
| evia_sign_config             | is_secret                 | boolean                     |
| evia_sign_config             | description               | text                        |
| evia_sign_config             | last_updated              | timestamp with time zone    |
| invoices                     | id                        | uuid                        |
| invoices                     | renteeid                  | uuid                        |
| invoices                     | propertyid                | uuid                        |
| invoices                     | billingperiod             | character varying           |
| invoices                     | components                | jsonb                       |
| invoices                     | totalamount               | numeric                     |
| invoices                     | status                    | character varying           |
| invoices                     | paymentproofurl           | text                        |
| invoices                     | paymentdate               | timestamp with time zone    |
| invoices                     | duedate                   | date                        |
| invoices                     | notes                     | text                        |
| invoices                     | createdat                 | timestamp with time zone    |
| invoices                     | updatedat                 | timestamp with time zone    |
| letter_templates             | id                        | uuid                        |
| letter_templates             | type                      | character varying           |
| letter_templates             | subject                   | character varying           |
| letter_templates             | content                   | text                        |
| letter_templates             | language                  | character varying           |
| letter_templates             | version                   | character varying           |
| letter_templates             | createdat                 | timestamp with time zone    |
| letter_templates             | updatedat                 | timestamp with time zone    |
| maintenance_request_comments | id                        | uuid                        |
| maintenance_request_comments | maintenance_request_id    | uuid                        |
| maintenance_request_comments | user_id                   | uuid                        |
| maintenance_request_comments | comment                   | text                        |
| maintenance_request_comments | created_at                | timestamp with time zone    |
| maintenance_request_comments | updated_at                | timestamp with time zone    |
| maintenance_request_images   | id                        | uuid                        |
| maintenance_request_images   | maintenance_request_id    | uuid                        |
| maintenance_request_images   | image_url                 | text                        |
| maintenance_request_images   | image_type                | text                        |
| maintenance_request_images   | uploaded_by               | uuid                        |
| maintenance_request_images   | uploaded_at               | timestamp with time zone    |
| maintenance_request_images   | description               | text                        |
| maintenance_requests         | id                        | uuid                        |
| maintenance_requests         | propertyid                | uuid                        |
| maintenance_requests         | renteeid                  | uuid                        |
| maintenance_requests         | title                     | text                        |
| maintenance_requests         | description               | text                        |
| maintenance_requests         | priority                  | text                        |
| maintenance_requests         | status                    | text                        |
| maintenance_requests         | requesttype               | text                        |
| maintenance_requests         | createdat                 | timestamp with time zone    |
| maintenance_requests         | updatedat                 | timestamp with time zone    |
| maintenance_requests         | assignedto                | uuid                        |
| maintenance_requests         | assignedat                | timestamp with time zone    |
| maintenance_requests         | startedat                 | timestamp with time zone    |
| maintenance_requests         | completedat               | timestamp with time zone    |
| maintenance_requests         | cancelledat               | timestamp with time zone    |
| maintenance_requests         | cancellationreason        | text                        |
| maintenance_requests         | notes                     | text                        |
| notifications                | id                        | uuid                        |
| notifications                | user_id                   | uuid                        |
| notifications                | message                   | text                        |
| notifications                | createdat                 | timestamp with time zone    |
| notifications                | is_read                   | boolean                     |
| notifications                | updatedat                 | timestamp with time zone    |
| payments                     | id                        | uuid                        |
| payments                     | invoiceid                 | uuid                        |
| payments                     | amount                    | numeric                     |
| payments                     | paymentmethod             | character varying           |
| payments                     | transactionreference      | character varying           |
| payments                     | paymentdate               | timestamp with time zone    |
| payments                     | status                    | character varying           |
| payments                     | notes                     | text                        |
| payments                     | createdat                 | timestamp with time zone    |
| payments                     | updatedat                 | timestamp with time zone    |
| properties                   | id                        | uuid                        |
| properties                   | name                      | character varying           |
| properties                   | address                   | text                        |
| properties                   | unitconfiguration         | character varying           |
| properties                   | rentalvalues              | jsonb                       |
| properties                   | checklistitems            | ARRAY                       |
| properties                   | terms                     | jsonb                       |
| properties                   | images                    | ARRAY                       |
| properties                   | description               | text                        |
| properties                   | status                    | character varying           |
| properties                   | createdat                 | timestamp with time zone    |
| properties                   | updatedat                 | timestamp with time zone    |
| properties                   | availablefrom             | timestamp with time zone    |
| properties                   | propertytype              | character varying           |
| properties                   | squarefeet                | numeric                     |
| properties                   | yearbuilt                 | integer                     |
| properties                   | amenities                 | ARRAY                       |
| properties                   | bank_name                 | character varying           |
| properties                   | bank_branch               | character varying           |
| properties                   | bank_account_number       | character varying           |
| properties                   | electricity_rate          | numeric                     |
| properties                   | water_rate                | numeric                     |
| property_units               | id                        | uuid                        |
| property_units               | propertyid                | uuid                        |
| property_units               | unitnumber                | character varying           |
| property_units               | floor                     | character varying           |
| property_units               | bedrooms                  | integer                     |
| property_units               | bathrooms                 | integer                     |
| property_units               | rentalvalues              | jsonb                       |
| property_units               | status                    | character varying           |
| property_units               | createdat                 | timestamp with time zone    |
| property_units               | updatedat                 | timestamp with time zone    |
| property_units               | description               | character varying           |
| property_units               | squarefeet                | numeric                     |
| property_units               | bank_name                 | character varying           |
| property_units               | bank_branch               | character varying           |
| property_units               | bank_account_number       | character varying           |
| scheduled_tasks              | id                        | uuid                        |
| scheduled_tasks              | propertyid                | uuid                        |
| scheduled_tasks              | tasktype                  | character varying           |
| scheduled_tasks              | frequency                 | character varying           |
| scheduled_tasks              | description               | text                        |
| scheduled_tasks              | assignedteam              | character varying           |
| scheduled_tasks              | lastcompleteddate         | timestamp with time zone    |
| scheduled_tasks              | nextduedate               | timestamp with time zone    |
| scheduled_tasks              | status                    | character varying           |
| scheduled_tasks              | notes                     | text                        |
| scheduled_tasks              | createdat                 | timestamp with time zone    |
| scheduled_tasks              | updatedat                 | timestamp with time zone    |
| sent_letters                 | id                        | uuid                        |
| sent_letters                 | templateid                | uuid                        |
| sent_letters                 | renteeid                  | uuid                        |
| sent_letters                 | propertyid                | uuid                        |
| sent_letters                 | sentdate                  | timestamp with time zone    |
| sent_letters                 | channel                   | character varying           |
| sent_letters                 | status                    | character varying           |
| sent_letters                 | content                   | text                        |
| sent_letters                 | createdat                 | timestamp with time zone    |
| sent_letters                 | updatedat                 | timestamp with time zone    |
| task_assignments             | id                        | uuid                        |
| task_assignments             | teammemberid              | uuid                        |
| task_assignments             | tasktype                  | character varying           |
| task_assignments             | tasktitle                 | character varying           |
| task_assignments             | taskdescription           | text                        |
| task_assignments             | status                    | character varying           |
| task_assignments             | priority                  | character varying           |
| task_assignments             | duedate                   | timestamp with time zone    |
| task_assignments             | completiondate            | timestamp with time zone    |
| task_assignments             | notes                     | text                        |
| task_assignments             | relatedentitytype         | character varying           |
| task_assignments             | relatedentityid           | uuid                        |
| task_assignments             | createdat                 | timestamp with time zone    |
| task_assignments             | updatedat                 | timestamp with time zone    |
| utility_billing              | id                        | uuid                        |
| utility_billing              | reading_id                | uuid                        |
| utility_billing              | rentee_id                 | uuid                        |
| utility_billing              | property_id               | uuid                        |
| utility_billing              | utility_type              | character varying           |
| utility_billing              | consumption               | numeric                     |
| utility_billing              | rate                      | numeric                     |
| utility_billing              | amount                    | numeric                     |
| utility_billing              | reading_date              | timestamp with time zone    |
| utility_billing              | billing_month             | character varying           |
| utility_billing              | billing_year              | integer                     |
| utility_billing              | status                    | character varying           |
| utility_billing              | invoice_id                | uuid                        |
| utility_billing              | approved_date             | timestamp with time zone    |
| utility_billing              | invoiced_date             | timestamp with time zone    |
| utility_billing              | created_at                | timestamp with time zone    |
| utility_billing              | updated_at                | timestamp with time zone    |
| utility_configs              | id                        | uuid                        |
| utility_configs              | utilitytype               | character varying           |
| utility_configs              | billingtype               | character varying           |
| utility_configs              | rate                      | numeric                     |
| utility_configs              | fixedamount               | numeric                     |
| utility_configs              | createdat                 | timestamp with time zone    |
| utility_configs              | updatedat                 | timestamp with time zone    |
| utility_readings             | id                        | uuid                        |
| utility_readings             | renteeid                  | uuid                        |
| utility_readings             | propertyid                | uuid                        |
| utility_readings             | utilitytype               | character varying           |
| utility_readings             | previousreading           | numeric                     |
| utility_readings             | currentreading            | numeric                     |
| utility_readings             | readingdate               | date                        |
| utility_readings             | photourl                  | text                        |
| utility_readings             | calculatedbill            | numeric                     |
| utility_readings             | status                    | character varying           |
| utility_readings             | createdat                 | timestamp with time zone    |
| utility_readings             | updatedat                 | timestamp with time zone    |
| utility_readings             | approved_date             | timestamp with time zone    |
| utility_readings             | billing_data              | jsonb                       |
| utility_readings             | invoice_id                | uuid                        |
| utility_readings             | billing_status            | character varying           |
| utility_readings             | invoiced_date             | timestamp with time zone    |
| utility_readings             | rejection_reason          | text                        |
| utility_readings             | rejected_date             | timestamp with time zone    |
| webhook_events               | id                        | uuid                        |
| webhook_events               | event_type                | text                        |
| webhook_events               | eviasignreference         | uuid                        |
| webhook_events               | user_name                 | text                        |
| webhook_events               | user_email                | text                        |
| webhook_events               | subject                   | text                        |
| webhook_events               | event_id                  | integer                     |
| webhook_events               | event_time                | timestamp with time zone    |
| webhook_events               | raw_data                  | jsonb                       |
| webhook_events               | createdat                 | timestamp with time zone    |
| webhook_events               | updatedat                 | timestamp with time zone    |
| webhook_events               | processed                 | boolean                     |
| webhook_events               | processedat               | timestamp without time zone |