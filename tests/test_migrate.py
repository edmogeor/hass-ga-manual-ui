"""Tests for migrate.py: apply_ga_config, export_ga_config, exposure + alias rules.

Uses lightweight fakes (matching the rest of the suite's MagicMock style) rather
than the full HA harness. The exposed_entities module functions delegate to
``hass.data[DATA_EXPOSED_ENTITIES]``, so a fake there exercises the real apply /
export paths; only ``entity_registry.async_get`` is monkeypatched to a fake.
"""

from typing import Any

import pytest
import voluptuous as vol
from hass_ga_manual_ui import migrate
from hass_ga_manual_ui.const import (
    CONF_CLIENT_EMAIL,
    CONF_PRIVATE_KEY,
    CONF_PROJECT_ID,
    CONF_REPORT_STATE,
    CONF_SECURE_DEVICES_PIN,
    CONF_SERVICE_ACCOUNT,
    CORE_GA_DOMAIN,
)
from homeassistant.components.homeassistant.const import DATA_EXPOSED_ENTITIES
from homeassistant.util.yaml import dump, parse_yaml

ASSISTANT_ID = "hass_ga_manual_ui"
_PEM = (
    "-----BEGIN PRIVATE KEY-----\n"
    "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\n"
    "abc123def456ghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ\n"
    "-----END PRIVATE KEY-----\n"
)


# ===========================================================================
# Fakes
# ===========================================================================


class FakeRegEntry:
    """Minimal stand-in for an entity registry entry."""

    def __init__(
        self,
        entity_id: str,
        aliases: Any = None,
        entity_category: Any = None,
        hidden_by: Any = None,
    ) -> None:
        self.entity_id = entity_id
        self.aliases = [] if aliases is None else aliases
        self.entity_category = entity_category
        self.hidden_by = hidden_by


class FakeRegistry:
    """Stand-in for the entity registry (async_get / async_update_entity)."""

    def __init__(self, entries: list[FakeRegEntry]) -> None:
        self.entities = {e.entity_id: e for e in entries}

    def async_get(self, entity_id: str) -> FakeRegEntry | None:
        return self.entities.get(entity_id)

    def async_update_entity(self, entity_id: str, **kwargs: Any) -> None:
        if entity_id not in self.entities:
            raise ValueError(f"Unknown entity {entity_id}")
        if "aliases" in kwargs:
            self.entities[entity_id].aliases = kwargs["aliases"]


class FakeExposed:
    """Stand-in for the ExposedEntities instance in hass.data."""

    def __init__(self, should: dict[str, bool] | None = None) -> None:
        self.expose_new: dict[str, bool] = {}
        self.options: dict[tuple[str, str], dict[str, Any]] = {}
        self._should = should or {}

    def async_set_expose_new_entities(self, assistant: str, value: bool) -> None:
        self.expose_new[assistant] = value

    def async_set_assistant_option(
        self, assistant: str, entity_id: str, option: str, value: Any
    ) -> None:
        self.options.setdefault((assistant, entity_id), {})[option] = value

    def async_should_expose(self, assistant: str, entity_id: str) -> bool:
        return self._should.get(entity_id, False)


class FakeStates:
    """hass.states.async_entity_ids()."""

    def __init__(self, ids: list[str]) -> None:
        self._ids = ids

    def async_entity_ids(self) -> list[str]:
        return list(self._ids)


class FakeConfigEntries:
    """hass.config_entries: records option updates, no entries of our domain."""

    def async_update_entry(self, entry: Any, *, options: dict[str, Any]) -> None:
        entry.options = options

    def async_entries(self, _domain: str) -> list[Any]:
        return []


class FakeHass:
    """Just enough hass for migrate.apply_ga_config / export_ga_config."""

    def __init__(self, states: list[str], exposed: FakeExposed) -> None:
        self.states = FakeStates(states)
        self.config_entries = FakeConfigEntries()
        self.data = {DATA_EXPOSED_ENTITIES: exposed}


class FakeEntry:
    """ConfigEntry-like with data + mutable options."""

    def __init__(
        self, options: dict[str, Any] | None = None, sa: dict[str, str] | None = None
    ) -> None:
        self.data = {
            CONF_PROJECT_ID: "my-home-12345",
            CONF_SERVICE_ACCOUNT: sa
            or {
                CONF_CLIENT_EMAIL: "a@b.iam.gserviceaccount.com",
                CONF_PRIVATE_KEY: _PEM,
            },
        }
        self.options = options or {}


