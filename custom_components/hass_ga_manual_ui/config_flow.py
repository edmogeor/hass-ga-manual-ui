"""Config flow for the Google Assistant (Manual) integration."""

import json
import logging
import re
import time
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
    CONF_MIGRATE_YAML,
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
        raise vol.Invalid(
            f"Invalid JSON (line {exc.lineno}, column {exc.colno}): {exc.msg}"
        ) from exc
    except Exception as exc:
        raise vol.Invalid(f"Cannot parse service account JSON: {exc}") from exc

    if not isinstance(data, dict):
        actual_type = type(data).__name__
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
        raise vol.Invalid("'client_email' must be a string")
    if not isinstance(private_key, str):
        raise vol.Invalid("'private_key' must be a string")

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
        # The parsed google_assistant: YAML block, cached for prefill/migration.
        self._yaml_block: dict[str, Any] | None = None

    async def _read_ga_yaml(self) -> dict[str, Any] | None:
        """Return the parsed `google_assistant:` block from configuration.yaml.

        HA's loader resolves `!include` / `!secret` here, so a nested
        `service_account: !include` arrives as a plain dict. Returns None when no
        section is present or the YAML cannot be read.
        """
        try:
            config = await async_hass_config_yaml(self.hass)
        except Exception as exc:  # malformed YAML, IO error, etc.
            _LOGGER.debug("Could not read configuration.yaml: %s", exc)
            return None

        for key, value in config.items():
            if key == CORE_GA_DOMAIN or key.startswith(f"{CORE_GA_DOMAIN} "):
                return value if isinstance(value, dict) else None
        return None

    async def _yaml_notice(self) -> str:
        """Return the localized 'remove your YAML' notice, or '' if none is needed.

        Shown as the body of the dedicated migration step, so leading/trailing
        whitespace is stripped (the locale string carries a leading blank line
        from when it was appended to another description).
        """
        if self._yaml_block is None:
            return ""
        strings = await async_load_locale(self.hass, self.hass.config.language)
        return strings.get("yaml_notice", "").strip()

    def _migrating(self) -> bool:
        """Whether the user opted to migrate an existing YAML block.

        Gates every read of YAML details (project_id / service_account prefill):
        if the checkbox is unchecked, we pull nothing from the YAML.
        """
        return bool(self._data.get(CONF_MIGRATE_YAML)) and self._yaml_block is not None

    async def _notify_installed(self) -> None:
        """Post a one-time 'refresh your browser' notification on install.

        A fresh install needs a hard browser refresh before the injected card
        appears; this server-side notification reaches the user even though our
        frontend JS hasn't loaded yet. Best-effort - never blocks the entry.
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
                f"component.{DOMAIN}.config.step.credentials.title",
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
        except Exception as exc:
            _LOGGER.debug("Could not create install notification: %s", exc)

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Entry point.

        Always opens with an intro page. When a `google_assistant:` YAML block
        exists it is the migration page (notice + opt-in checkbox); otherwise it
        is a from-scratch heads-up that this integration overrides any YAML and
        that export/import is available later from the voice assistants page.
        """
        # Read the YAML block once; cached for prefill / migration.
        if self._yaml_block is None:
            self._yaml_block = await self._read_ga_yaml()

        if self._yaml_block is None:
            return await self.async_step_intro()

        if user_input is not None:
            self._data[CONF_MIGRATE_YAML] = bool(
                user_input.get(CONF_MIGRATE_YAML, True)
            )
            return await self.async_step_credentials()

        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema(
                {vol.Optional(CONF_MIGRATE_YAML, default=True): bool}
            ),
            description_placeholders={"yaml_notice": await self._yaml_notice()},
        )

    async def async_step_intro(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """From-scratch heads-up page (shown when there is no YAML to migrate).

        Acknowledge-only: makes a fresh user aware that this integration overrides
        any future `google_assistant:` YAML, and that a standalone YAML can be
        exported/imported later from Settings -> Voice assistants.
        """
        if user_input is not None:
            return await self.async_step_credentials()
        return self.async_show_form(step_id="intro", data_schema=vol.Schema({}))

    def _yaml_project_id(self) -> str | None:
        """A valid project_id from the YAML block when migrating, else None."""
        if self._yaml_block is None or not self._migrating():
            return None
        pid = self._yaml_block.get(CONF_PROJECT_ID)
        return pid if isinstance(pid, str) and _is_valid_project_id(pid) else None

    def _yaml_service_account(self) -> dict[str, str] | None:
        """The parsed {client_email, private_key} from the YAML block when migrating.

        The loader resolves `!include`/`!secret`, so the value is normally a dict;
        a JSON string is also accepted. Returns None (not migrating, missing, or
        unparseable) so the caller can fall back to asking the user.
        """
        if self._yaml_block is None or not self._migrating():
            return None
        sa = self._yaml_block.get(CONF_SERVICE_ACCOUNT)
        try:
            raw = json.dumps(sa) if isinstance(sa, dict) else sa
            if not isinstance(raw, str):
                return None
            return _parse_service_account_json(raw)
        except Exception as exc:
            _LOGGER.debug("Could not read service account from YAML: %s", exc)
            return None

    async def async_step_credentials(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Project ID step.

        Skipped when migrating and the YAML already has a valid project_id; only
        shown when we cannot get one (no migration, or YAML lacks/has an invalid
        project_id), prefilled with the YAML value when there is one to fix.
        """
        errors: dict[str, str] = {}

        if user_input is not None:
            project_id = user_input.get(CONF_PROJECT_ID, "").strip()

            if not project_id:
                errors[CONF_PROJECT_ID] = "project_id_required"
            elif not _is_valid_project_id(project_id):
                errors[CONF_PROJECT_ID] = "invalid_project_id"

            if not errors:
                self._data[CONF_PROJECT_ID] = project_id
                return await self.async_step_service_account()
        else:
            yaml_pid = self._yaml_project_id()
            if yaml_pid:
                self._data[CONF_PROJECT_ID] = yaml_pid
                return await self.async_step_service_account()

        # Prefill with the raw YAML project_id (even if invalid) so the user can
        # correct it rather than retype it.
        default_project_id = self._data.get(CONF_PROJECT_ID, "")
        if (
            not default_project_id
            and self._yaml_block is not None
            and self._migrating()
        ):
            default_project_id = str(self._yaml_block.get(CONF_PROJECT_ID, "") or "")

        return self.async_show_form(
            step_id="credentials",
            data_schema=vol.Schema(
                {vol.Required(CONF_PROJECT_ID, default=default_project_id): str}
            ),
            errors=errors,
            description_placeholders={"guide_url": _GUIDE_URL},
        )

    async def async_step_service_account(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Service account step.

        Skipped when migrating and the YAML already has a usable service account;
        only shown when we cannot get one (no migration, or YAML lacks/has an
        unparseable account).
        """
        errors: dict[str, str] = {}
        account: dict[str, str] | None = None

        if user_input is not None:
            raw = user_input.get(CONF_SERVICE_ACCOUNT, "").strip()
            if not raw:
                errors[CONF_SERVICE_ACCOUNT] = "service_account_required"
            else:
                try:
                    account = _parse_service_account_json(raw)
                except vol.Invalid as exc:
                    errors[CONF_SERVICE_ACCOUNT] = str(exc)
        else:
            account = self._yaml_service_account()

        # Verify the credentials actually work with Google before committing.
        if account is not None and not errors:
            error = await self._validate_service_account(account)
            if error:
                errors[CONF_SERVICE_ACCOUNT] = error
            else:
                self._data[CONF_SERVICE_ACCOUNT] = account
                return await self._create_entry()

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

    async def _validate_service_account(self, account: dict[str, str]) -> str | None:
        """Return an error message if Google rejects the account, else None.

        Definitive rejections (bad private key, or a 4xx from Google's token
        endpoint) block the config. Transport failures (offline, 5xx, timeout)
        return None so a valid config is not blocked when Google is unreachable.
        """
        hass = getattr(self, "hass", None)
        if hass is None:
            return None
        try:
            await _mint_homegraph_token(
                hass, account[CONF_CLIENT_EMAIL], account[CONF_PRIVATE_KEY]
            )
        except _CredentialsRejected as exc:
            _LOGGER.warning("Service account rejected by Google: %s", exc)
            return f"Google rejected the service account: {exc}"
        except Exception as exc:
            _LOGGER.warning(
                "Could not verify service account (proceeding without check): %s", exc
            )
            return None
        _LOGGER.debug("Service account verified against Google HomeGraph")
        return None

    async def _create_entry(self) -> ConfigFlowResult:
        """Finalize the flow: notify, then create the config entry."""
        project_id = self._data.get(CONF_PROJECT_ID, "<missing>")
        account = self._data.get(CONF_SERVICE_ACCOUNT, {})
        _LOGGER.info(
            "Config flow: creating entry for project='%s' with client_email='%s'",
            project_id,
            account.get(CONF_CLIENT_EMAIL, "<missing>"),
        )
        await self._notify_installed()
        return self.async_create_entry(title=project_id, data=self._data)


# GCP project IDs: 6-30 chars, lowercase-letter-led, lowercase/digits/hyphens,
# no trailing hyphen. {4,28} middle gives the 6-30 total length.
_PROJECT_ID_RE = re.compile(r"[a-z][a-z0-9-]{4,28}[a-z0-9]")


def _is_valid_project_id(value: str) -> bool:
    """Check if the string looks like a valid GCP project ID."""
    return isinstance(value, str) and _PROJECT_ID_RE.fullmatch(value) is not None


# Google HomeGraph OAuth endpoint + scope (mirrors google_assistant/const.py).
# Hardcoded so we do not import core GA's const module (it pulls heavy optional
# deps); these are stable Google endpoints.
_HOMEGRAPH_SCOPE = "https://www.googleapis.com/auth/homegraph"
_HOMEGRAPH_TOKEN_URL = "https://accounts.google.com/o/oauth2/token"


class _CredentialsRejected(Exception):
    """The service account was definitively rejected (bad key, or Google 4xx)."""


async def _mint_homegraph_token(hass: Any, client_email: str, private_key: str) -> None:
    """Prove a service account works by minting a HomeGraph access token.

    Mirrors core GA's own token flow (sign a JWT with the private key, exchange
    it at Google's token endpoint). Raises _CredentialsRejected on a bad key or
    a 4xx response; lets transport/5xx errors propagate so the caller can treat
    them as 'could not verify' rather than 'invalid'.
    """
    import jwt
    from homeassistant.helpers.aiohttp_client import async_get_clientsession

    now = int(time.time())
    try:
        assertion = jwt.encode(
            {
                "iss": client_email,
                "scope": _HOMEGRAPH_SCOPE,
                "aud": _HOMEGRAPH_TOKEN_URL,
                "iat": now,
                "exp": now + 3600,
            },
            private_key,
            algorithm="RS256",
        )
    except Exception as exc:
        raise _CredentialsRejected(f"invalid private key ({exc})") from exc

    session = async_get_clientsession(hass)
    async with session.post(
        _HOMEGRAPH_TOKEN_URL,
        data={
            "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
            "assertion": assertion,
        },
    ) as resp:
        if 400 <= resp.status < 500:
            try:
                body = await resp.json()
                reason = (
                    body.get("error_description")
                    or body.get("error")
                    or f"HTTP {resp.status}"
                )
            except Exception:
                reason = f"HTTP {resp.status}"
            raise _CredentialsRejected(reason)
        resp.raise_for_status()
