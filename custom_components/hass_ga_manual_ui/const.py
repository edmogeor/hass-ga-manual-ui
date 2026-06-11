"""Constants for the Google Assistant Manual integration."""

DOMAIN = "hass_ga_manual_ui"

ASSISTANT_ID = "hass_ga_manual_ui"

CONF_CLIENT_EMAIL = "client_email"
CONF_PRIVATE_KEY = "private_key"
CONF_PROJECT_ID = "project_id"
CONF_REPORT_STATE = "report_state"
CONF_SECURE_DEVICES_PIN = "secure_devices_pin"
CONF_SERVICE_ACCOUNT = "service_account"
WS_GET_ENTRY_ID = "hass_ga_manual_ui/get_entry_id"
WS_GET_CONFIG = "hass_ga_manual_ui/get_config"
WS_UPDATE_CONFIG = "hass_ga_manual_ui/update_config"
WS_ENABLE = "hass_ga_manual_ui/enable"
WS_DISABLE = "hass_ga_manual_ui/disable"
WS_GET_ENTITY = "hass_ga_manual_ui/get_entity"
WS_UPDATE_ENTITY = "hass_ga_manual_ui/update_entity"

# Per-entity assistant option mirroring cloud's PREF_DISABLE_2FA.
PREF_DISABLE_2FA = "disable_2fa"

CORE_GA_DOMAIN = "google_assistant"
CORE_GA_DATA_CONFIG = "config"

# Ownership markers written into the shadow `google_assistant` config entry's
# data. They let us identify entries this integration created and which of our
# entries owns each one, so pruning is deterministic and never touches a
# google_assistant entry the user configured independently. These keys are
# inert to core GA, which reads its runtime config from CORE_GA_DATA_CONFIG
# (built by _build_core_config), not from the shadow entry's data.
CORE_GA_CREATED_BY = "created_by_hass_ga_manual_ui"
CORE_GA_PARENT_ENTRY_ID = "hass_ga_manual_ui_parent_entry_id"
