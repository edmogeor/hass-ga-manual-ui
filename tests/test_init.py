"""Tests for hass_ga_manual_ui/__init__.py."""

import logging
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
import voluptuous as vol
from hass_ga_manual_ui import (
    _DATA_YAML_DETECTED,
    WS_CONFIG_SCHEMA,
    _add_assistant_to_schema,
    _build_core_config,
    _entity_assistant_options,
    _find_core_entry,
    _make_core_entry,
    _our_google_config,
    _patch_google_config_properties,
    _project_id,
    _reconcile_core_ga_entries,
    _register_sync_listeners,
    _safe_get_entry,
    _sync_yaml_suppressed,
    _teardown_core_ga,
    async_setup,
)
from hass_ga_manual_ui.const import (
    ASSISTANT_ID,
    CONF_CLIENT_EMAIL,
    CONF_PROJECT_ID,
    CONF_REPORT_STATE,
    CONF_SECURE_DEVICES_PIN,
    CONF_SERVICE_ACCOUNT,
    CORE_GA_CREATED_BY,
    CORE_GA_DATA_CONFIG,
    CORE_GA_DOMAIN,
    CORE_GA_PARENT_ENTRY_ID,
    DOMAIN,
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
        # Original data is carried over (alongside the added ownership markers).
        for key, value in entry.data.items():
            assert core_entry.data[key] == value

    def test_stamps_ownership_markers(self) -> None:
        entry = mock_config_entry(project_id="proj", entry_id="our-entry-1")
        core_entry = _make_core_entry(entry)
        assert core_entry.data[CORE_GA_CREATED_BY] is True
        assert core_entry.data[CORE_GA_PARENT_ENTRY_ID] == "our-entry-1"

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
# _load_version
# =============================================================================


class TestLoadVersion:
    """Tests for _load_version (version-independent behavior only)."""

    def test_load_version_falls_back_on_error(self) -> None:
        from hass_ga_manual_ui import _load_version

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
        entry.options["enabled"] = True
        entry.options[CONF_REPORT_STATE] = True
        gc = FakeGoogleConfig(report_state=False)

        _patch_google_config_properties(gc, entry)
        assert gc.should_report_state is True

    def test_should_report_state_false_when_disabled(
        self, reset_original_props_cache: None
    ) -> None:
        """A soft-disabled integration reports no state even if the option is on."""
        entry = mock_config_entry()
        entry.options["enabled"] = False
        entry.options[CONF_REPORT_STATE] = True
        gc = FakeGoogleConfig(report_state=True)

        _patch_google_config_properties(gc, entry)
        assert gc.should_report_state is False

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
        entry.options["enabled"] = True
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

    def test_patches_should_expose_delegates_to_registry(
        self, reset_original_props_cache: None
    ) -> None:
        """should_expose delegates to the exposed_entities registry."""
        entry = mock_config_entry(options={"enabled": True})
        hass = MagicMock()
        # exposed empty => the original method would return False
        gc = FakeGoogleConfig(hass=hass, exposed=set())

        _patch_google_config_properties(gc, entry)

        with patch(
            "homeassistant.components.homeassistant.exposed_entities."
            "async_should_expose",
            return_value=True,
        ) as mock_should_expose:
            result = gc.should_expose("light.kitchen")

        assert result is True
        mock_should_expose.assert_called_once_with(hass, ASSISTANT_ID, "light.kitchen")

    def test_should_expose_false_when_disabled(
        self, reset_original_props_cache: None
    ) -> None:
        """A soft-disabled entry exposes nothing, without hitting the registry."""
        entry = mock_config_entry(options={"enabled": False})
        gc = FakeGoogleConfig(hass=MagicMock(), exposed={"light.kitchen"})

        _patch_google_config_properties(gc, entry)

        with patch(
            "homeassistant.components.homeassistant.exposed_entities."
            "async_should_expose",
            return_value=True,
        ) as mock_should_expose:
            assert gc.should_expose("light.kitchen") is False

        mock_should_expose.assert_not_called()

    def test_should_expose_uses_assistant_id_key(
        self, reset_original_props_cache: None
    ) -> None:
        """The registry is queried under our ASSISTANT_ID, not core GA's domain."""
        entry = mock_config_entry(options={"enabled": True})
        hass = MagicMock()

        class LocalGC:
            def __init__(self) -> None:
                self.hass = hass

            def should_expose(self, entity_id: str) -> bool:
                return False

        gc = LocalGC()
        _patch_google_config_properties(gc, entry)

        with patch(
            "homeassistant.components.homeassistant.exposed_entities."
            "async_should_expose",
            return_value=False,
        ) as mock_should_expose:
            gc.should_expose("switch.fan")

        _, assistant_arg, _ = mock_should_expose.call_args.args
        assert assistant_arg == ASSISTANT_ID

    def test_should_expose_fallback_on_registry_error(
        self, reset_original_props_cache: None
    ) -> None:
        """If the registry lookup raises, fall back to the original method."""
        entry = mock_config_entry(options={"enabled": True})

        class LocalGC:
            def __init__(self) -> None:
                self.hass = MagicMock()
                self._exposed = {"light.kitchen"}

            def should_expose(self, entity_id: str) -> bool:
                return entity_id in self._exposed

        gc = LocalGC()
        _patch_google_config_properties(gc, entry)

        with patch(
            "homeassistant.components.homeassistant.exposed_entities."
            "async_should_expose",
            side_effect=RuntimeError("registry unavailable"),
        ):
            assert gc.should_expose("light.kitchen") is True
            assert gc.should_expose("light.bedroom") is False

    def test_should_expose_other_instance_uses_original(
        self, reset_original_props_cache: None
    ) -> None:
        """A non-patched instance keeps the original should_expose behavior."""
        entry = mock_config_entry()

        class LocalGC:
            def __init__(self, exposed: set[str]) -> None:
                self.hass = MagicMock()
                self._exposed = exposed

            def should_expose(self, entity_id: str) -> bool:
                return entity_id in self._exposed

        gc_patched = LocalGC(exposed=set())
        _patch_google_config_properties(gc_patched, entry)

        gc_other = LocalGC(exposed={"light.den"})
        # gc_other is not the patched closure target, so it uses the original.
        assert gc_other.should_expose("light.den") is True
        assert gc_other.should_expose("light.attic") is False

    def test_missing_should_expose_method_handled(
        self, reset_original_props_cache: None, caplog: pytest.LogCaptureFixture
    ) -> None:
        """A GoogleConfig without should_expose is handled gracefully."""

        class MinimalGC:
            @property
            def should_report_state(self) -> bool:
                return True

            @property
            def secure_devices_pin(self) -> str | None:
                return None

        entry = mock_config_entry()
        gc = MinimalGC()

        caplog.set_level(logging.WARNING)
        # Must not raise even though should_expose is absent.
        _patch_google_config_properties(gc, entry)

        assert any("no should_expose method" in r.message for r in caplog.records), (
            f"Logs: {[r.message for r in caplog.records]}"
        )

    def test_should_2fa_true_by_default(self, reset_original_props_cache: None) -> None:
        """No disable_2fa option => ask for PIN (should_2fa True)."""
        entry = mock_config_entry(options={"enabled": True})
        gc = FakeGoogleConfig(hass=MagicMock())
        _patch_google_config_properties(gc, entry)

        state = MagicMock()
        state.entity_id = "lock.front"
        with patch(
            "homeassistant.components.homeassistant.exposed_entities."
            "async_get_entity_settings",
            return_value={ASSISTANT_ID: {}},
        ):
            assert gc.should_2fa(state) is True

    def test_should_2fa_false_when_disabled_2fa_set(
        self, reset_original_props_cache: None
    ) -> None:
        """disable_2fa=True => do not ask for PIN (should_2fa False)."""
        entry = mock_config_entry(options={"enabled": True})
        gc = FakeGoogleConfig(hass=MagicMock())
        _patch_google_config_properties(gc, entry)

        state = MagicMock()
        state.entity_id = "lock.front"
        with patch(
            "homeassistant.components.homeassistant.exposed_entities."
            "async_get_entity_settings",
            return_value={ASSISTANT_ID: {"disable_2fa": True}},
        ):
            assert gc.should_2fa(state) is False

    def test_should_2fa_false_when_entity_removed(
        self, reset_original_props_cache: None
    ) -> None:
        """Removed entity => should_2fa returns False (mirrors cloud)."""
        from homeassistant.exceptions import HomeAssistantError

        entry = mock_config_entry(options={"enabled": True})
        gc = FakeGoogleConfig(hass=MagicMock())
        _patch_google_config_properties(gc, entry)

        state = MagicMock()
        state.entity_id = "lock.gone"
        with patch(
            "homeassistant.components.homeassistant.exposed_entities."
            "async_get_entity_settings",
            side_effect=HomeAssistantError("removed"),
        ):
            assert gc.should_2fa(state) is False


# =============================================================================
# _our_google_config / _entity_assistant_options
# =============================================================================


class TestEntityHelpers:
    """Tests for _our_google_config and _entity_assistant_options."""

    def test_our_google_config_returns_enabled_config(self) -> None:
        hass = MagicMock(spec=HomeAssistant)
        gc = object()
        entry = mock_config_entry(runtime_data={"google_config": gc})
        hass.config_entries.async_entries.return_value = [entry]
        assert _our_google_config(hass) is gc

    def test_our_google_config_none_when_no_runtime(self) -> None:
        hass = MagicMock(spec=HomeAssistant)
        entry = mock_config_entry(runtime_data=None)
        hass.config_entries.async_entries.return_value = [entry]
        assert _our_google_config(hass) is None

    def test_entity_assistant_options_returns_our_options(self) -> None:
        hass = MagicMock(spec=HomeAssistant)
        with patch(
            "homeassistant.components.homeassistant.exposed_entities."
            "async_get_entity_settings",
            return_value={ASSISTANT_ID: {"disable_2fa": True}},
        ):
            assert _entity_assistant_options(hass, "lock.front") == {
                "disable_2fa": True
            }

    def test_entity_assistant_options_empty_on_error(self) -> None:
        from homeassistant.exceptions import HomeAssistantError

        hass = MagicMock(spec=HomeAssistant)
        with patch(
            "homeassistant.components.homeassistant.exposed_entities."
            "async_get_entity_settings",
            side_effect=HomeAssistantError("x"),
        ):
            assert _entity_assistant_options(hass, "lock.front") == {}


# =============================================================================
# _teardown_core_ga
# =============================================================================


class TestTeardownCoreGa:
    """Tests for _teardown_core_ga (unload vs soft-disable)."""

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

    async def test_unload_drops_pointer_only(self) -> None:
        """disable=False (plain unload/reload) just drops our runtime pointer."""
        hass = MagicMock(spec=HomeAssistant)
        gc = FakeGoogleConfig()
        gc.async_disable_report_state = MagicMock()  # type: ignore[method-assign]
        hass.config_entries.async_update_entry = MagicMock()

        entry = mock_config_entry(runtime_data={"google_config": gc})
        entry.options["enabled"] = True

        await _teardown_core_ga(hass, entry, disable=False)

        assert entry.runtime_data is None
        gc.async_disable_report_state.assert_not_called()
        hass.config_entries.async_update_entry.assert_not_called()

    async def test_disable_turns_off_report_state(self) -> None:
        hass = MagicMock(spec=HomeAssistant)
        gc = FakeGoogleConfig()
        gc.async_disable_report_state = MagicMock()  # type: ignore[method-assign]
        entry = mock_config_entry(runtime_data={"google_config": gc})
        hass.config_entries.async_update_entry = MagicMock()

        await _teardown_core_ga(hass, entry, disable=True)
        gc.async_disable_report_state.assert_called_once()

    async def test_disable_sets_enabled_false(self) -> None:
        hass = MagicMock(spec=HomeAssistant)
        gc = FakeGoogleConfig()
        entry = mock_config_entry(runtime_data={"google_config": gc})
        entry.options["enabled"] = True
        hass.config_entries.async_update_entry = MagicMock()

        await _teardown_core_ga(hass, entry, disable=True)
        call_args = hass.config_entries.async_update_entry.call_args
        assert call_args[1]["options"]["enabled"] is False

    async def test_disable_keeps_runtime_data_and_core_entry(self) -> None:
        """Soft-disable must NOT remove the core entry or drop runtime_data."""
        hass = MagicMock(spec=HomeAssistant)
        gc = FakeGoogleConfig()
        hass.config_entries.async_update_entry = MagicMock()
        hass.config_entries.async_remove = MagicMock()

        runtime = {"google_config": gc, "core_entry": MagicMock()}
        entry = mock_config_entry(runtime_data=runtime)

        await _teardown_core_ga(hass, entry, disable=True)

        assert entry.runtime_data is runtime  # kept
        hass.config_entries.async_remove.assert_not_called()  # core entry kept

    async def test_disable_handles_report_state_failure(self) -> None:
        hass = MagicMock(spec=HomeAssistant)
        gc = FakeGoogleConfig()
        gc.async_disable_report_state = MagicMock(  # type: ignore[method-assign]
            side_effect=RuntimeError("boom")
        )
        entry = mock_config_entry(runtime_data={"google_config": gc})
        hass.config_entries.async_update_entry = MagicMock()

        # Must not raise; still flips enabled off.
        await _teardown_core_ga(hass, entry, disable=True)
        call_args = hass.config_entries.async_update_entry.call_args
        assert call_args[1]["options"]["enabled"] is False

    async def test_disable_without_google_config(self) -> None:
        """Runtime data can exist without a google_config key."""
        hass = MagicMock(spec=HomeAssistant)
        entry = mock_config_entry(runtime_data={"core_entry": MagicMock()})
        hass.config_entries.async_update_entry = MagicMock()
        await _teardown_core_ga(hass, entry, disable=True)
        call_args = hass.config_entries.async_update_entry.call_args
        assert call_args[1]["options"]["enabled"] is False

    async def test_disable_removes_sync_listeners(self) -> None:
        hass = MagicMock(spec=HomeAssistant)
        hass.config_entries.async_update_entry = MagicMock()
        unsub = MagicMock()
        entry = mock_config_entry(
            runtime_data={"google_config": FakeGoogleConfig(), "sync_unsubs": [unsub]}
        )
        await _teardown_core_ga(hass, entry, disable=True)
        unsub.assert_called_once()

    async def test_unload_removes_sync_listeners(self) -> None:
        hass = MagicMock(spec=HomeAssistant)
        unsub = MagicMock()
        entry = mock_config_entry(
            runtime_data={"google_config": FakeGoogleConfig(), "sync_unsubs": [unsub]}
        )
        await _teardown_core_ga(hass, entry, disable=False)
        unsub.assert_called_once()
        assert entry.runtime_data is None


# =============================================================================
# _register_sync_listeners
# =============================================================================


class TestRegisterSyncListeners:
    """Tests for the Cloud-parity auto-resync listeners."""

    def test_registers_three_listeners(self) -> None:
        hass = MagicMock(spec=HomeAssistant)
        hass.bus = MagicMock()
        hass.bus.async_listen = MagicMock(side_effect=lambda *a, **k: MagicMock())
        entry = mock_config_entry(options={"enabled": True})
        gc = MagicMock()

        with patch(
            "homeassistant.components.homeassistant.exposed_entities."
            "async_listen_entity_updates",
            return_value=MagicMock(),
        ):
            unsubs = _register_sync_listeners(hass, entry, gc)

        # exposed-entities + entity-registry + device-registry
        assert len(unsubs) == 3
        assert hass.bus.async_listen.call_count == 2

    def test_survives_exposed_entities_listener_failure(self) -> None:
        hass = MagicMock(spec=HomeAssistant)
        hass.bus = MagicMock()
        hass.bus.async_listen = MagicMock(side_effect=lambda *a, **k: MagicMock())
        entry = mock_config_entry(options={"enabled": True})
        gc = MagicMock()

        with patch(
            "homeassistant.components.homeassistant.exposed_entities."
            "async_listen_entity_updates",
            side_effect=RuntimeError("boom"),
        ):
            unsubs = _register_sync_listeners(hass, entry, gc)

        # The two bus listeners still register even if the exposed-entities
        # listener could not be set up.
        assert len(unsubs) == 2


# =============================================================================
# _find_core_entry / _reconcile_core_ga_entries
# =============================================================================


class TestFindCoreEntry:
    """Tests for _find_core_entry."""

    def test_finds_matching_core_entry(self) -> None:
        hass = MagicMock(spec=HomeAssistant)
        our = mock_config_entry(project_id="proj-a", entry_id="our-a")
        core = _owned_core_entry("our-a", project_id="proj-a", entry_id="core-a")
        hass.config_entries.async_entries.return_value = [core]

        assert _find_core_entry(hass, our) is core

    def test_ignores_unmarked_entry_with_matching_project(self) -> None:
        """An unmarked google_assistant entry is never adopted (no legacy match)."""
        hass = MagicMock(spec=HomeAssistant)
        our = mock_config_entry(project_id="proj-a", entry_id="our-a")
        unmarked = mock_config_entry(project_id="proj-a", entry_id="core-a")
        hass.config_entries.async_entries.return_value = [unmarked]

        assert _find_core_entry(hass, our) is None

    def test_returns_none_when_no_match(self) -> None:
        hass = MagicMock(spec=HomeAssistant)
        our = mock_config_entry(project_id="proj-a")
        other = mock_config_entry(project_id="proj-b", entry_id="core-b")
        hass.config_entries.async_entries.return_value = [other]

        assert _find_core_entry(hass, our) is None

    def test_returns_none_when_empty(self) -> None:
        hass = MagicMock(spec=HomeAssistant)
        our = mock_config_entry(project_id="proj-a")
        hass.config_entries.async_entries.return_value = []

        assert _find_core_entry(hass, our) is None

    def test_prefers_owned_entry_by_parent_marker(self) -> None:
        """An exact parent-marker match wins, even if project_id differs."""
        hass = MagicMock(spec=HomeAssistant)
        our = mock_config_entry(project_id="proj-renamed", entry_id="our-a")
        owned = _owned_core_entry("our-a", project_id="proj-old", entry_id="core-a")
        hass.config_entries.async_entries.return_value = [owned]

        assert _find_core_entry(hass, our) is owned

    def test_ignores_entry_owned_by_a_different_parent(self) -> None:
        """A marked entry owned by another parent is not adopted by project_id."""
        hass = MagicMock(spec=HomeAssistant)
        our = mock_config_entry(project_id="proj-a", entry_id="our-a")
        other = _owned_core_entry("our-b", project_id="proj-a", entry_id="core-b")
        hass.config_entries.async_entries.return_value = [other]

        assert _find_core_entry(hass, our) is None


def _owned_core_entry(
    parent_id: str, project_id: str = "proj-a", entry_id: str = "core-a"
) -> MagicMock:
    """A shadow core GA entry stamped as owned by our `parent_id` entry."""
    core = mock_config_entry(project_id=project_id, entry_id=entry_id)
    core.data[CORE_GA_CREATED_BY] = True
    core.data[CORE_GA_PARENT_ENTRY_ID] = parent_id
    return core


def _reconcile_harness(
    our_entries: list[MagicMock], core_entries: list[MagicMock]
) -> tuple[MagicMock, list[str]]:
    """Wire a hass mock for _reconcile_core_ga_entries; return (hass, removed)."""
    hass = MagicMock(spec=HomeAssistant)
    hass.data = {}

    def _entries(domain: str) -> list[MagicMock]:
        return our_entries if domain == DOMAIN else core_entries

    hass.config_entries.async_entries.side_effect = _entries
    removed: list[str] = []

    async def _remove(entry_id: str) -> None:
        removed.append(entry_id)

    hass.config_entries.async_remove.side_effect = _remove
    return hass, removed


class TestReconcileCoreGaEntries:
    """Tests for _reconcile_core_ga_entries (ownership-based pruning)."""

    async def test_seeds_data_config_from_enabled_entry(self) -> None:
        our = mock_config_entry(
            project_id="proj-a", entry_id="our-a", options={"enabled": True}
        )
        core = _owned_core_entry("our-a")
        hass, _ = _reconcile_harness([our], [core])

        await _reconcile_core_ga_entries(hass)

        assert CORE_GA_DATA_CONFIG in hass.data[CORE_GA_DOMAIN]
        assert hass.data[CORE_GA_DOMAIN][CORE_GA_DATA_CONFIG][CONF_PROJECT_ID] == (
            "proj-a"
        )

    async def test_keeps_owned_entry_with_live_parent(self) -> None:
        our = mock_config_entry(
            project_id="proj-a", entry_id="our-a", options={"enabled": True}
        )
        core = _owned_core_entry("our-a")
        hass, removed = _reconcile_harness([our], [core])

        await _reconcile_core_ga_entries(hass)

        assert removed == []  # owned + live parent => preserved

    async def test_prunes_orphan_and_duplicate_owned_entries(self) -> None:
        our = mock_config_entry(
            project_id="proj-a", entry_id="our-a", options={"enabled": True}
        )
        keep = _owned_core_entry("our-a", entry_id="core-keep")
        dup = _owned_core_entry("our-a", entry_id="core-dup")
        orphan = _owned_core_entry(
            "our-gone", project_id="proj-z", entry_id="core-orphan"
        )
        hass, removed = _reconcile_harness([our], [keep, dup, orphan])

        await _reconcile_core_ga_entries(hass)

        assert "core-keep" not in removed
        assert set(removed) == {"core-dup", "core-orphan"}

    async def test_keeps_owned_entry_for_disabled_parent(self) -> None:
        """A present-but-disabled parent keeps its shadow (links survive)."""
        our = mock_config_entry(
            project_id="proj-a", entry_id="our-a", options={"enabled": False}
        )
        core = _owned_core_entry("our-a")
        hass, removed = _reconcile_harness([our], [core])

        await _reconcile_core_ga_entries(hass)

        assert removed == []  # disabled but present => kept

    async def test_never_prunes_unmarked_entry(self) -> None:
        """A google_assistant entry the user configured (no marker) is untouched."""
        our = mock_config_entry(
            project_id="proj-a", entry_id="our-a", options={"enabled": True}
        )
        # Unmarked, and an unrelated project the user set up themselves.
        user_entry = mock_config_entry(project_id="proj-user", entry_id="core-user")
        hass, removed = _reconcile_harness([our], [user_entry])

        await _reconcile_core_ga_entries(hass)

        assert removed == []  # never touch entries we did not create

    async def test_bails_when_our_entries_unreadable(self) -> None:
        """If we cannot read our own entries, prune nothing."""
        hass = MagicMock(spec=HomeAssistant)
        hass.data = {}
        hass.config_entries.async_entries.side_effect = RuntimeError("registry down")
        removed: list[str] = []
        hass.config_entries.async_remove.side_effect = (
            lambda eid: removed.append(eid)  # type: ignore[func-returns-value]
        )

        await _reconcile_core_ga_entries(hass)

        assert removed == []


# =============================================================================
# YAML detection -> yaml_suppressed
# =============================================================================


class TestYamlSuppressed:
    """Tests for YAML google_assistant detection wiring."""

    async def test_async_setup_records_yaml_present(self) -> None:
        hass = MagicMock(spec=HomeAssistant)
        hass.data = {}
        hass.config_entries.async_entries.return_value = []

        with patch("hass_ga_manual_ui.async_setup_frontend"):
            await async_setup(hass, {CORE_GA_DOMAIN: {"project_id": "p"}})

        assert hass.data[DOMAIN][_DATA_YAML_DETECTED] is True

    async def test_async_setup_records_yaml_absent(self) -> None:
        hass = MagicMock(spec=HomeAssistant)
        hass.data = {}
        hass.config_entries.async_entries.return_value = []

        with patch("hass_ga_manual_ui.async_setup_frontend"):
            await async_setup(hass, {"sensor": {}})

        assert hass.data[DOMAIN][_DATA_YAML_DETECTED] is False

    def test_sync_sets_flag_when_detected(self) -> None:
        hass = MagicMock(spec=HomeAssistant)
        hass.data = {DOMAIN: {_DATA_YAML_DETECTED: True}}
        entry = mock_config_entry(options={"enabled": True})

        _sync_yaml_suppressed(hass, entry)

        hass.config_entries.async_update_entry.assert_called_once()
        _, kwargs = hass.config_entries.async_update_entry.call_args
        assert kwargs["options"]["yaml_suppressed"] is True
        assert kwargs["options"]["enabled"] is True  # preserves existing options

    def test_sync_clears_stale_flag_when_absent(self) -> None:
        hass = MagicMock(spec=HomeAssistant)
        hass.data = {DOMAIN: {_DATA_YAML_DETECTED: False}}
        entry = mock_config_entry(options={"enabled": True, "yaml_suppressed": True})

        _sync_yaml_suppressed(hass, entry)

        _, kwargs = hass.config_entries.async_update_entry.call_args
        assert kwargs["options"]["yaml_suppressed"] is False

    def test_sync_no_write_when_unchanged(self) -> None:
        hass = MagicMock(spec=HomeAssistant)
        hass.data = {DOMAIN: {_DATA_YAML_DETECTED: False}}
        entry = mock_config_entry(options={"enabled": True})  # no yaml_suppressed

        _sync_yaml_suppressed(hass, entry)

        hass.config_entries.async_update_entry.assert_not_called()


# =============================================================================
# _patch_core_assistants
# =============================================================================


class TestPatchCoreAssistants:
    """Tests for _patch_core_assistants."""

    def test_patches_known_assistants(self) -> None:
        """Test KNOWN_ASSISTANTS tuple is patched."""
        import homeassistant.components.homeassistant.exposed_entities as ee
        from hass_ga_manual_ui import _patch_core_assistants

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
        from hass_ga_manual_ui import _patch_core_assistants

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
        from hass_ga_manual_ui import _patch_core_assistants

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
        from hass_ga_manual_ui import _patch_core_assistants

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
        from hass_ga_manual_ui import _patch_core_assistants

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