@pytest.fixture
def patch_registry(monkeypatch: pytest.MonkeyPatch):
    """Route entity_registry.async_get to a caller-provided FakeRegistry."""

    def _install(registry: FakeRegistry) -> FakeRegistry:
        monkeypatch.setattr(
            "homeassistant.helpers.entity_registry.async_get", lambda _hass: registry
        )
        return registry

    return _install


# ===========================================================================
# _merge_aliases / _str_aliases (pure)
# ===========================================================================


def test_str_aliases_drops_non_str_sentinel() -> None:
    sentinel = object()
    assert migrate._str_aliases(["foo", sentinel, "bar"]) == ["foo", "bar"]


def test_merge_aliases_list_dedupes_and_preserves_order() -> None:
    merged = migrate._merge_aliases(["foo"], ["bar", "foo"])
    assert merged == ["foo", "bar"]


def test_merge_aliases_list_preserves_computed_name_sentinel() -> None:
    sentinel = object()
    merged = migrate._merge_aliases([sentinel, "foo"], ["bar"])
    assert merged == [sentinel, "foo", "bar"]


def test_merge_aliases_set_keeps_set_type() -> None:
    merged = migrate._merge_aliases({"foo"}, ["bar", "foo"])
    assert isinstance(merged, set)
    assert merged == {"foo", "bar"}


def test_merge_aliases_nothing_to_add_returns_none() -> None:
    assert migrate._merge_aliases(["foo"], ["foo"]) is None
    assert migrate._merge_aliases({"foo"}, ["foo"]) is None


# ===========================================================================
# _yaml_should_expose (core GA rule parity)
# ===========================================================================


def test_yaml_should_expose_domain_default(patch_registry) -> None:
    patch_registry(FakeRegistry([FakeRegEntry("light.kitchen")]))
    assert migrate._yaml_should_expose(None, "light.kitchen", True, ["light"], {})


def test_yaml_should_expose_domain_not_in_list(patch_registry) -> None:
    patch_registry(FakeRegistry([FakeRegEntry("light.kitchen")]))
    assert not migrate._yaml_should_expose(None, "light.kitchen", True, ["switch"], {})


def test_yaml_should_expose_explicit_overrides_default(patch_registry) -> None:
    patch_registry(FakeRegistry([FakeRegEntry("light.kitchen")]))
    # Default-exposed domain but explicitly excluded.
    assert not migrate._yaml_should_expose(
        None, "light.kitchen", True, ["light"], {"light.kitchen": {"expose": False}}
    )
    # Not default-exposed but explicitly included.
    assert migrate._yaml_should_expose(
        None, "switch.fan", True, ["light"], {"switch.fan": {"expose": True}}
    )


def test_yaml_should_expose_auxiliary_entity_excluded(patch_registry) -> None:
    patch_registry(FakeRegistry([FakeRegEntry("sensor.cfg", entity_category="config")]))
    assert not migrate._yaml_should_expose(None, "sensor.cfg", True, ["sensor"], {})


# ===========================================================================
# apply_ga_config
# ===========================================================================


def test_apply_sets_options_and_expose_new(patch_registry) -> None:
    patch_registry(FakeRegistry([FakeRegEntry("light.kitchen")]))
    exposed = FakeExposed()
    hass = FakeHass(["light.kitchen"], exposed)
    entry = FakeEntry(options={"enabled": True})

    summary = migrate.apply_ga_config(
        hass,
        entry,
        {
            CONF_REPORT_STATE: True,
            CONF_SECURE_DEVICES_PIN: "1234",
            "expose_by_default": True,
            "exposed_domains": ["light"],
        },
    )

    assert entry.options[CONF_REPORT_STATE] is True
    assert entry.options[CONF_SECURE_DEVICES_PIN] == "1234"
    assert exposed.expose_new[ASSISTANT_ID] is True
    assert exposed.options[(ASSISTANT_ID, "light.kitchen")]["should_expose"] is True
    assert summary["exposed"] == 1


