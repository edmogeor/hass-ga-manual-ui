"""Tests for hass_ga_manual_ui/config_flow.py."""

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import voluptuous as vol
from hass_ga_manual_ui.config_flow import (
    GoogleAssistantManualConfigFlow,
    _is_valid_project_id,
    _parse_service_account_json,
)
from hass_ga_manual_ui.const import (
    CONF_CLIENT_EMAIL,
    CONF_MIGRATE_YAML,
    CONF_PRIVATE_KEY,
    CONF_PROJECT_ID,
    CONF_SERVICE_ACCOUNT,
)

from .conftest import (
    INVALID_JSON_STRING,
    SERVICE_ACCOUNT_EMPTY,
    SERVICE_ACCOUNT_JSON_ARRAY,
    SERVICE_ACCOUNT_NO_CLIENT_EMAIL,
    SERVICE_ACCOUNT_NO_PRIVATE_KEY,
    SERVICE_ACCOUNT_WRONG_TYPES,
    VALID_SERVICE_ACCOUNT_JSON,
)

# =============================================================================
# _is_valid_project_id
# =============================================================================


class TestIsValidProjectId:
    """Test the GCP project ID validator."""

    def test_valid_ids(self) -> None:
        """Valid GCP project IDs."""
        valid = [
            "my-project",
            "my-project-123",
            "abcdef",  # exactly 6 chars
            "a" * 30,  # exactly 30 chars
            "test-project",
            "project1",
            "a1b2c3",
            "hello-world-test",
        ]
        for vid in valid:
            assert _is_valid_project_id(vid), f"Expected valid: '{vid}'"

    def test_empty_string(self) -> None:
        assert not _is_valid_project_id("")

    def test_none_value(self) -> None:
        """None or falsy values."""
        assert not _is_valid_project_id(None)  # type: ignore[arg-type]
        assert not _is_valid_project_id(False)  # type: ignore[arg-type]

    def test_too_short(self) -> None:
        """Less than 6 characters."""
        invalid = ["", "a", "ab", "abc", "abcd", "abcde"]
        for vid in invalid:
            assert not _is_valid_project_id(vid), (
                f"Expected invalid (too short): '{vid}'"
            )

    def test_too_long(self) -> None:
        """More than 30 characters."""
        assert not _is_valid_project_id("a" * 31)

    def test_starts_with_non_letter(self) -> None:
        """Must start with a letter."""
        invalid = ["1project", "-project", "0test", "123abc"]
        for vid in invalid:
            assert not _is_valid_project_id(vid), f"Expected invalid: '{vid}'"

    def test_ends_with_hyphen(self) -> None:
        """Must not end with a hyphen."""
        assert not _is_valid_project_id("my-project-")
        assert not _is_valid_project_id("a-")

    def test_uppercase_characters(self) -> None:
        """Must be lowercase only."""
        invalid = [
            "My-Project",
            "MY-PROJECT",
            "testProject",
            "Test-Project",
        ]
        for vid in invalid:
            assert not _is_valid_project_id(vid), (
                f"Expected invalid (uppercase): '{vid}'"
            )

    def test_invalid_characters(self) -> None:
        """Characters other than lowercase letters, digits, and hyphens."""
        invalid = [
            "my_project",
            "my project",
            "test@project",
            "project#1",
            "test/project",
            "project.test",
        ]
        for vid in invalid:
            assert not _is_valid_project_id(vid), (
                f"Expected invalid (bad chars): '{vid}'"
            )

    def test_only_digits(self) -> None:
        """All digits should fail because it must start with a letter."""
        assert not _is_valid_project_id("123456")

    def test_only_hyphens(self) -> None:
        """All hyphens should fail because it must start with a letter."""
        assert not _is_valid_project_id("------")


# =============================================================================
# _parse_service_account_json
# =============================================================================


