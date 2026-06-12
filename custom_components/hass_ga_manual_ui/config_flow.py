"""Config flow for the Google Assistant (Manual) integration."""

import json
import logging
from typing import Any

import voluptuous as vol
from homeassistant.config import async_hass_config_yaml
from homeassistant.config_entries import (
    ConfigFlow,
    ConfigFlowResult,
)
from homeassistant.helpers.translation import async_get_translations

from .const import (
    CONF_CLIENT_EMAIL,
    CONF_PRIVATE_KEY,
    CONF_PROJECT_ID,
    CONF_SERVICE_ACCOUNT,
    CORE_GA_DOMAIN,
    DOMAIN,
)
from .locale import async_load_locale

_LOGGER = logging.getLogger(__name__)

_GUIDE_URL = "https://www.home-assistant.io/integrations/google_assistant/#manual-setup"

# English fallback for the install notification (see _notify_installed).
_INSTALL_NOTICE_FALLBACK = (
    "Google Assistant (Manual) is installed. If its card doesn't appear under "
    "Settings → Voice assistants, do a one-time hard refresh of your browser "
    "(Ctrl+Shift+R, or Cmd+Shift+R on Mac). This is only needed once, after "
    "installing or updating."
)


def _parse_service_account_json(raw: str) -> dict[str, str]:
    """Parse a service account JSON string and return {client_email, private_key}.

    Raises vol.Invalid with a user-friendly message on any parsing failure.
    """
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        _LOGGER.debug(
            "Service account JSON parse failed at line %s col %s: %s",
            exc.lineno,
            exc.colno,
            exc.msg,
        )
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

    missing: list[str] = []
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
        _LOGGER.debug(
            "client_email is not a string (type=%s)", type(client_email).__name__
        )
        raise vol.Invalid("'client_email' must be a string")
    if not isinstance(private_key, str):
        _LOGGER.debug(
            "private_key is not a string (type=%s)", type(private_key).__name__
        )
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

    async def _yaml_notice(self) -> str:
        """Return the localized 'remove your YAML' notice, or '' if none is needed.

        Only shown when configuration.yaml actually declares a google_assistant:
        section (which this integration overrides at runtime).
        """
        try:
            config = await async_hass_config_yaml(self.hass)
        except Exception as exc:  # malformed YAML, IO error, etc.
            _LOGGER.debug("Could not read configuration.yaml for YAML check: %s", exc)
            return ""

        present = any(
            key == CORE_GA_DOMAIN or key.startswith(f"{CORE_GA_DOMAIN} ")
            for key in config
        )
        if not present:
            return ""

        strings = await async_load_locale(self.hass, self.hass.config.language)
        return strings.get("yaml_notice", "")

    async def _notify_installed(self) -> None:
        """Post a one-time 'refresh your browser' notification on install.

        A fresh install needs a hard browser refresh before the injected card
        appears; this server-side notification reaches the user even though our
        frontend JS hasn't loaded yet. Best-effort — never blocks the entry.
        """
        hass = getattr(self, "hass", None)
        if hass is None:
            return

        strings: dict[str, Any]
        try:
            strings = await async_load_locale(hass, hass.config.language)
        except Exception as exc:
            _LOGGER.debug("Could not load install-notice locale: %s", exc)
            strings = {}
        message = strings.get("install_notice", _INSTALL_NOTICE_FALLBACK)

        # Title stays in the standard config translations (a valid hassfest key).
        try:
            translations = await async_get_translations(
                hass, hass.config.language, "config", {DOMAIN}
            )
            title = translations.get(
                f"component.{DOMAIN}.config.step.user.title",
                "Google Assistant (Manual)",
            )
        except Exception as exc:
            _LOGGER.debug("Could not load install-notice title: %s", exc)
            title = "Google Assistant (Manual)"

        try:
            from homeassistant.components import persistent_notification

            persistent_notification.async_create(
                hass,
                message,
                title=title,
                notification_id="hass_ga_manual_ui_install",
            )
            _LOGGER.debug("Posted post-install refresh notification")
        except Exception as exc:
            _LOGGER.debug("Could not create install notification: %s", exc)

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
                _LOGGER.debug(
                    "Config flow: invalid project_id format: '%s'", project_id
                )
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
            description_placeholders={
                "guide_url": _GUIDE_URL,
                "yaml_notice": await self._yaml_notice(),
            },
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
                    _LOGGER.debug(
                        "Config flow: service_account validation failed: %s", error_msg
                    )
                    errors[CONF_SERVICE_ACCOUNT] = error_msg
                else:
                    self._data[CONF_SERVICE_ACCOUNT] = account
                    _LOGGER.info(
                        "Config flow: creating entry for project='%s' "
                        "with client_email='%s'",
                        project_id,
                        account[CONF_CLIENT_EMAIL],
                    )

                    await self._notify_installed()

                    return self.async_create_entry(
                        title=project_id,
                        data=self._data,
                    )

        return self.async_show_form(
            step_id="service_account",
            data_schema=vol.Schema(
                {
                    vol.Required(
                        CONF_SERVICE_ACCOUNT,
                        description={"suggested_value": ""},
                    ): str,
                }
            ),
            errors=errors,
            description_placeholders={
                "docs_url": "https://console.cloud.google.com/iam-admin/serviceaccounts",
                "guide_url": _GUIDE_URL,
            },
        )


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
