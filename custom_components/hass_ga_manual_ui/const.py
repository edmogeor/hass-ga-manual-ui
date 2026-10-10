"""Constants for the Google Assistant Manual integration."""

DOMAIN = "hass_ga_manual_ui"

ASSISTANT_ID = "hass_ga_manual_ui"

CONF_CLIENT_EMAIL = "client_email"
CONF_PRIVATE_KEY = "private_key"
CONF_PROJECT_ID = "project_id"
CONF_REPORT_STATE = "report_state"
CONF_SECURE_DEVICES_PIN = "secure_devices_pin"
CONF_SERVICE_ACCOUNT = "service_account"
WS_GET_ENTRY_ID = f"{ASSISTANT_ID}/get_entry_id"
WS_GET_CONFIG = f"{ASSISTANT_ID}/get_config"
WS_UPDATE_CONFIG = f"{ASSISTANT_ID}/update_config"
WS_ENABLE = f"{ASSISTANT_ID}/enable"
WS_DISABLE = f"{ASSISTANT_ID}/disable"
WS_GET_ENTITY = f"{ASSISTANT_ID}/get_entity"
WS_UPDATE_ENTITY = f"{ASSISTANT_ID}/update_entity"
WS_EXPORT_CONFIG = f"{ASSISTANT_ID}/export_config"
WS_IMPORT_CONFIG = f"{ASSISTANT_ID}/import_config"

# One-time YAML migration: config-flow checkbox + persisted "done" flag.
CONF_MIGRATE_YAML = "migrate_yaml"
OPT_YAML_MIGRATED = "yaml_migrated"
OPT_HIDE_CLOUD = "hide_home_assistant_cloud"

# Per-entity assistant option mirroring cloud's PREF_DISABLE_2FA.
PREF_DISABLE_2FA = "disable_2fa"

CORE_GA_DOMAIN = "google_assistant"
CORE_GA_DATA_CONFIG = "config"

# Ownership markers written into the shadow `google_assistant` config entry's
# data, so we only ever prune entries we created. Inert to core GA, which reads
# its config from CORE_GA_DATA_CONFIG, not the shadow entry's data.
CORE_GA_CREATED_BY = "created_by_hass_ga_manual_ui"
CORE_GA_PARENT_ENTRY_ID = "hass_ga_manual_ui_parent_entry_id"
