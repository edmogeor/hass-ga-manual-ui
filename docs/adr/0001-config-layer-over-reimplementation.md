# Config layer, not re-implementation

We chose to build this integration as a configuration management layer on top of the
existing `google_assistant` core component, rather than re-implementing its webhook
handling, state reporting, request syncing, and device trait mapping.

The core GA component already handles ~3,000 lines of complex functionality
(JWT token management, HomeGraph API calls, trait mapping for 22+ device domains,
entity filtering, agent user ID tracking). Re-implementing this in a custom integration
would be fragile, duplicate tested code, and diverge from upstream over time.

Instead, this integration manages configuration (project_id, service_account,
report_state, PIN) and entity exposure through the UI, then bridges that config
to core GA's existing `async_setup_entry` machinery. Core GA does the heavy lifting
exactly as it always has.