class TestParseServiceAccountJson:
    """Test service account JSON parsing."""

    def test_valid_json(self) -> None:
        result = _parse_service_account_json(VALID_SERVICE_ACCOUNT_JSON)
        assert result == {
            CONF_CLIENT_EMAIL: "test@test-project.iam.gserviceaccount.com",
            CONF_PRIVATE_KEY: (
                "-----BEGIN PRIVATE KEY-----\n"
                "MIIEvQIBADANBgkqhkiG9w0BAQE...\n"
                "-----END PRIVATE KEY-----\n"
            ),
        }

    def test_minimal_valid_json(self) -> None:
        """Minimal JSON with only required fields."""
        minimal = json.dumps(
            {
                "client_email": "minimal@test.iam.gserviceaccount.com",
                "private_key": "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----\n",
            }
        )
        result = _parse_service_account_json(minimal)
        assert result[CONF_CLIENT_EMAIL] == "minimal@test.iam.gserviceaccount.com"
        assert "-----BEGIN PRIVATE KEY-----" in result[CONF_PRIVATE_KEY]

    def test_missing_client_email(self) -> None:
        with pytest.raises(vol.Invalid, match="client_email"):
            _parse_service_account_json(SERVICE_ACCOUNT_NO_CLIENT_EMAIL)

    def test_missing_private_key(self) -> None:
        with pytest.raises(vol.Invalid, match="private_key"):
            _parse_service_account_json(SERVICE_ACCOUNT_NO_PRIVATE_KEY)

    def test_empty_object(self) -> None:
        with pytest.raises(vol.Invalid, match="Missing required fields"):
            _parse_service_account_json(SERVICE_ACCOUNT_EMPTY)

    def test_invalid_json(self) -> None:
        with pytest.raises(vol.Invalid, match="Invalid JSON"):
            _parse_service_account_json(INVALID_JSON_STRING)

    def test_array_instead_of_object(self) -> None:
        with pytest.raises(vol.Invalid, match="JSON object"):
            _parse_service_account_json(SERVICE_ACCOUNT_JSON_ARRAY)

    def test_null_client_email(self) -> None:
        """null value counts as missing."""
        bad = '{"client_email": null, "private_key": "key"}'
        with pytest.raises(vol.Invalid, match="client_email"):
            _parse_service_account_json(bad)

    def test_empty_string_client_email(self) -> None:
        """Empty string counts as missing."""
        bad = '{"client_email": "", "private_key": "key"}'
        with pytest.raises(vol.Invalid, match="client_email"):
            _parse_service_account_json(bad)

    def test_empty_string_private_key(self) -> None:
        bad = '{"client_email": "test@test.com", "private_key": ""}'
        with pytest.raises(vol.Invalid, match="private_key"):
            _parse_service_account_json(bad)

    def test_wrong_types_raise_invalid(self) -> None:
        """Non-string values should raise."""
        with pytest.raises(vol.Invalid, match="must be a string"):
            _parse_service_account_json(SERVICE_ACCOUNT_WRONG_TYPES)

    def test_client_email_is_int(self) -> None:
        bad = '{"client_email": 42, "private_key": "key"}'
        with pytest.raises(vol.Invalid, match="must be a string"):
            _parse_service_account_json(bad)

    def test_private_key_is_int(self) -> None:
        bad = '{"client_email": "test@test.com", "private_key": 99}'
        with pytest.raises(vol.Invalid, match="must be a string"):
            _parse_service_account_json(bad)

    def test_extra_fields_ignored(self) -> None:
        """Extra fields should be silently ignored."""
        extra = json.dumps(
            {
                "client_email": "test@test.iam.gserviceaccount.com",
                "private_key": "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----\n",
                "type": "service_account",
                "project_id": "my-project",
                "token_uri": "https://example.com",
            }
        )
        result = _parse_service_account_json(extra)
        assert result[CONF_CLIENT_EMAIL] == "test@test.iam.gserviceaccount.com"


# =============================================================================
# GoogleAssistantManualConfigFlow
# =============================================================================


@pytest.fixture
def config_flow() -> GoogleAssistantManualConfigFlow:
    """Return a fresh config flow instance."""
    return GoogleAssistantManualConfigFlow()


