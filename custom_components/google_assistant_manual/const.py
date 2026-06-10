"""Constants for the Google Assistant Manual integration."""

DOMAIN = "google_assistant_manual"

ASSISTANT_ID = "google_assistant_manual"

CONF_CLIENT_EMAIL = "client_email"
CONF_PRIVATE_KEY = "private_key"
CONF_PROJECT_ID = "project_id"
CONF_REPORT_STATE = "report_state"
CONF_SECURE_DEVICES_PIN = "secure_devices_pin"
CONF_SERVICE_ACCOUNT = "service_account"
WS_GET_CONFIG = "google_assistant_manual/get_config"
WS_UPDATE_CONFIG = "google_assistant_manual/update_config"
WS_ENABLE = "google_assistant_manual/enable"
WS_DISABLE = "google_assistant_manual/disable"
WS_GET_ENTITY = "google_assistant_manual/get_entity"
WS_UPDATE_ENTITY = "google_assistant_manual/update_entity"

# Per-entity assistant option mirroring cloud's PREF_DISABLE_2FA.
PREF_DISABLE_2FA = "disable_2fa"

CORE_GA_DOMAIN = "google_assistant"
CORE_GA_DATA_CONFIG = "config"
