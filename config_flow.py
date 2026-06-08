"""Config flow for the Google Assistant (Manual) integration."""

import json
import logging
from typing import Any

import voluptuous as vol

from homeassistant.config_entries import (
    ConfigFlow,
    ConfigFlowResult,
)
from homeassistant.const import CONF_PROJECT_ID

from .const import (
    CONF_CLIENT_EMAIL,
    CONF_PRIVATE_KEY,
    CONF_REPORT_STATE,
    CONF_SECURE_DEVICES_PIN,
    CONF_SERVICE_ACCOUNT,
    DOMAIN,
)

_LOGGER = logging.getLogger(__name__)


def _parse_service_account_json(raw: str) -> dict[str, str]:
    """Parse a service account JSON string and return {client_email, private_key}.

    Raises vol.Invalid with a user-friendly message on any parsing failure.
    """
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        _LOGGER.debug("Service account JSON parse failed at line %s col %s: %s", exc.lineno, exc.colno, exc.msg)
        raise vol.Invalid(
            f"Invalid JSON (line {exc.lineno}, column {exc.colno}): {exc.msg}"
        ) from exc
    except Exception as exc:
        _LOGGER.debug("Unexpected error parsing service account JSON: %s", exc)
        raise vol.Invalid(f"Cannot parse service account JSON: {exc}") from exc

    if not isinstance(data, dict):
        actual_type = type(data).__name__
        _LOGGER.debug("Service account JSON is not a dict (type=%s)", actual_type)
        raise vol.Invalid(
            f"Service account must be a JSON object, got {actual_type}. "
            "Did you paste the entire downloaded JSON key file contents?"
        )

    client_email = data.get("client_email")
    private_key = data.get("private_key")

    missing = []
    if not client_email:
        missing.append("client_email")
    if not private_key:
        missing.append("private_key")

    if missing:
        _LOGGER.debug(
            "Service account JSON missing fields: %s. Available keys: %s",
            missing,
            list(data.keys()),
        )
        raise vol.Invalid(
            f"Missing required fields: {', '.join(missing)}. "
            "Does the JSON contain 'client_email' and 'private_key'?"
        )

    if not isinstance(client_email, str):
        _LOGGER.debug("client_email is not a string (type=%s)", type(client_email).__name__)
        raise vol.Invalid("'client_email' must be a string")
    if not isinstance(private_key, str):
        _LOGGER.debug("private_key is not a string (type=%s)", type(private_key).__name__)
        raise vol.Invalid("'private_key' must be a string")

    _LOGGER.debug("Successfully parsed service account for '%s'", client_email)
    return {
        CONF_CLIENT_EMAIL: client_email,
        CONF_PRIVATE_KEY: private_key,
    }


class GoogleAssistantManualConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle a config flow for Google Assistant (Manual)."""

    VERSION = 1

    def __init__(self) -> None:
        """Initialize the config flow."""
        super().__init__()
        self._data: dict[str, Any] = {}
        self._imported_options: dict[str, Any] = {}

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Handle the initial step — project_id."""
        errors: dict[str, str] = {}

        if user_input is not None:
            project_id = user_input.get(CONF_PROJECT_ID, "").strip()
            _LOGGER.debug("Config flow step_user: project_id='%s'", project_id)

            if not project_id:
                _LOGGER.debug("Config flow: empty project_id submitted")
                errors[CONF_PROJECT_ID] = "project_id_required"
            elif not _is_valid_project_id(project_id):
                _LOGGER.debug("Config flow: invalid project_id format: '%s'", project_id)
                errors[CONF_PROJECT_ID] = "invalid_project_id"

            if not errors:
                self._data[CONF_PROJECT_ID] = project_id
                _LOGGER.info(
                    "Config flow: accepted project_id='%s', advancing to service_account step",
                    project_id,
                )
                return await self.async_step_service_account()

        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema(
                {
                    vol.Required(
                        CONF_PROJECT_ID,
                        default=self._data.get(CONF_PROJECT_ID, ""),
                    ): str,
                }
            ),
            errors=errors,
        )

    async def async_step_service_account(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Handle the service account JSON step."""
        errors: dict[str, str] = {}
        project_id = self._data.get(CONF_PROJECT_ID, "<missing>")

        if user_input is not None:
            raw = user_input.get(CONF_SERVICE_ACCOUNT, "").strip()
            _LOGGER.debug(
                "Config flow step_service_account for project='%s': "
                "raw input length=%d chars",
                project_id,
                len(raw),
            )

            if not raw:
                _LOGGER.debug("Config flow: empty service_account submitted")
                errors[CONF_SERVICE_ACCOUNT] = "service_account_required"
            else:
                try:
                    account = _parse_service_account_json(raw)
                except vol.Invalid as exc:
                    error_msg = str(exc)
                    _LOGGER.debug("Config flow: service_account validation failed: %s", error_msg)
                    errors[CONF_SERVICE_ACCOUNT] = error_msg
                else:
                    self._data[CONF_SERVICE_ACCOUNT] = account
                    _LOGGER.info(
                        "Config flow: creating entry for project='%s' "
                        "with client_email='%s'%s",
                        project_id,
                        account[CONF_CLIENT_EMAIL],
                        " (from YAML import)" if self._imported_options else "",
                    )

                    if self._imported_options:
                        _LOGGER.info(
                            "YAML import options applied: %s",
                            {k: v for k, v in self._imported_options.items() if k != CONF_PRIVATE_KEY},
                        )
                        return self.async_create_entry(
                            title=project_id,
                            data=self._data,
                            options=self._imported_options,
                        )

                    return self.async_create_entry(
                        title=project_id,
                        data=self._data,
                    )

        default_sa = ""
        if self._imported_options and CONF_SERVICE_ACCOUNT in self._imported_options:
            sa = self._imported_options[CONF_SERVICE_ACCOUNT]
            if isinstance(sa, dict):
                try:
                    default_sa = json.dumps(sa, indent=2)
                    _LOGGER.debug("Pre-filled service_account from YAML import")
                except Exception:
                    _LOGGER.debug("Could not serialize imported service_account to JSON")
                    default_sa = ""

        return self.async_show_form(
            step_id="service_account",
            data_schema=vol.Schema(
                {
                    vol.Required(
                        CONF_SERVICE_ACCOUNT,
                        description={"suggested_value": default_sa},
                    ): str,
                }
            ),
            errors=errors,
            description_placeholders={
                "docs_url": "https://console.cloud.google.com/iam-admin/serviceaccounts"
            },
        )

    async def async_step_import(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Handle importing from YAML configuration."""
        if not user_input:
            _LOGGER.debug("YAML import: empty config, aborting")
            return self.async_abort(reason="empty_config")

        project_id = user_input.get(CONF_PROJECT_ID)
        if not project_id:
            _LOGGER.warning(
                "YAML import: missing project_id in google_assistant config. "
                "Available keys: %s",
                list(user_input.keys()) if isinstance(user_input, dict) else "<not a dict>",
            )
            return self.async_abort(reason="missing_project_id")

        _LOGGER.info(
            "YAML import: project_id='%s', keys found: %s",
            project_id,
            [k for k in user_input if k != CONF_SERVICE_ACCOUNT and k != CONF_PRIVATE_KEY],
        )

        self._data[CONF_PROJECT_ID] = project_id

        service_account = user_input.get(CONF_SERVICE_ACCOUNT)
        if service_account is not None:
            if isinstance(service_account, dict):
                self._data[CONF_SERVICE_ACCOUNT] = {
                    CONF_CLIENT_EMAIL: service_account.get(CONF_CLIENT_EMAIL, ""),
                    CONF_PRIVATE_KEY: service_account.get(CONF_PRIVATE_KEY, ""),
                }
                _LOGGER.debug(
                    "YAML import: service_account client_email='%s'",
                    service_account.get(CONF_CLIENT_EMAIL, "<missing>"),
                )
            else:
                _LOGGER.warning(
                    "YAML import: service_account is not a dict (type=%s), skipping",
                    type(service_account).__name__,
                )

        # Transfer top-level options
        if CONF_REPORT_STATE in user_input:
            self._imported_options[CONF_REPORT_STATE] = user_input[CONF_REPORT_STATE]
            _LOGGER.debug("YAML import: report_state=%s", user_input[CONF_REPORT_STATE])
        if CONF_SECURE_DEVICES_PIN in user_input:
            self._imported_options[CONF_SECURE_DEVICES_PIN] = user_input[CONF_SECURE_DEVICES_PIN]
            _LOGGER.debug("YAML import: secure_devices_pin=<present>")
        if "expose_by_default" in user_input:
            self._imported_options["expose_by_default"] = user_input["expose_by_default"]
            _LOGGER.debug("YAML import: expose_by_default=%s", user_input["expose_by_default"])
        if "exposed_domains" in user_input:
            domains = user_input["exposed_domains"]
            self._imported_options["exposed_domains"] = domains
            _LOGGER.debug("YAML import: exposed_domains=%s", domains)

        # The entity_config key is explicitly not imported — entity exposure
        # should be managed through the Voice Assistants UI.
        if "entity_config" in user_input:
            entity_count = (
                len(user_input["entity_config"])
                if isinstance(user_input["entity_config"], dict)
                else 0
            )
            _LOGGER.warning(
                "YAML import: entity_config found (%d entities) — NOT imported. "
                "Per-entity settings must be configured via the Voice Assistants → "
                "Expose page in the UI. The YAML entity_config section will be ignored.",
                entity_count,
            )

        return await self.async_step_user()


def _is_valid_project_id(value: str) -> bool:
    """Check if the string looks like a valid GCP project ID.

    GCP project IDs: 6-30 chars, start with a letter, lowercase letters,
    digits, and hyphens only. Must not end with a hyphen.
    """
    if not value:
        return False
    if len(value) < 6:
        _LOGGER.debug("Project ID '%s' too short (%d chars, min 6)", value, len(value))
        return False
    if len(value) > 30:
        _LOGGER.debug("Project ID '%s' too long (%d chars, max 30)", value, len(value))
        return False
    if not value[0].isalpha():
        _LOGGER.debug("Project ID '%s' does not start with a letter", value)
        return False
    if value[-1] == "-":
        _LOGGER.debug("Project ID '%s' ends with a hyphen", value)
        return False

    invalid_chars = [c for c in value if not (c.islower() or c.isdigit() or c == "-")]
    if invalid_chars:
        _LOGGER.debug(
            "Project ID '%s' contains invalid characters: %s",
            value,
            invalid_chars,
        )
        return False

    return True