class TestConfigFlowUserStep:
    """Test the initial 'user' step of the config flow."""

    @pytest.mark.asyncio
    async def test_shows_form_on_first_load(
        self, config_flow: GoogleAssistantManualConfigFlow
    ) -> None:
        result = await config_flow.async_step_user()
        assert result["type"] == "form"
        assert result["step_id"] == "user"
        assert "project_id" in result["data_schema"].schema

    @pytest.mark.asyncio
    async def test_empty_project_id_shows_error(
        self, config_flow: GoogleAssistantManualConfigFlow
    ) -> None:
        result = await config_flow.async_step_user({CONF_PROJECT_ID: ""})
        assert result["type"] == "form"
        assert result["errors"] == {CONF_PROJECT_ID: "project_id_required"}

    @pytest.mark.asyncio
    async def test_whitespace_only_project_id_shows_error(
        self, config_flow: GoogleAssistantManualConfigFlow
    ) -> None:
        result = await config_flow.async_step_user({CONF_PROJECT_ID: "   "})
        assert result["type"] == "form"
        assert result["errors"] == {CONF_PROJECT_ID: "project_id_required"}

    @pytest.mark.asyncio
    async def test_invalid_project_id_shows_error(
        self, config_flow: GoogleAssistantManualConfigFlow
    ) -> None:
        result = await config_flow.async_step_user({CONF_PROJECT_ID: "Ab"})
        assert result["type"] == "form"
        assert result["errors"] == {CONF_PROJECT_ID: "invalid_project_id"}

    @pytest.mark.asyncio
    async def test_valid_project_id_advances_to_service_account(
        self, config_flow: GoogleAssistantManualConfigFlow
    ) -> None:
        # Override async_step_service_account to return a form
        config_flow.async_step_service_account = AsyncMock(  # type: ignore[method-assign]
            return_value={"type": "form", "step_id": "service_account"}
        )
        result = await config_flow.async_step_user({CONF_PROJECT_ID: "my-project-123"})
        # Should call async_step_service_account
        config_flow.async_step_service_account.assert_awaited_once()
        assert result["step_id"] == "service_account"

    @pytest.mark.asyncio
    async def test_project_id_stored_in_data(
        self, config_flow: GoogleAssistantManualConfigFlow
    ) -> None:
        config_flow.async_step_service_account = AsyncMock(  # type: ignore[method-assign]
            return_value={"type": "form", "step_id": "service_account"}
        )
        await config_flow.async_step_user({CONF_PROJECT_ID: "my-test-project"})
        assert config_flow._data[CONF_PROJECT_ID] == "my-test-project"

    @pytest.mark.asyncio
    async def test_project_id_stripped_of_whitespace(
        self, config_flow: GoogleAssistantManualConfigFlow
    ) -> None:
        config_flow.async_step_service_account = AsyncMock(  # type: ignore[method-assign]
            return_value={"type": "form", "step_id": "service_account"}
        )
        await config_flow.async_step_user({CONF_PROJECT_ID: "  my-project  "})
        assert config_flow._data[CONF_PROJECT_ID] == "my-project"


def _schema_has(result: dict, key: str) -> bool:
    """Whether a vol marker named ``key`` is present in a form's data_schema."""
    return any(str(k) == key for k in result["data_schema"].schema)


class TestConfigFlowYamlMigration:
    """The migrate-YAML checkbox appears only when a google_assistant: block exists."""

    @pytest.mark.asyncio
    async def test_no_checkbox_without_yaml(
        self, config_flow: GoogleAssistantManualConfigFlow
    ) -> None:
        config_flow._read_ga_yaml = AsyncMock(return_value=None)  # type: ignore[method-assign]
        result = await config_flow.async_step_user()
        assert not _schema_has(result, CONF_MIGRATE_YAML)

    @pytest.mark.asyncio
    async def test_checkbox_shown_with_yaml(
        self, config_flow: GoogleAssistantManualConfigFlow
    ) -> None:
        config_flow._read_ga_yaml = AsyncMock(  # type: ignore[method-assign]
            return_value={CONF_PROJECT_ID: "yaml-project-1"}
        )
        config_flow._yaml_notice = AsyncMock(return_value="")  # type: ignore[method-assign]
        result = await config_flow.async_step_user()
        assert _schema_has(result, CONF_MIGRATE_YAML)

    @pytest.mark.asyncio
    async def test_project_id_prefilled_from_yaml(
        self, config_flow: GoogleAssistantManualConfigFlow
    ) -> None:
        config_flow._read_ga_yaml = AsyncMock(  # type: ignore[method-assign]
            return_value={CONF_PROJECT_ID: "yaml-project-1"}
        )
        config_flow._yaml_notice = AsyncMock(return_value="")  # type: ignore[method-assign]
        result = await config_flow.async_step_user()
        marker = next(
            k for k in result["data_schema"].schema if str(k) == CONF_PROJECT_ID
        )
        assert marker.default() == "yaml-project-1"

    @pytest.mark.asyncio
    async def test_migrate_flag_stored_when_yaml_present(
        self, config_flow: GoogleAssistantManualConfigFlow
    ) -> None:
        config_flow._read_ga_yaml = AsyncMock(  # type: ignore[method-assign]
            return_value={CONF_PROJECT_ID: "yaml-project-1"}
        )
        config_flow.async_step_service_account = AsyncMock(  # type: ignore[method-assign]
            return_value={"type": "form", "step_id": "service_account"}
        )
        await config_flow.async_step_user(
            {CONF_PROJECT_ID: "my-project-123", CONF_MIGRATE_YAML: False}
        )
        assert config_flow._data[CONF_MIGRATE_YAML] is False

    @pytest.mark.asyncio
    async def test_migrate_flag_absent_without_yaml(
        self, config_flow: GoogleAssistantManualConfigFlow
    ) -> None:
        config_flow._read_ga_yaml = AsyncMock(return_value=None)  # type: ignore[method-assign]
        config_flow.async_step_service_account = AsyncMock(  # type: ignore[method-assign]
            return_value={"type": "form", "step_id": "service_account"}
        )
        await config_flow.async_step_user({CONF_PROJECT_ID: "my-project-123"})
        assert CONF_MIGRATE_YAML not in config_flow._data