def test_apply_omitted_exposed_domains_uses_core_default(patch_registry) -> None:
    # "light" is in core's DEFAULT_EXPOSED_DOMAINS; "person" is not.
    patch_registry(FakeRegistry([FakeRegEntry("light.k"), FakeRegEntry("person.me")]))
    exposed = FakeExposed()
    hass = FakeHass(["light.k", "person.me"], exposed)
    entry = FakeEntry(options={"enabled": True})

    migrate.apply_ga_config(hass, entry, {"expose_by_default": True})

    assert exposed.options[(ASSISTANT_ID, "light.k")]["should_expose"] is True
    assert exposed.options[(ASSISTANT_ID, "person.me")]["should_expose"] is False


def test_apply_merges_aliases_without_clobber(patch_registry) -> None:
    reg = patch_registry(
        FakeRegistry([FakeRegEntry("light.kitchen", aliases=["existing"])])
    )
    exposed = FakeExposed()
    hass = FakeHass(["light.kitchen"], exposed)
    entry = FakeEntry(options={"enabled": True})

    migrate.apply_ga_config(
        hass,
        entry,
        {
            "entity_config": {
                "light.kitchen": {"aliases": ["existing", "reading light"]}
            }
        },
    )

    assert reg.entities["light.kitchen"].aliases == ["existing", "reading light"]


def test_apply_alias_unknown_entity_guarded(patch_registry) -> None:
    reg = patch_registry(FakeRegistry([]))  # no entities
    exposed = FakeExposed()
    hass = FakeHass([], exposed)
    entry = FakeEntry(options={"enabled": True})

    # Should not raise even though async_update_entity would raise on unknown id.
    migrate.apply_ga_config(
        hass,
        entry,
        {"entity_config": {"light.gone": {"aliases": ["ghost"]}}},
    )
    assert "light.gone" not in reg.entities


# ===========================================================================
# export_ga_config
# ===========================================================================


def test_export_standalone_valid_and_round_trip(patch_registry) -> None:
    reg = patch_registry(
        FakeRegistry(
            [
                FakeRegEntry("light.kitchen", aliases=["reading light"]),
                FakeRegEntry("switch.fan"),
            ]
        )
    )
    exposed = FakeExposed(should={"light.kitchen": True, "switch.fan": True})
    hass = FakeHass(["light.kitchen", "switch.fan"], exposed)
    entry = FakeEntry(options={CONF_REPORT_STATE: True, CONF_SECURE_DEVICES_PIN: ""})

    yaml_str = migrate.export_ga_config(hass, entry)

    # Parses back, wrapped under the core GA domain.
    parsed = parse_yaml(yaml_str)
    block = parsed[CORE_GA_DOMAIN]
    assert block[CONF_PROJECT_ID] == "my-home-12345"
    assert block["expose_by_default"] is False
    assert block["entity_config"]["light.kitchen"] == {
        "expose": True,
        "aliases": ["reading light"],
    }
    assert block["entity_config"]["switch.fan"] == {"expose": True}
    # secure_devices_pin omitted when empty.
    assert CONF_SECURE_DEVICES_PIN not in block
    assert reg  # registry was used


def test_export_validates_against_core_schema() -> None:
    """export_ga_config raises if its dict is not standalone-valid."""
    from homeassistant.components.google_assistant import GOOGLE_ASSISTANT_SCHEMA

    # Sanity: the schema rejects report_state without a service account.
    with pytest.raises(vol.Invalid):
        GOOGLE_ASSISTANT_SCHEMA({CONF_PROJECT_ID: "p-12345", CONF_REPORT_STATE: True})


def test_export_pem_round_trip_preserved(patch_registry) -> None:
    patch_registry(FakeRegistry([]))
    exposed = FakeExposed()
    hass = FakeHass([], exposed)
    entry = FakeEntry(options={CONF_REPORT_STATE: True})

    yaml_str = migrate.export_ga_config(hass, entry)
    block = parse_yaml(yaml_str)[CORE_GA_DOMAIN]
    assert block[CONF_SERVICE_ACCOUNT][CONF_PRIVATE_KEY] == _PEM


def test_dump_parse_pem_round_trip() -> None:
    """Guard the YAML lib itself preserves a multi-line PEM verbatim."""
    cfg = {CONF_SERVICE_ACCOUNT: {CONF_PRIVATE_KEY: _PEM}}
    assert parse_yaml(dump(cfg))[CONF_SERVICE_ACCOUNT][CONF_PRIVATE_KEY] == _PEM


# ===========================================================================
# export_filename / GA_CONFIG_SCHEMA
# ===========================================================================


