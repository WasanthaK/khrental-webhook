# Webhook Server Changelog

## [1.2.0] - 2023-04-06

### Added
- Enhanced signatory tracking with actual names in status messages
- Document storage in Supabase with proper URL updating
- Comprehensive test script to verify the webhook flow
- Agreement cancellation functionality in the UI
- Download link for signed documents in the UI

### Changed
- Updated signature_status field to use actual signatory names
- Improved the SignatureProgressTracker to display personalized status messages
- Enhanced AgreementSummaryCard with document links and cancel buttons
- Updated database constraint for signature_status to include all possible values

### Fixed
- Fixed constraint issue in the database for signature_status values
- Corrected foreign key relationships in agreement queries
- Improved error handling in document processing and storage

## [1.1.0] - 2023-03-15

### Added
- Implementation of dual-state tracking for agreements
- Separate tracking of agreement lifecycle state and signature process
- Detailed status mapping for Evia Sign webhook events
- Verification script for database flow

### Changed
- Updated webhook processing flow to update agreements before marking events as processed
- Improved error handling and recovery mechanisms
- Enhanced logging for better debugging

## [1.0.0] - 2023-02-01

### Added
- Initial implementation of webhook server
- Basic agreement status tracking
- Integration with Evia Sign webhooks
- Support for agreement creation and signature workflows 