class TestConfigFlowServiceAccountStep:
    """Test the 'service_account' step of the config flow."""

    @pytest.mark.asyncio
    async def test_shows_form_on_first_load(
        self, config_flow: GoogleAssistantManualConfigFlow
    ) -> None:
        config_flow._data[CONF_PROJECT_ID] = "test-project"
        result = await config_flow.async_step_service_account()
        assert result["type"] == "form"
        assert result["step_id"] == "service_account"

    @pytest.mark.asyncio
    async def test_empty_input_shows_error(
        self, config_flow: GoogleAssistantManualConfigFlow
    ) -> None:
        config_flow._data[CONF_PROJECT_ID] = "test-project"
        result = await config_flow.async_step_service_account(
            {CONF_SERVICE_ACCOUNT: ""}
        )
        assert result["errors"] == {CONF_SERVICE_ACCOUNT: "service_account_required"}

    @pytest.mark.asyncio
    async def test_whitespace_only_shows_error(
        self, config_flow: GoogleAssistantManualConfigFlow
    ) -> None:
        config_flow._data[CONF_PROJECT_ID] = "test-project"
        result = await config_flow.async_step_service_account(
            {CONF_SERVICE_ACCOUNT: "   "}
        )
        assert result["errors"] == {CONF_SERVICE_ACCOUNT: "service_account_required"}

    @pytest.mark.asyncio
    async def test_invalid_json_shows_error(
        self, config_flow: GoogleAssistantManualConfigFlow
    ) -> None:
        config_flow._data[CONF_PROJECT_ID] = "test-project"
        result = await config_flow.async_step_service_account(
            {CONF_SERVICE_ACCOUNT: INVALID_JSON_STRING}
        )
        assert result["type"] == "form"
        assert CONF_SERVICE_ACCOUNT in result["errors"]
        assert "Invalid JSON" in result["errors"][CONF_SERVICE_ACCOUNT]

    @pytest.mark.asyncio
    async def test_missing_fields_shows_error(
        self, config_flow: GoogleAssistantManualConfigFlow
    ) -> None:
        config_flow._data[CONF_PROJECT_ID] = "test-project"
        result = await config_flow.async_step_service_account(
            {CONF_SERVICE_ACCOUNT: SERVICE_ACCOUNT_EMPTY}
        )
        assert result["type"] == "form"
        error = result["errors"][CONF_SERVICE_ACCOUNT]
        assert "Missing required fields" in error

    @pytest.mark.asyncio
    async def test_valid_json_creates_entry(
        self, config_flow: GoogleAssistantManualConfigFlow
    ) -> None:
        config_flow._data[CONF_PROJECT_ID] = "test-project"
        config_flow.async_create_entry = MagicMock(
            return_value={"type": "create_entry"}
        )  # type: ignore[method-assign]
        await config_flow.async_step_service_account(
            {CONF_SERVICE_ACCOUNT: VALID_SERVICE_ACCOUNT_JSON}
        )
        config_flow.async_create_entry.assert_called_once()
        call_args = config_flow.async_create_entry.call_args
        assert call_args[1]["title"] == "test-project"
        assert CONF_PROJECT_ID in call_args[1]["data"]
        assert CONF_SERVICE_ACCOUNT in call_args[1]["data"]

    @pytest.mark.asyncio
    async def test_service_account_stored_in_data(
        self, config_flow: GoogleAssistantManualConfigFlow
    ) -> None:
        config_flow._data[CONF_PROJECT_ID] = "test-project"
        config_flow.async_create_entry = MagicMock(
            return_value={"type": "create_entry"}
        )  # type: ignore[method-assign]
        await config_flow.async_step_service_account(
            {CONF_SERVICE_ACCOUNT: VALID_SERVICE_ACCOUNT_JSON}
        )
        sa = config_flow._data[CONF_SERVICE_ACCOUNT]
        assert sa[CONF_CLIENT_EMAIL] == "test@test-project.iam.gserviceaccount.com"
        assert "-----BEGIN PRIVATE KEY-----" in sa[CONF_PRIVATE_KEY]

    @pytest.mark.asyncio
    async def test_flows_independent_data(self) -> None:
        """Ensure each flow instance has independent _data."""
        flow1 = GoogleAssistantManualConfigFlow()
        flow2 = GoogleAssistantManualConfigFlow()

        flow1.async_step_service_account = AsyncMock(return_value={"type": "form"})  # type: ignore[method-assign]
        flow2.async_step_service_account = AsyncMock(return_value={"type": "form"})  # type: ignore[method-assign]

        await flow1.async_step_user({CONF_PROJECT_ID: "project-one"})
        await flow2.async_step_user({CONF_PROJECT_ID: "project-two"})

        assert flow1._data[CONF_PROJECT_ID] == "project-one"
        assert flow2._data[CONF_PROJECT_ID] == "project-two"

    @pytest.mark.asyncio
    async def test_description_placeholders_in_user_step(
        self, config_flow: GoogleAssistantManualConfigFlow
    ) -> None:
        result = await config_flow.async_step_user()
        assert "description_placeholders" in result
        assert "guide_url" in result["description_placeholders"]
        assert "yaml_notice" in result["description_placeholders"]

    @pytest.mark.asyncio
    async def test_yaml_notice_shown_when_yaml_present(
        self, config_flow: GoogleAssistantManualConfigFlow
    ) -> None:
        """When configuration.yaml has google_assistant:, the notice is injected."""
        config_flow.hass = MagicMock()
        config_flow.hass.config.language = "en"
        with (
            patch(
                "hass_ga_manual_ui.config_flow.async_hass_config_yaml",
                AsyncMock(return_value={"google_assistant": {}}),
            ),
            patch(
                "hass_ga_manual_ui.config_flow.async_load_locale",
                AsyncMock(return_value={"yaml_notice": "REMOVE IT"}),
            ),
        ):
            result = await config_flow.async_step_user()
        assert result["description_placeholders"]["yaml_notice"] == "REMOVE IT"

    @pytest.mark.asyncio
    async def test_yaml_notice_empty_when_absent(
        self, config_flow: GoogleAssistantManualConfigFlow
    ) -> None:
        """No google_assistant: section => empty notice (no translation lookup)."""
        config_flow.hass = MagicMock()
        with (
            patch(
                "hass_ga_manual_ui.config_flow.async_hass_config_yaml",
                AsyncMock(return_value={"sensor": {}}),
            ),
            patch(
                "hass_ga_manual_ui.config_flow.async_load_locale",
                AsyncMock(),
            ) as mock_locale,
        ):
            result = await config_flow.async_step_user()
        assert result["description_placeholders"]["yaml_notice"] == ""
        mock_locale.assert_not_called()

    @pytest.mark.asyncio
    async def test_yaml_notice_empty_when_yaml_unreadable(
        self, config_flow: GoogleAssistantManualConfigFlow
    ) -> None:
        """A malformed/unreadable configuration.yaml degrades to an empty notice."""
        config_flow.hass = MagicMock()
        with patch(
            "hass_ga_manual_ui.config_flow.async_hass_config_yaml",
            AsyncMock(side_effect=OSError("boom")),
        ):
            result = await config_flow.async_step_user()
        assert result["description_placeholders"]["yaml_notice"] == ""

    @pytest.mark.asyncio
    async def test_yaml_notice_detects_suffixed_domain_key(
        self, config_flow: GoogleAssistantManualConfigFlow
    ) -> None:
        """Split config keys like 'google_assistant 2:' are also detected."""
        config_flow.hass = MagicMock()
        config_flow.hass.config.language = "en"
        with (
            patch(
                "hass_ga_manual_ui.config_flow.async_hass_config_yaml",
                AsyncMock(return_value={"google_assistant 2": {}}),
            ),
            patch(
                "hass_ga_manual_ui.config_flow.async_load_locale",
                AsyncMock(return_value={"yaml_notice": "REMOVE IT"}),
            ),
        ):
            result = await config_flow.async_step_user()
        assert result["description_placeholders"]["yaml_notice"] == "REMOVE IT"

    @pytest.mark.asyncio
    async def test_description_placeholders_in_service_account_step(
        self, config_flow: GoogleAssistantManualConfigFlow
    ) -> None:
        config_flow._data[CONF_PROJECT_ID] = "test-project"
        result = await config_flow.async_step_service_account()
        assert "description_placeholders" in result
        assert "docs_url" in result["description_placeholders"]
        assert "guide_url" in result["description_placeholders"]

    @pytest.mark.asyncio
    async def test_raw_input_stripped(
        self, config_flow: GoogleAssistantManualConfigFlow
    ) -> None:
        """Whitespace around valid JSON is stripped before parsing."""
        config_flow._data[CONF_PROJECT_ID] = "test-project"
        config_flow.async_create_entry = MagicMock(
            return_value={"type": "create_entry"}
        )  # type: ignore[method-assign]
        padded = f"  {VALID_SERVICE_ACCOUNT_JSON}  "
        await config_flow.async_step_service_account({CONF_SERVICE_ACCOUNT: padded})
        config_flow.async_create_entry.assert_called_once()


