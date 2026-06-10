"""Tests for google_assistant_manual/__init__.py."""

import logging
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
import voluptuous as vol
from google_assistant_manual import (
    WS_CONFIG_SCHEMA,
    _add_assistant_to_schema,
    _build_core_config,
    _get_version,
    _make_core_entry,
    _patch_google_config_properties,
    _project_id,
    _safe_get_entry,
    _teardown_core_ga,
)
from google_assistant_manual.const import (
    ASSISTANT_ID,
    CONF_CLIENT_EMAIL,
    CONF_PROJECT_ID,
    CONF_REPORT_STATE,
    CONF_SECURE_DEVICES_PIN,
    CONF_SERVICE_ACCOUNT,
    CORE_GA_DOMAIN,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .conftest import (
    FakeGoogleConfig,
    mock_config_entry,
    mock_config_entry_minimal,
    mock_ws_connection,
)

# =============================================================================
# _project_id
# =============================================================================


class TestProjectId:
    """Tests for the _project_id helper."""

    def test_returns_project_id(self) -> None:
        entry = mock_config_entry(project_id="my-gcp-project")
        assert _project_id(entry) == "my-gcp-project"

    def test_returns_missing_when_no_project_id(self) -> None:
        entry = MagicMock(spec=ConfigEntry)
        entry.data = {}
        assert _project_id(entry) == "<missing>"

    def test_returns_missing_when_entry_data_is_empty_dict(self) -> None:
        entry = MagicMock(spec=ConfigEntry)
        entry.data = {}
        assert _project_id(entry) == "<missing>"


# =============================================================================
# _build_core_config
# =============================================================================


class TestBuildCoreConfig:
    """Tests for _build_core_config."""

    def test_full_config(self) -> None:
        entry = mock_config_entry(
            project_id="test-proj",
            client_email="sa@test.iam.gserviceaccount.com",
            private_key="-----BEGIN KEY-----\n...\n-----END KEY-----\n",
        )
        entry.options = {
            "enabled": True,
            CONF_REPORT_STATE: True,
            CONF_SECURE_DEVICES_PIN: "1234",
        }
        config = _build_core_config(entry)
        assert config[CONF_PROJECT_ID] == "test-proj"
        assert config[CONF_SERVICE_ACCOUNT][CONF_CLIENT_EMAIL] == (
            "sa@test.iam.gserviceaccount.com"
        )
        assert config[CONF_REPORT_STATE] is True
        assert config[CONF_SECURE_DEVICES_PIN] == "1234"

    def test_minimal_config_no_service_account(self) -> None:
        entry = mock_config_entry_minimal("bare-project")
        config = _build_core_config(entry)
        assert config[CONF_PROJECT_ID] == "bare-project"
        assert CONF_SERVICE_ACCOUNT not in config
        assert config[CONF_REPORT_STATE] is False

    def test_no_project_id_raises(self) -> None:
        entry = MagicMock(spec=ConfigEntry)
        entry.data = {}
        entry.options = {"enabled": True}
        with pytest.raises(ValueError, match="missing 'project_id'"):
            _build_core_config(entry)

    def test_empty_service_account_skipped(self) -> None:
        entry = mock_config_entry(project_id="test-proj")
        entry.data[CONF_SERVICE_ACCOUNT] = {}
        config = _build_core_config(entry)
        assert config[CONF_REPORT_STATE] is False

    def test_service_account_without_options_has_report_state_false(self) -> None:
        entry = mock_config_entry(project_id="test-proj")
        entry.options = {}
        config = _build_core_config(entry)
        assert config[CONF_REPORT_STATE] is False

    def test_pin_omitted_when_none(self) -> None:
        entry = mock_config_entry(project_id="test-proj")
        entry.options = {CONF_SECURE_DEVICES_PIN: None}
        config = _build_core_config(entry)
        assert CONF_SECURE_DEVICES_PIN not in config

    def test_pin_omitted_when_empty_string(self) -> None:
        entry = mock_config_entry(project_id="test-proj")
        entry.options = {CONF_SECURE_DEVICES_PIN: ""}
        config = _build_core_config(entry)
        assert CONF_SECURE_DEVICES_PIN not in config

    def test_pin_included_when_non_empty(self) -> None:
        entry = mock_config_entry(project_id="test-proj")
        entry.options = {CONF_SECURE_DEVICES_PIN: "2580"}
        config = _build_core_config(entry)
        assert config[CONF_SECURE_DEVICES_PIN] == "2580"

    def test_service_account_not_a_dict(self, caplog: pytest.LogCaptureFixture) -> None:
        entry = mock_config_entry(project_id="test-proj")
        entry.data[CONF_SERVICE_ACCOUNT] = "not-a-dict"
        with caplog.at_level(logging.WARNING):
            config = _build_core_config(entry)
        assert any("not a dict" in r.message for r in caplog.records)
        # Report state defaults to False when service_account is invalid
        assert config.get(CONF_REPORT_STATE, False) is False


# =============================================================================
# _make_core_entry
# =============================================================================


class TestMakeCoreEntry:
    """Tests for _make_core_entry."""

    def test_creates_with_correct_domain(self) -> None:
        entry = mock_config_entry(project_id="my-project")
        core_entry = _make_core_entry(entry)
        assert core_entry.domain == CORE_GA_DOMAIN

    def test_title_matches_project_id(self) -> None:
        entry = mock_config_entry(project_id="unique-project-id")
        core_entry = _make_core_entry(entry)
        assert core_entry.title == "unique-project-id"

    def test_carries_over_data(self) -> None:
        entry = mock_config_entry(
            project_id="proj",
            client_email="e@t.com",
            private_key="key-data",
        )
        core_entry = _make_core_entry(entry)
        assert core_entry.data == entry.data

    def test_entry_id_is_unique_per_call(self) -> None:
        entry = mock_config_entry()
        e1 = _make_core_entry(entry)
        e2 = _make_core_entry(entry)
        assert e1.entry_id != e2.entry_id

    def test_entry_id_is_hex_string(self) -> None:
        entry = mock_config_entry()
        core_entry = _make_core_entry(entry)
        assert len(core_entry.entry_id) == 26

    def test_source_is_system(self) -> None:
        entry = mock_config_entry()
        core_entry = _make_core_entry(entry)
        assert core_entry.source == "system"

    def test_options_are_empty_dict(self) -> None:
        entry = mock_config_entry()
        core_entry = _make_core_entry(entry)
        assert core_entry.options == {}

    def test_runtime_data_starts_unset(self) -> None:
        entry = mock_config_entry()
        core_entry = _make_core_entry(entry)
        assert not hasattr(core_entry, "runtime_data")

    def test_disabled_by_is_none(self) -> None:
        entry = mock_config_entry()
        core_entry = _make_core_entry(entry)
        assert core_entry.disabled_by is None

    def test_version_is_1(self) -> None:
        entry = mock_config_entry()
        core_entry = _make_core_entry(entry)
        assert core_entry.version == 1
        assert core_entry.minor_version == 1

    def test_pref_flags_are_false(self) -> None:
        entry = mock_config_entry()
        core_entry = _make_core_entry(entry)
        assert core_entry.pref_disable_new_entities is False
        assert core_entry.pref_disable_polling is False

    def test_result_is_config_entry(self) -> None:
        entry = mock_config_entry()
        core_entry = _make_core_entry(entry)
        assert isinstance(core_entry, ConfigEntry)


# =============================================================================
# WS_CONFIG_SCHEMA
# =============================================================================


class TestWsConfigSchema:
    """Tests for the WS_CONFIG_SCHEMA voluptuous schema."""

    def test_empty_dict_valid(self) -> None:
        result = WS_CONFIG_SCHEMA({})
        assert result == {}

    def test_report_state_true(self) -> None:
        result = WS_CONFIG_SCHEMA({CONF_REPORT_STATE: True})
        assert result[CONF_REPORT_STATE] is True

    def test_report_state_false(self) -> None:
        result = WS_CONFIG_SCHEMA({CONF_REPORT_STATE: False})
        assert result[CONF_REPORT_STATE] is False

    def test_secure_devices_pin_string(self) -> None:
        result = WS_CONFIG_SCHEMA({CONF_SECURE_DEVICES_PIN: "1234"})
        assert result[CONF_SECURE_DEVICES_PIN] == "1234"

    def test_secure_devices_pin_none(self) -> None:
        result = WS_CONFIG_SCHEMA({CONF_SECURE_DEVICES_PIN: None})
        assert result[CONF_SECURE_DEVICES_PIN] is None

    def test_both_keys_together(self) -> None:
        result = WS_CONFIG_SCHEMA(
            {
                CONF_REPORT_STATE: True,
                CONF_SECURE_DEVICES_PIN: "9876",
            }
        )
        assert result[CONF_REPORT_STATE] is True
        assert result[CONF_SECURE_DEVICES_PIN] == "9876"

    def test_invalid_report_state_type(self) -> None:
        with pytest.raises(vol.Invalid):
            WS_CONFIG_SCHEMA({CONF_REPORT_STATE: "not-bool"})

    def test_invalid_pin_type(self) -> None:
        with pytest.raises(vol.Invalid):
            WS_CONFIG_SCHEMA({CONF_SECURE_DEVICES_PIN: 1234})

    def test_unknown_keys_rejected(self) -> None:
        with pytest.raises(vol.Invalid, match="extra keys not allowed"):
            WS_CONFIG_SCHEMA({"unknown_key": "value"})


# =============================================================================
# _safe_get_entry
# =============================================================================


class TestSafeGetEntry:
    """Tests for _safe_get_entry."""

    def test_returns_entry_when_found(self) -> None:
        hass = MagicMock(spec=HomeAssistant)
        entry = mock_config_entry()
        hass.config_entries.async_get_entry = MagicMock(return_value=entry)
        conn = mock_ws_connection()

        result = _safe_get_entry(hass, "abc123", 42, conn)
        assert result is entry
        conn.send_error.assert_not_called()

    def test_sends_error_when_entry_not_found(self) -> None:
        hass = MagicMock(spec=HomeAssistant)
        hass.config_entries.async_get_entry = MagicMock(return_value=None)
        conn = mock_ws_connection()

        result = _safe_get_entry(hass, "nonexistent", 42, conn)
        assert result is None
        conn.send_error.assert_called_once()
        call_args = conn.send_error.call_args
        assert call_args[0][1] == "not_found"

    def test_sends_error_when_lookup_raises(self) -> None:
        hass = MagicMock(spec=HomeAssistant)
        hass.config_entries.async_get_entry = MagicMock(
            side_effect=RuntimeError("config system down")
        )
        conn = mock_ws_connection()

        result = _safe_get_entry(hass, "abc123", 42, conn)
        assert result is None
        conn.send_error.assert_called_once()
        call_args = conn.send_error.call_args
        assert call_args[0][1] == "internal_error"


# =============================================================================
# _add_assistant_to_schema
# =============================================================================


class TestAddAssistantToSchema:
    """Tests for the volumetric schema walker."""

    def test_adds_to_vol_in_containing_conversation(self) -> None:
        schema = vol.Schema(
            {
                "assistant": vol.In(["conversation", "cloud.alexa"]),
            }
        )
        _add_assistant_to_schema(schema, ASSISTANT_ID)
        container = schema.schema["assistant"].container
        assert ASSISTANT_ID in container
        assert "conversation" in container

    def test_does_not_add_to_vol_in_without_conversation(self) -> None:
        schema = vol.Schema(
            {
                "mode": vol.In(["single", "multi"]),
            }
        )
        _add_assistant_to_schema(schema, ASSISTANT_ID)
        container = schema.schema["mode"].container
        assert ASSISTANT_ID not in container

    def test_idempotent(self) -> None:
        schema = vol.Schema(
            {
                "assistant": vol.In(["conversation", "cloud.alexa"]),
            }
        )
        _add_assistant_to_schema(schema, ASSISTANT_ID)
        _add_assistant_to_schema(schema, ASSISTANT_ID)
        container = schema.schema["assistant"].container
        assert container.count(ASSISTANT_ID) == 1

    def test_handles_nested_schemas(self) -> None:
        inner = vol.Schema({"assistant": vol.In(["conversation"])})
        schema = vol.Schema({"outer": inner})
        _add_assistant_to_schema(schema, ASSISTANT_ID)
        container = schema.schema["outer"].schema["assistant"].container
        assert ASSISTANT_ID in container

    def test_handles_lists(self) -> None:
        schema = vol.Schema(
            {
                "items": [
                    vol.Schema({"assistant": vol.In(["conversation"])}),
                ]
            }
        )
        _add_assistant_to_schema(schema, ASSISTANT_ID)
        container = schema.schema["items"][0].schema["assistant"].container
        assert ASSISTANT_ID in container

    def test_handles_tuples(self) -> None:
        schema = vol.Schema(
            {
                "items": (
                    vol.Schema({"assistant": vol.In(["conversation"])}),
                    vol.Schema({"other": vol.In(["conversation"])}),
                )
            }
        )
        _add_assistant_to_schema(schema, ASSISTANT_ID)
        for key in schema.schema["items"]:
            assert ASSISTANT_ID in key.schema[list(key.schema.keys())[0]].container

    def test_handles_non_container_vol_in(self) -> None:
        """vol.In can exist without a .container attribute (e.g. numbers)."""
        schema = vol.Schema(
            {
                "count": vol.In([1, 2, 3]),
            }
        )
        _add_assistant_to_schema(schema, ASSISTANT_ID)

    def test_walks_nested_dicts(self) -> None:
        schema = vol.Schema(
            {
                "a": {
                    "b": {
                        "c": vol.In(["conversation", "cloud.alexa"]),
                    }
                }
            }
        )
        _add_assistant_to_schema(schema, ASSISTANT_ID)
        container = schema.schema["a"]["b"]["c"].container
        assert ASSISTANT_ID in container

    def test_schema_is_instance_of_vol_schema(self) -> None:
        schema = vol.Schema({"x": int})
        _add_assistant_to_schema(schema, ASSISTANT_ID)

    def test_non_schema_object_does_not_raise(self) -> None:
        _add_assistant_to_schema(42, ASSISTANT_ID)
        _add_assistant_to_schema("string", ASSISTANT_ID)
        _add_assistant_to_schema(None, ASSISTANT_ID)


# =============================================================================
# _get_version
# =============================================================================


class TestGetVersion:
    """Tests for _get_version."""

    def test_returns_version_from_manifest(self) -> None:
        version = _get_version()
        assert version == "0.1.0"

    def test_load_version_reads_manifest(self) -> None:
        from google_assistant_manual import _load_version

        version = _load_version()
        assert version == "0.1.0"

    def test_load_version_falls_back_on_error(self) -> None:
        from google_assistant_manual import _load_version

        with patch.object(Path, "read_text", side_effect=FileNotFoundError("missing")):
            version = _load_version()
        assert version == "unknown"


# =============================================================================
# _patch_google_config_properties
# =============================================================================


class TestPatchGoogleConfigProperties:
    """Tests for _patch_google_config_properties."""

    def test_patches_should_report_state_true(
        self, reset_original_props_cache: None
    ) -> None:
        entry = mock_config_entry()
        entry.options[CONF_REPORT_STATE] = True
        gc = FakeGoogleConfig(report_state=False)

        _patch_google_config_properties(gc, entry)
        assert gc.should_report_state is True

    def test_patches_should_report_state_false(
        self, reset_original_props_cache: None
    ) -> None:
        entry = mock_config_entry()
        entry.options[CONF_REPORT_STATE] = False
        gc = FakeGoogleConfig(report_state=True)

        _patch_google_config_properties(gc, entry)
        assert gc.should_report_state is False

    def test_patches_secure_devices_pin_set(
        self, reset_original_props_cache: None
    ) -> None:
        entry = mock_config_entry()
        entry.options[CONF_SECURE_DEVICES_PIN] = "9999"
        gc = FakeGoogleConfig(pin=None)

        _patch_google_config_properties(gc, entry)
        assert gc.secure_devices_pin == "9999"

    def test_patches_secure_devices_pin_none(
        self, reset_original_props_cache: None
    ) -> None:
        entry = mock_config_entry()
        entry.options[CONF_SECURE_DEVICES_PIN] = None
        gc = FakeGoogleConfig(pin="1234")

        _patch_google_config_properties(gc, entry)
        assert gc.secure_devices_pin is None

    def test_second_instance_uses_original_getters(
        self, reset_original_props_cache: None
    ) -> None:
        """Second GoogleConfig instance should still use original properties."""
        entry = mock_config_entry()
        entry.options[CONF_REPORT_STATE] = False

        gc1 = FakeGoogleConfig(report_state=True)
        _patch_google_config_properties(gc1, entry)
        assert gc1.should_report_state is False

        gc2 = FakeGoogleConfig(report_state=True)
        _patch_google_config_properties(gc2, entry)
        # gc2 is a separate instance, not the patched one, so its
        # class-level property reads from entry.options for gc2
        assert gc2.should_report_state is False

    def test_non_patched_instance_uses_original_getter(
        self, reset_original_props_cache: None
    ) -> None:
        """A different FakeGoogleConfig instance uses original property."""
        entry = mock_config_entry()
        entry.options[CONF_REPORT_STATE] = True
        gc_patched = FakeGoogleConfig(report_state=False)
        _patch_google_config_properties(gc_patched, entry)

        # A different instance that's NOT the patched one should fall back
        # to the original getter (since self is not gc_patched)
        gc_other = FakeGoogleConfig(report_state=False)
        # The property is patched at class level, so the fallback getter
        # reads the original value from gc_other._report_state
        assert gc_other.should_report_state is False

    def test_missing_should_report_state_property_handled(
        self, reset_original_props_cache: None
    ) -> None:
        """GoogleConfig without should_report_state property should be handled."""

        class MinimalGC:
            pass

        entry = mock_config_entry()
        gc = MinimalGC()
        _patch_google_config_properties(gc, entry)

    def test_missing_secure_devices_pin_property_handled(
        self, reset_original_props_cache: None
    ) -> None:
        """GoogleConfig without secure_devices_pin property should be handled."""

        class MinimalGC:
            pass

        entry = mock_config_entry()
        gc = MinimalGC()
        _patch_google_config_properties(gc, entry)

    def test_class_property_patched_for_patched_instance(
        self, reset_original_props_cache: None
    ) -> None:
        """The patched instance's class gets the property override."""
        entry = mock_config_entry()
        entry.options[CONF_REPORT_STATE] = True
        gc = FakeGoogleConfig(report_state=False)

        _patch_google_config_properties(gc, entry)

        # The patched instance reads from entry.options
        assert gc.should_report_state is True

    def test_patch_failure_logged(
        self, reset_original_props_cache: None, caplog: pytest.LogCaptureFixture
    ) -> None:
        """Failure to set properties should be logged."""

        class FrozenMeta(type):
            def __setattr__(cls, name: str, value: object) -> None:
                raise AttributeError(f"Cannot set class attribute {name}")

        class FrozenGC(metaclass=FrozenMeta):
            @property
            def should_report_state(self) -> bool:
                return True

            @property
            def secure_devices_pin(self) -> str | None:
                return None

        entry = mock_config_entry()
        gc = FrozenGC()

        caplog.set_level(logging.ERROR)
        _patch_google_config_properties(gc, entry)

        assert any("will require a full reload" in r.message for r in caplog.records), (
            f"Logs: {[r.message for r in caplog.records]}"
        )


# =============================================================================
# _teardown_core_ga
# =============================================================================


class TestTeardownCoreGa:
    """Tests for _teardown_core_ga."""

    async def test_teardown_with_no_runtime_data(self) -> None:
        hass = MagicMock(spec=HomeAssistant)
        entry = mock_config_entry(runtime_data=None)
        await _teardown_core_ga(hass, entry)
        # Should not raise, and entry.runtime_data stays None

    async def test_teardown_with_non_dict_runtime(self) -> None:
        hass = MagicMock(spec=HomeAssistant)
        entry = mock_config_entry(runtime_data="not-a-dict")
        await _teardown_core_ga(hass, entry)
        assert entry.runtime_data is None

    async def test_teardown_calls_async_deinitialize(self) -> None:
        hass = MagicMock(spec=HomeAssistant)
        gc = FakeGoogleConfig()
        gc.async_deinitialize = MagicMock()  # type: ignore[method-assign]
        entry = mock_config_entry(
            runtime_data={
                "google_config": gc,
                "registered_routes": [],
            }
        )
        # Mock async_update_entry
        hass.config_entries.async_update_entry = MagicMock()

        await _teardown_core_ga(hass, entry)
        gc.async_deinitialize.assert_called_once()

    async def test_teardown_removes_routes(self) -> None:
        hass = MagicMock(spec=HomeAssistant)
        mock_route = MagicMock()
        hass.http.app.router._routes = [mock_route]

        gc = FakeGoogleConfig()
        entry = mock_config_entry(
            runtime_data={
                "google_config": gc,
                "registered_routes": [mock_route],
            }
        )
        hass.config_entries.async_update_entry = MagicMock()

        await _teardown_core_ga(hass, entry)
        assert mock_route not in hass.http.app.router._routes

    async def test_teardown_sets_runtime_data_to_none(self) -> None:
        hass = MagicMock(spec=HomeAssistant)
        gc = FakeGoogleConfig()
        entry = mock_config_entry(
            runtime_data={
                "google_config": gc,
                "registered_routes": [],
            }
        )
        hass.config_entries.async_update_entry = MagicMock()

        await _teardown_core_ga(hass, entry)
        assert entry.runtime_data is None

    async def test_teardown_sets_enabled_false(self) -> None:
        hass = MagicMock(spec=HomeAssistant)
        gc = FakeGoogleConfig()
        entry = mock_config_entry(
            runtime_data={
                "google_config": gc,
                "registered_routes": [],
            }
        )
        entry.options["enabled"] = True
        hass.config_entries.async_update_entry = MagicMock()

        await _teardown_core_ga(hass, entry)
        call_args = hass.config_entries.async_update_entry.call_args
        assert call_args[1]["options"]["enabled"] is False

    async def test_teardown_handles_deinitialize_failure(self) -> None:
        hass = MagicMock(spec=HomeAssistant)
        gc = FakeGoogleConfig()
        gc.async_deinitialize = MagicMock(  # type: ignore[method-assign]
            side_effect=RuntimeError("deinit failed")
        )
        entry = mock_config_entry(
            runtime_data={
                "google_config": gc,
                "registered_routes": [],
            }
        )
        hass.config_entries.async_update_entry = MagicMock()

        await _teardown_core_ga(hass, entry)
        assert entry.runtime_data is None

    async def test_teardown_handles_route_removal_failure(self) -> None:
        hass = MagicMock(spec=HomeAssistant)
        gc = FakeGoogleConfig()

        class BadRoute:
            pass

        bad_route = BadRoute()
        hass.http.app.router._routes = [bad_route]

        entry = mock_config_entry(
            runtime_data={
                "google_config": gc,
                "registered_routes": [bad_route],
            }
        )
        hass.config_entries.async_update_entry = MagicMock()

        await _teardown_core_ga(hass, entry)

    async def test_teardown_without_google_config(self) -> None:
        """Runtime data can exist without a google_config key."""
        hass = MagicMock(spec=HomeAssistant)
        entry = mock_config_entry(
            runtime_data={
                "registered_routes": [],
            }
        )
        hass.config_entries.async_update_entry = MagicMock()
        await _teardown_core_ga(hass, entry)
        assert entry.runtime_data is None


# =============================================================================
# _patch_core_assistants
# =============================================================================


class TestPatchCoreAssistants:
    """Tests for _patch_core_assistants."""

    def test_patches_known_assistants(self) -> None:
        """Test KNOWN_ASSISTANTS tuple is patched."""
        import homeassistant.components.homeassistant.exposed_entities as ee
        from google_assistant_manual import _patch_core_assistants

        original = ee.KNOWN_ASSISTANTS

        try:
            # Remove our ID if it's already there
            if ASSISTANT_ID in ee.KNOWN_ASSISTANTS:
                ee.KNOWN_ASSISTANTS = tuple(
                    x for x in ee.KNOWN_ASSISTANTS if x != ASSISTANT_ID
                )

            hass = MagicMock(spec=HomeAssistant)
            hass.data = {"websocket_api": {}}  # empty handlers = skip WS patching

            _patch_core_assistants(hass)

            assert ASSISTANT_ID in ee.KNOWN_ASSISTANTS
        finally:
            ee.KNOWN_ASSISTANTS = original

    def test_idempotent(self) -> None:
        """Calling twice doesn't add duplicate."""
        import homeassistant.components.homeassistant.exposed_entities as ee
        from google_assistant_manual import _patch_core_assistants

        original = ee.KNOWN_ASSISTANTS

        try:
            if ASSISTANT_ID not in ee.KNOWN_ASSISTANTS:
                ee.KNOWN_ASSISTANTS = tuple(list(ee.KNOWN_ASSISTANTS) + [ASSISTANT_ID])

            count_before = ee.KNOWN_ASSISTANTS.count(ASSISTANT_ID)

            hass = MagicMock(spec=HomeAssistant)
            hass.data = {"websocket_api": {}}
            _patch_core_assistants(hass)

            assert ee.KNOWN_ASSISTANTS.count(ASSISTANT_ID) == count_before
        finally:
            ee.KNOWN_ASSISTANTS = original

    def test_patches_ws_schemas_when_handlers_available(self) -> None:
        """When handlers are available, schemas are patched."""
        import homeassistant.components.homeassistant.exposed_entities as ee
        from google_assistant_manual import _patch_core_assistants

        original = ee.KNOWN_ASSISTANTS

        try:
            if ASSISTANT_ID in ee.KNOWN_ASSISTANTS:
                ee.KNOWN_ASSISTANTS = tuple(
                    x for x in ee.KNOWN_ASSISTANTS if x != ASSISTANT_ID
                )

            test_schema = vol.Schema(
                {
                    "assistant": vol.In(["conversation", "cloud.alexa"]),
                }
            )
            fake_handler = MagicMock()

            hass = MagicMock(spec=HomeAssistant)
            hass.data = {
                "websocket_api": {
                    "homeassistant/expose_entity": (fake_handler, test_schema),
                    "homeassistant/expose_new_entities/get": (
                        fake_handler,
                        test_schema,
                    ),
                    "homeassistant/expose_new_entities/set": (
                        fake_handler,
                        test_schema,
                    ),
                }
            }

            _patch_core_assistants(hass)

            container = test_schema.schema["assistant"].container
            assert ASSISTANT_ID in container
        finally:
            ee.KNOWN_ASSISTANTS = original

    def test_skips_ws_when_handlers_empty(self) -> None:
        import homeassistant.components.homeassistant.exposed_entities as ee
        from google_assistant_manual import _patch_core_assistants

        original = ee.KNOWN_ASSISTANTS

        try:
            if ASSISTANT_ID in ee.KNOWN_ASSISTANTS:
                ee.KNOWN_ASSISTANTS = tuple(
                    x for x in ee.KNOWN_ASSISTANTS if x != ASSISTANT_ID
                )

            hass = MagicMock(spec=HomeAssistant)
            hass.data = {"websocket_api": {}}
            _patch_core_assistants(hass)
            # Should not raise
        finally:
            ee.KNOWN_ASSISTANTS = original

    def test_skips_ws_when_handlers_key_missing(self) -> None:
        import homeassistant.components.homeassistant.exposed_entities as ee
        from google_assistant_manual import _patch_core_assistants

        original = ee.KNOWN_ASSISTANTS

        try:
            if ASSISTANT_ID in ee.KNOWN_ASSISTANTS:
                ee.KNOWN_ASSISTANTS = tuple(
                    x for x in ee.KNOWN_ASSISTANTS if x != ASSISTANT_ID
                )

            hass = MagicMock(spec=HomeAssistant)
            hass.data = {}
            _patch_core_assistants(hass)
            # Should not raise
        finally:
            ee.KNOWN_ASSISTANTS = original
