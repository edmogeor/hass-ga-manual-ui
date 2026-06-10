"""Shared test fixtures for google_assistant_manual tests."""

import sys
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest
from homeassistant.components import websocket_api
from homeassistant.config_entries import ConfigEntry

# Ensure our integration is importable
sys.path.insert(0, str(Path(__file__).parent.parent / "custom_components"))
sys.path.insert(0, str(Path(__file__).parent.parent))

from google_assistant_manual.const import (  # noqa: E402
    CONF_CLIENT_EMAIL,
    CONF_PRIVATE_KEY,
    CONF_PROJECT_ID,
    CONF_REPORT_STATE,
    CONF_SECURE_DEVICES_PIN,
    CONF_SERVICE_ACCOUNT,
    DOMAIN,
)

# ---------------------------------------------------------------------------
# Mock ConfigEntry factory
# ---------------------------------------------------------------------------


def mock_config_entry(
    project_id: str = "test-project-123",
    client_email: str = "test@test-project.iam.gserviceaccount.com",
    private_key: str = "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n",
    entry_id: str = "abc123",
    options: dict[str, Any] | None = None,
    runtime_data: Any = None,
) -> MagicMock:
    """Create a MagicMock that quacks like a ConfigEntry."""
    entry = MagicMock(spec=ConfigEntry)
    entry.entry_id = entry_id
    entry.domain = DOMAIN
    entry.title = project_id
    entry.data = {
        CONF_PROJECT_ID: project_id,
        CONF_SERVICE_ACCOUNT: {
            CONF_CLIENT_EMAIL: client_email,
            CONF_PRIVATE_KEY: private_key,
        },
    }
    entry.options = options or {
        "enabled": False,
        CONF_REPORT_STATE: False,
        CONF_SECURE_DEVICES_PIN: "",
    }
    entry.runtime_data = runtime_data
    entry.source = "user"
    entry.version = 1
    entry.minor_version = 1
    entry.disabled_by = None
    entry.pref_disable_new_entities = False
    entry.pref_disable_polling = False
    entry.unique_id = None
    return entry


def mock_config_entry_minimal(
    project_id: str = "minimal-project",
) -> MagicMock:
    """Create a ConfigEntry mock with minimal data (no service_account)."""
    entry = MagicMock(spec=ConfigEntry)
    entry.entry_id = "minimal-1"
    entry.domain = DOMAIN
    entry.title = project_id
    entry.data = {
        CONF_PROJECT_ID: project_id,
    }
    entry.options = {"enabled": True}
    entry.runtime_data = None
    entry.source = "user"
    return entry


# ---------------------------------------------------------------------------
# Mock WebSocket connection
# ---------------------------------------------------------------------------


def mock_ws_connection() -> MagicMock:
    """Create a mock WebSocket connection."""
    conn = MagicMock(spec=websocket_api.ActiveConnection)
    conn.send_result = MagicMock()
    conn.send_error = MagicMock()
    return conn


# ---------------------------------------------------------------------------
# Mock GoogleConfig
# ---------------------------------------------------------------------------


class FakeGoogleConfig:
    """Fake GoogleConfig for testing property patches."""

    def __init__(
        self,
        report_state: bool = True,
        pin: str | None = None,
        hass: object | None = None,
        exposed: set[str] | None = None,
    ) -> None:
        self._report_state = report_state
        self._pin = pin
        self.hass = hass
        self._exposed = exposed or set()

    @property
    def should_report_state(self) -> bool:
        return self._report_state

    @property
    def secure_devices_pin(self) -> str | None:
        return self._pin

    def should_expose(self, entity_id: str) -> bool:
        """Legacy core-style exposure check (the pre-patch behavior)."""
        return entity_id in self._exposed

    def should_2fa(self, state: object) -> bool:
        """Core-style 2FA check (the pre-patch behavior: always True)."""
        return True

    def async_enable_report_state(self) -> None:
        self._report_state = True

    def async_disable_report_state(self) -> None:
        self._report_state = False

    def async_deinitialize(self) -> None:
        pass


# ---------------------------------------------------------------------------
# Service account JSON fixtures
# ---------------------------------------------------------------------------


VALID_SERVICE_ACCOUNT_JSON = """{
    "type": "service_account",
    "project_id": "test-project-123",
    "private_key_id": "abc123def456",
    "private_key": "-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkqhkiG9w0BAQE...\\n-----END PRIVATE KEY-----\\n",
    "client_email": "test@test-project.iam.gserviceaccount.com",
    "client_id": "123456789",
    "auth_uri": "https://accounts.google.com/o/oauth2/auth",
    "token_uri": "https://oauth2.googleapis.com/token"
}"""

SERVICE_ACCOUNT_NO_PRIVATE_KEY = """{
    "type": "service_account",
    "project_id": "test-project-123",
    "client_email": "test@test-project.iam.gserviceaccount.com"
}"""

SERVICE_ACCOUNT_NO_CLIENT_EMAIL = """{
    "type": "service_account",
    "project_id": "test-project-123",
    "private_key": "-----BEGIN PRIVATE KEY-----\\n...\\n-----END PRIVATE KEY-----\\n"
}"""

SERVICE_ACCOUNT_EMPTY = """{}"""

INVALID_JSON_STRING = "not json at all {{{"

SERVICE_ACCOUNT_JSON_ARRAY = """[{"client_email": "test@test.com"}]"""

SERVICE_ACCOUNT_WRONG_TYPES = """{
    "client_email": 123,
    "private_key": true
}"""


# ---------------------------------------------------------------------------
# Misc
# ---------------------------------------------------------------------------


@pytest.fixture
def reset_version_cache() -> None:
    """Reset the _VERSION cache in __init__ module."""
    import google_assistant_manual

    google_assistant_manual._VERSION = None


@pytest.fixture
def reset_original_props_cache() -> None:
    """Reset the _ORIGINAL_GOOGLE_CONFIG_PROPS cache."""
    import google_assistant_manual

    google_assistant_manual._ORIGINAL_GOOGLE_CONFIG_PROPS.clear()