class TestNotifyInstalled:
    """Tests for the post-install 'refresh your browser' notification."""

    @pytest.mark.asyncio
    async def test_posts_localized_notification(
        self, config_flow: GoogleAssistantManualConfigFlow
    ) -> None:
        """A localized install_notice is posted as a persistent notification."""
        config_flow.hass = MagicMock()
        config_flow.hass.config.language = "en"
        with (
            patch(
                "hass_ga_manual_ui.config_flow.async_load_locale",
                AsyncMock(return_value={"install_notice": "REFRESH NOW"}),
            ),
            patch(
                "hass_ga_manual_ui.config_flow.async_get_translations",
                AsyncMock(return_value={}),
            ),
            patch(
                "homeassistant.components.persistent_notification.async_create"
            ) as mock_create,
        ):
            await config_flow._notify_installed()
        mock_create.assert_called_once()
        assert mock_create.call_args.args[1] == "REFRESH NOW"
        assert (
            mock_create.call_args.kwargs["notification_id"]
            == "hass_ga_manual_ui_install"
        )

    @pytest.mark.asyncio
    async def test_falls_back_to_english_when_untranslated(
        self, config_flow: GoogleAssistantManualConfigFlow
    ) -> None:
        """With no translation, the English fallback text is used."""
        config_flow.hass = MagicMock()
        config_flow.hass.config.language = "en"
        with (
            patch(
                "hass_ga_manual_ui.config_flow.async_load_locale",
                AsyncMock(return_value={}),
            ),
            patch(
                "hass_ga_manual_ui.config_flow.async_get_translations",
                AsyncMock(return_value={}),
            ),
            patch(
                "homeassistant.components.persistent_notification.async_create"
            ) as mock_create,
        ):
            await config_flow._notify_installed()
        mock_create.assert_called_once()
        assert "hard refresh" in mock_create.call_args.args[1]

    @pytest.mark.asyncio
    async def test_translation_failure_still_notifies(
        self, config_flow: GoogleAssistantManualConfigFlow
    ) -> None:
        """A failure loading the locale degrades to the fallback, still posting."""
        config_flow.hass = MagicMock()
        config_flow.hass.config.language = "en"
        with (
            patch(
                "hass_ga_manual_ui.config_flow.async_load_locale",
                AsyncMock(side_effect=RuntimeError("locale down")),
            ),
            patch(
                "hass_ga_manual_ui.config_flow.async_get_translations",
                AsyncMock(return_value={}),
            ),
            patch(
                "homeassistant.components.persistent_notification.async_create"
            ) as mock_create,
        ):
            await config_flow._notify_installed()
        mock_create.assert_called_once()

    @pytest.mark.asyncio
    async def test_noop_without_hass(
        self, config_flow: GoogleAssistantManualConfigFlow
    ) -> None:
        """Without hass (e.g. a bare flow), it silently does nothing."""
        with patch(
            "homeassistant.components.persistent_notification.async_create"
        ) as mock_create:
            await config_flow._notify_installed()
        mock_create.assert_not_called()