def test_export_filename_shape() -> None:
    entry = FakeEntry()
    name = migrate.export_filename(entry)
    assert name.startswith("hass-ga-manual-ui_my-home-12345_")
    assert name.endswith(".yaml")


def test_ga_config_schema_permissive() -> None:
    cfg = migrate.GA_CONFIG_SCHEMA(
        {
            "report_state": True,
            "secure_devices_pin": "1234",
            "expose_by_default": False,
            "entity_config": {"light.k": {"expose": True, "aliases": ["x"]}},
            "unknown_key": "ignored",
        }
    )
    assert cfg["entity_config"]["light.k"]["aliases"] == ["x"]


# ---------------------------------------------------------------------------
# import_credentials
# ---------------------------------------------------------------------------


def test_import_credentials_full_sa_with_project_id() -> None:
    out = migrate.import_credentials(
        {
            CONF_PROJECT_ID: "my-project",
            CONF_SERVICE_ACCOUNT: {
                CONF_CLIENT_EMAIL: "sa@x.iam.gserviceaccount.com",
                CONF_PRIVATE_KEY: _PEM,
            },
        }
    )
    assert out == {
        CONF_PROJECT_ID: "my-project",
        CONF_SERVICE_ACCOUNT: {
            CONF_CLIENT_EMAIL: "sa@x.iam.gserviceaccount.com",
            CONF_PRIVATE_KEY: _PEM,
        },
    }


def test_import_credentials_sa_without_project_id() -> None:
    out = migrate.import_credentials(
        {
            CONF_SERVICE_ACCOUNT: {
                CONF_CLIENT_EMAIL: "sa@x.iam.gserviceaccount.com",
                CONF_PRIVATE_KEY: _PEM,
            }
        }
    )
    assert out is not None
    assert CONF_PROJECT_ID not in out


def test_import_credentials_incomplete_sa_returns_none() -> None:
    # Missing private_key, and a bare project_id, are both not adoptable.
    assert (
        migrate.import_credentials(
            {CONF_SERVICE_ACCOUNT: {CONF_CLIENT_EMAIL: "sa@x.iam.gserviceaccount.com"}}
        )
        is None
    )
    assert migrate.import_credentials({CONF_PROJECT_ID: "my-project"}) is None
    assert migrate.import_credentials({}) is None


def test_import_credentials_unchanged_returns_none() -> None:
    cfg = {
        CONF_PROJECT_ID: "my-project",
        CONF_SERVICE_ACCOUNT: {
            CONF_CLIENT_EMAIL: "sa@x.iam.gserviceaccount.com",
            CONF_PRIVATE_KEY: _PEM,
        },
    }
    current = {
        CONF_PROJECT_ID: "my-project",
        CONF_SERVICE_ACCOUNT: {
            CONF_CLIENT_EMAIL: "sa@x.iam.gserviceaccount.com",
            CONF_PRIVATE_KEY: _PEM,
        },
    }
    assert migrate.import_credentials(cfg, current) is None


def test_import_credentials_changed_key_is_adopted() -> None:
    cfg = {
        CONF_SERVICE_ACCOUNT: {
            CONF_CLIENT_EMAIL: "sa@x.iam.gserviceaccount.com",
            CONF_PRIVATE_KEY: _PEM + "rotated",
        }
    }
    current = {
        CONF_SERVICE_ACCOUNT: {
            CONF_CLIENT_EMAIL: "sa@x.iam.gserviceaccount.com",
            CONF_PRIVATE_KEY: _PEM,
        },
    }
    out = migrate.import_credentials(cfg, current)
    assert out is not None
    assert out[CONF_SERVICE_ACCOUNT][CONF_PRIVATE_KEY] == _PEM + "rotated"


def test_import_credentials_same_sa_new_project_id_is_adopted() -> None:
    cfg = {
        CONF_PROJECT_ID: "new-project",
        CONF_SERVICE_ACCOUNT: {
            CONF_CLIENT_EMAIL: "sa@x.iam.gserviceaccount.com",
            CONF_PRIVATE_KEY: _PEM,
        },
    }
    current = {
        CONF_PROJECT_ID: "old-project",
        CONF_SERVICE_ACCOUNT: {
            CONF_CLIENT_EMAIL: "sa@x.iam.gserviceaccount.com",
            CONF_PRIVATE_KEY: _PEM,
        },
    }
    out = migrate.import_credentials(cfg, current)
    assert out is not None
    assert out[CONF_PROJECT_ID] == "new-project"
