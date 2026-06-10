"""Google Assistant Manual integration.

Adds a "Google Assistant (Manual)" entry under voice assistants when exposing
a device, without requiring Nabu Casa Cloud. Provides UI-based configuration
for the manual Google Assistant integration.
"""

import json
import logging
from pathlib import Path
from typing import Any

import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.config_entries import ConfigEntry, ConfigEntryState
from homeassistant.core import CoreState, HomeAssistant, callback
from homeassistant.helpers.typing import ConfigType

from .const import (
    ASSISTANT_ID,
    CONF_CLIENT_EMAIL,
    CONF_PRIVATE_KEY,
    CONF_PROJECT_ID,
    CONF_REPORT_STATE,
    CONF_SECURE_DEVICES_PIN,
    CONF_SERVICE_ACCOUNT,
    CORE_GA_DATA_CONFIG,
    CORE_GA_DOMAIN,
    DOMAIN,
    WS_DISABLE,
    WS_ENABLE,
    WS_GET_CONFIG,
    WS_UPDATE_CONFIG,
)
from .frontend import async_setup_frontend

_LOGGER = logging.getLogger(__name__)


def _load_version() -> str:
    try:
        manifest_path = Path(__file__).parent / "manifest.json"
        return json.loads(manifest_path.read_text()).get("version", "unknown")
    except Exception:
        return "unknown"


_VERSION: str = _load_version()

_WSC_PATCH_TARGETS = (
    "homeassistant/expose_entity",
    "homeassistant/expose_new_entities/get",
    "homeassistant/expose_new_entities/set",
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _project_id(entry: ConfigEntry) -> str:
    """Return the project_id from a config entry (or '<missing>')."""
    return entry.data.get(CONF_PROJECT_ID, "<missing>")


def _find_core_entry(hass: HomeAssistant, entry: ConfigEntry) -> ConfigEntry | None:
    """Return the registered core GA entry for our project, if one exists."""
    project_id = entry.data.get(CONF_PROJECT_ID)
    for core_entry in hass.config_entries.async_entries(CORE_GA_DOMAIN):
        if core_entry.data.get(CONF_PROJECT_ID) == project_id:
            return core_entry
    return None


async def _reconcile_core_ga_entries(hass: HomeAssistant) -> None:
    """Prepare core GA entries during async_setup (before they auto-load).

    We keep the framework-registered core GA entry across restarts (it carries
    the device-registry links), so we must NOT blindly remove it. Instead:

    1. Populate ``hass.data["google_assistant"][DATA_CONFIG]`` from our config
       entry so that when HA auto-sets-up the persisted core entry on boot, it
       does not crash with ``KeyError: 'google_assistant'``.
    2. Prune orphans and duplicates left behind by older versions — keep at most
       one core entry per enabled project, drop the rest.
    """
    our_entries: list[ConfigEntry]
    try:
        our_entries = list(hass.config_entries.async_entries(DOMAIN))
    except Exception as exc:
        _LOGGER.debug("Could not enumerate our config entries: %s", exc)
        our_entries = []

    valid_project_ids = {
        e.data.get(CONF_PROJECT_ID)
        for e in our_entries
        if e.options.get("enabled", True)
    }

    # 1. Seed DATA_CONFIG early so a boot-time auto-setup of the core entry
    #    has a config to read.
    for e in our_entries:
        if not e.options.get("enabled", True):
            continue
        try:
            hass.data.setdefault(CORE_GA_DOMAIN, {})[CORE_GA_DATA_CONFIG] = (
                _build_core_config(e)
            )
            break
        except ValueError as exc:
            _LOGGER.debug("Skipping DATA_CONFIG seed for an entry: %s", exc)

    # 2. Prune orphan / duplicate core GA entries.
    seen: set[str | None] = set()
    try:
        core_entries = list(hass.config_entries.async_entries(CORE_GA_DOMAIN))
    except Exception as exc:
        _LOGGER.debug("Could not enumerate core GA entries: %s", exc)
        return

    for core_entry in core_entries:
        pid = core_entry.data.get(CONF_PROJECT_ID)
        if pid in valid_project_ids and pid not in seen:
            seen.add(pid)
            _LOGGER.debug(
                "Keeping core GA entry '%s' (project='%s')", core_entry.entry_id, pid
            )
            continue
        try:
            _LOGGER.debug(
                "Pruning stale/duplicate core GA entry '%s' (project='%s')",
                core_entry.entry_id,
                pid,
            )
            await hass.config_entries.async_remove(core_entry.entry_id)
        except Exception as exc:
            _LOGGER.warning(
                "Could not prune core GA entry '%s': %s", core_entry.entry_id, exc
            )


# ---------------------------------------------------------------------------
# Setup / teardown lifecycle
# ---------------------------------------------------------------------------


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Set up the Google Assistant Manual integration."""
    _LOGGER.debug("async_setup starting for %s v%s", DOMAIN, _get_version())
    hass.data.setdefault(DOMAIN, {})

    hass.data.setdefault(CORE_GA_DOMAIN, {})

    await _reconcile_core_ga_entries(hass)

    _patch_core_assistants(hass)

    await async_setup_frontend(hass)

    _register_entry_discovery(hass)

    _LOGGER.info(
        "Google Assistant (Manual) setup complete (version %s)", _get_version()
    )
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up from a config entry — bridge to core GA."""
    _LOGGER.debug(
        "async_setup_entry starting for project='%s' entry_id=%s",
        _project_id(entry),
        entry.entry_id,
    )

    hass.data.setdefault(DOMAIN, {})
    hass.data[DOMAIN][entry.entry_id] = entry

    _register_ws_commands(hass, entry)

    if entry.options.get("enabled", True):
        try:
            await _setup_core_ga(hass, entry)
        except Exception:
            _LOGGER.exception(
                "Failed to bridge to core GA for project='%s'. "
                "Integration will appear as disabled until re-enabled. "
                "Check that project_id and service_account are valid.",
                _project_id(entry),
            )
            entry.runtime_data = None
            return True

    _LOGGER.info(
        "Config entry set up for project='%s' (enabled=%s)",
        _project_id(entry),
        entry.options.get("enabled", True),
    )
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry — tear down core GA."""
    _LOGGER.debug(
        "async_unload_entry for project='%s' entry_id=%s",
        _project_id(entry),
        entry.entry_id,
    )

    try:
        await _teardown_core_ga(hass, entry)
    except Exception:
        _LOGGER.exception(
            "Error during core GA teardown for project='%s'",
            _project_id(entry),
        )

    hass.data[DOMAIN].pop(entry.entry_id, None)
    return True


async def async_remove_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Handle removal of a config entry — purge all entity exposure settings."""
    # Remove the matching core GA entry so it doesn't linger as an orphan.
    core_entry = _find_core_entry(hass, entry)
    if core_entry is not None:
        try:
            await hass.config_entries.async_remove(core_entry.entry_id)
            _LOGGER.debug(
                "Removed orphaned core GA entry '%s' on entry removal",
                core_entry.entry_id,
            )
        except Exception as exc:
            _LOGGER.warning("Could not remove core GA entry on removal: %s", exc)

    remaining = hass.config_entries.async_entries(DOMAIN)
    if len(remaining) > 1:
        _LOGGER.debug(
            "Skipping exposure cleanup: %d other entries remain for domain",
            len(remaining) - 1,
        )
        return

    _LOGGER.info(
        "Last config entry removed for '%s'. Cleaning up entity exposure data.",
        DOMAIN,
    )
    _purge_entity_exposure(hass)


async def async_reload_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Reload the config entry."""
    _LOGGER.debug(
        "async_reload_entry for project='%s'",
        _project_id(entry),
    )
    await async_unload_entry(hass, entry)
    await async_setup_entry(hass, entry)


# ---------------------------------------------------------------------------
# Core GA bridge
# ---------------------------------------------------------------------------


def _build_core_config(entry: ConfigEntry) -> dict[str, Any]:
    """Build the config dict that core GA expects (GOOGLE_ASSISTANT_SCHEMA).

    Raises ValueError if entry.data is missing CONF_PROJECT_ID
    (should never happen since config flow validates it).
    """
    project_id = entry.data.get(CONF_PROJECT_ID)
    if not project_id:
        raise ValueError(
            "Config entry data is missing 'project_id'. "
            "This indicates a corrupt entry — delete and re-add the integration."
        )

    config: dict[str, Any] = {
        CONF_PROJECT_ID: project_id,
        CONF_REPORT_STATE: False,
    }

    sa = entry.data.get(CONF_SERVICE_ACCOUNT, {})
    if isinstance(sa, dict) and sa:
        config[CONF_SERVICE_ACCOUNT] = {
            CONF_CLIENT_EMAIL: sa.get(CONF_CLIENT_EMAIL, ""),
            CONF_PRIVATE_KEY: sa.get(CONF_PRIVATE_KEY, ""),
        }
        config[CONF_REPORT_STATE] = entry.options.get(CONF_REPORT_STATE, False)
    elif sa:
        _LOGGER.warning(
            "service_account in entry data is not a dict (type=%s), ignoring",
            type(sa).__name__,
        )

    pin = entry.options.get(CONF_SECURE_DEVICES_PIN)
    if pin:
        config[CONF_SECURE_DEVICES_PIN] = pin

    _LOGGER.debug("Built core GA config with project_id='%s'", project_id)
    return config


def _make_core_entry(entry: ConfigEntry) -> ConfigEntry:
    """Create a real ConfigEntry for the core GA domain.

    Must be registered via hass.config_entries.async_add() before use
    so the device registry can link to it.
    """
    return ConfigEntry(
        version=1,
        minor_version=1,
        domain=CORE_GA_DOMAIN,
        title=entry.data[CONF_PROJECT_ID],
        data=entry.data,
        source="system",
        options={},
        entry_id=None,
        unique_id=None,
        discovery_keys={},
        subentries_data=(),
        pref_disable_new_entities=False,
        pref_disable_polling=False,
    )


def _register_sync_listeners(
    hass: HomeAssistant, entry: ConfigEntry, google_config: Any
) -> list[Any]:
    """Auto-trigger Google requestSync on exposure / area / registry changes.

    Mirrors the Nabu Casa Cloud GoogleConfig, which the core config-entry
    GoogleConfig does not do. Returns a list of unsubscribe callables.
    """
    from homeassistant.components.homeassistant.exposed_entities import (
        async_listen_entity_updates,
    )
    from homeassistant.helpers import device_registry as dr
    from homeassistant.helpers import entity_registry as er

    @callback
    def _schedule_sync() -> None:
        try:
            google_config.async_schedule_google_sync_all()
        except Exception:
            _LOGGER.debug("async_schedule_google_sync_all failed", exc_info=True)

    @callback
    def _on_exposed_entities_updated() -> None:
        _schedule_sync()

    @callback
    def _on_entity_registry_updated(event: Any) -> None:
        if (
            not entry.options.get("enabled", True)
            or hass.state is not CoreState.running
        ):
            return
        data = event.data
        # Ignore updates that don't change anything Google cares about.
        if data.get("action") == "update" and not (
            set(data.get("changes", {})) & er.ENTITY_DESCRIBING_ATTRIBUTES
        ):
            return
        entity_id = data.get("entity_id")
        if not entity_id or not google_config.should_expose(entity_id):
            return
        _schedule_sync()

    @callback
    def _on_device_registry_updated(event: Any) -> None:
        if (
            not entry.options.get("enabled", True)
            or hass.state is not CoreState.running
        ):
            return
        data = event.data
        if data.get("action") != "update" or "area_id" not in data.get("changes", {}):
            return
        # Only resync if an exposed entity inherits the device's area.
        ent_reg = er.async_get(hass)
        if not any(
            ent.area_id is None and google_config.should_expose(ent.entity_id)
            for ent in er.async_entries_for_device(ent_reg, data["device_id"])
        ):
            return
        _schedule_sync()

    unsubs: list[Any] = []
    try:
        unsubs.append(
            async_listen_entity_updates(
                hass, ASSISTANT_ID, _on_exposed_entities_updated
            )
        )
    except Exception:
        _LOGGER.debug("Could not register exposed-entities listener", exc_info=True)
    unsubs.append(
        hass.bus.async_listen(
            er.EVENT_ENTITY_REGISTRY_UPDATED, _on_entity_registry_updated
        )
    )
    unsubs.append(
        hass.bus.async_listen(
            dr.EVENT_DEVICE_REGISTRY_UPDATED, _on_device_registry_updated
        )
    )
    _LOGGER.debug("Registered %d auto-resync listeners", len(unsubs))
    return unsubs


async def _setup_core_ga(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Bridge config to core GA and activate it.

    Raises on failure — caller (async_setup_entry or ws_enable) must handle.
    """
    project_id = _project_id(entry)
    _LOGGER.debug("Bridging to core GA for project='%s'", project_id)

    try:
        config = _build_core_config(entry)
    except ValueError as exc:
        _LOGGER.error("Cannot build core GA config: %s", exc)
        raise

    if CORE_GA_DOMAIN not in hass.data:
        hass.data[CORE_GA_DOMAIN] = {CORE_GA_DATA_CONFIG: config}
    else:
        hass.data[CORE_GA_DOMAIN][CORE_GA_DATA_CONFIG] = config

    # Verify core GA is available (async_add below relies on it to set up the
    # registered entry). Fail with an actionable message if it is missing.
    try:
        import homeassistant.components.google_assistant  # noqa: F401
    except ImportError as exc:
        _LOGGER.error(
            "Cannot import core Google Assistant integration. "
            "Is the 'google_assistant' integration available? Error: %s",
            exc,
        )
        raise RuntimeError(
            "Core Google Assistant integration is not available. "
            "This integration requires the built-in 'google_assistant' component."
        ) from exc

    # Reuse the framework-registered core GA entry across restarts when one
    # already exists (it carries device-registry links). Only create a fresh
    # one on first enable. async_add() both registers AND sets up the entry, so
    # we must NOT call core GA's async_setup_entry ourselves.
    #
    # The core GA config entry has no async_unload_entry and registers an HTTP
    # view + local-SDK webhook that cannot be cleanly removed at runtime. So we
    # set it up at most once per process and never tear it down on disable —
    # disable is a soft toggle (see _teardown_core_ga): report_state is turned
    # off and should_expose is gated on entry.options["enabled"], so SYNC
    # returns no devices. This avoids the duplicate-webhook / unremovable-route
    # errors that add/remove churn produced.
    core_entry = _find_core_entry(hass, entry)
    if core_entry is None:
        core_entry = _make_core_entry(entry)
        await hass.config_entries.async_add(core_entry)
        _LOGGER.debug(
            "Registered + set up new core GA entry id=%s", core_entry.entry_id
        )
    elif core_entry.state is ConfigEntryState.LOADED:
        _LOGGER.debug("Reusing already-loaded core GA entry id=%s", core_entry.entry_id)
    else:
        # Persisted but not loaded (e.g. boot auto-setup failed before our
        # DATA_CONFIG was ready, or never ran). Drive it now that config exists.
        _LOGGER.debug(
            "Setting up existing core GA entry id=%s (state=%s)",
            core_entry.entry_id,
            core_entry.state,
        )
        await hass.config_entries.async_reload(core_entry.entry_id)

    google_config = core_entry.runtime_data

    if google_config is None:
        _LOGGER.error(
            "Core GA async_setup_entry returned but google_config is None. "
            "The Google Assistant functionality will not be available. "
            "Check that your service account credentials are valid."
        )
        raise RuntimeError(
            "Core GA setup did not produce a GoogleConfig instance. "
            "Check the Home Assistant logs for errors from the 'google_assistant' component."
        )

    entry.runtime_data = {"core_entry": core_entry, "google_config": google_config}
    hass.config_entries.async_update_entry(
        entry, options={**entry.options, "enabled": True}
    )

    _patch_google_config_properties(google_config, entry)

    # Ensure report_state matches the option — covers re-enabling after a soft
    # disable (which turned it off). async_enable_report_state is idempotent.
    if entry.options.get(CONF_REPORT_STATE):
        try:
            google_config.async_enable_report_state()
        except Exception:
            _LOGGER.debug(
                "async_enable_report_state on (re)enable failed", exc_info=True
            )

    # Cloud parity: auto requestSync when exposure/areas/registry change.
    entry.runtime_data["sync_unsubs"] = _register_sync_listeners(
        hass, entry, google_config
    )

    _LOGGER.info("Core GA successfully loaded for project '%s'", project_id)


async def _teardown_core_ga(
    hass: HomeAssistant, entry: ConfigEntry, *, disable: bool = False
) -> None:
    """Tear down or soft-disable core GA.

    ``disable=False`` (a plain unload/reload of our entry): leave the
    framework-registered core GA entry loaded and persisted so it survives the
    restart and keeps its device-registry links — just drop our runtime pointer.

    ``disable=True`` (the user toggled the integration off): **soft** disable.
    Core GA has no async_unload_entry and registers an HTTP view + local-SDK
    webhook that can't be cleanly removed at runtime, so we do NOT unload/remove
    the core entry. Instead we turn off report_state and set enabled=False; the
    patched should_expose then returns False for every entity, so SYNC reports
    no devices. (The core entry is fully removed only on entry deletion, or
    pruned on the next restart by _reconcile_core_ga_entries since it is then
    disabled.)
    """
    project_id = _project_id(entry)
    runtime = entry.runtime_data
    if not runtime:
        _LOGGER.debug("_teardown_core_ga: no runtime_data, already torn down")
        return

    if not isinstance(runtime, dict):
        _LOGGER.warning(
            "_teardown_core_ga: runtime_data is not a dict (type=%s), skipping teardown",
            type(runtime).__name__,
        )
        entry.runtime_data = None
        return

    # Remove auto-resync listeners (re-registered on the next setup/enable).
    for unsub in runtime.get("sync_unsubs", []):
        try:
            unsub()
        except Exception:
            _LOGGER.debug("Error removing auto-resync listener", exc_info=True)
    runtime["sync_unsubs"] = list[Any]()

    if not disable:
        # Unload/reload: keep the core GA entry intact, only drop our pointer.
        entry.runtime_data = None
        _LOGGER.debug(
            "Unloaded our entry for project='%s'; core GA entry left loaded",
            project_id,
        )
        return

    # Soft disable: stop report_state; should_expose gating handles the rest.
    google_config = runtime.get("google_config")
    if google_config is not None:
        try:
            google_config.async_disable_report_state()
            _LOGGER.debug("Disabled report_state for project='%s'", project_id)
        except Exception:
            _LOGGER.debug(
                "async_disable_report_state on disable failed for project='%s'",
                project_id,
                exc_info=True,
            )

    hass.config_entries.async_update_entry(
        entry, options={**entry.options, "enabled": False}
    )
    _LOGGER.info("Core GA soft-disabled for project '%s'", project_id)


# ---------------------------------------------------------------------------
# Entity exposure cleanup
# ---------------------------------------------------------------------------


def _purge_entity_exposure(hass: HomeAssistant) -> None:
    """Remove all entity exposure settings for this assistant."""
    _LOGGER.info("Purging entity exposure settings for assistant '%s'", ASSISTANT_ID)

    try:
        from homeassistant.components.homeassistant.const import (
            DATA_EXPOSED_ENTITIES,
        )
        from homeassistant.helpers import entity_registry as er

        exposed_entities = hass.data.get(DATA_EXPOSED_ENTITIES)

        # 1. Remove "expose new entities" preference
        if exposed_entities is not None:
            if ASSISTANT_ID in exposed_entities._assistants:
                del exposed_entities._assistants[ASSISTANT_ID]
                _LOGGER.debug(
                    "Removed '%s' from expose-new-entities preferences", ASSISTANT_ID
                )

            # 2. Remove from legacy entity settings
            cleaned = 0
            for entity_id in list(exposed_entities.entities):
                entity = exposed_entities.entities[entity_id]
                if ASSISTANT_ID in entity.assistants:
                    assistants = dict(entity.assistants)
                    del assistants[ASSISTANT_ID]
                    if assistants:
                        exposed_entities.entities[entity_id] = type(entity)(assistants)
                    else:
                        del exposed_entities.entities[entity_id]
                    cleaned += 1
            if cleaned:
                _LOGGER.debug(
                    "Removed '%s' from %d legacy entity settings",
                    ASSISTANT_ID,
                    cleaned,
                )

            exposed_entities._async_schedule_save()

        # 3. Remove from entity registry options
        ent_reg = er.async_get(hass)
        cleaned = 0
        for entity_id, entry in list(ent_reg.entities.items()):
            if ASSISTANT_ID in entry.options:
                options = dict(entry.options)
                del options[ASSISTANT_ID]
                ent_reg.async_update_entity_options(entity_id, options)
                cleaned += 1
        if cleaned:
            _LOGGER.info(
                "Removed '%s' assistant options from %d entity registry entries",
                ASSISTANT_ID,
                cleaned,
            )
    except Exception as exc:
        _LOGGER.warning(
            "Could not fully purge entity exposure for '%s': %s",
            ASSISTANT_ID,
            exc,
        )

    _LOGGER.info("Entity exposure cleanup for '%s' complete", ASSISTANT_ID)


# ---------------------------------------------------------------------------
# GoogleConfig live property patches
# ---------------------------------------------------------------------------

_ORIGINAL_GOOGLE_CONFIG_PROPS: dict[str, Any] = {}


def _patch_google_config_properties(google_config: Any, entry: ConfigEntry) -> None:
    """Monkey-patch GoogleConfig properties to read from our ConfigEntry options.

    Safe to call multiple times — original property getters are cached once.
    """
    gc_type = type(google_config)
    gc_type_name = gc_type.__name__ if hasattr(gc_type, "__name__") else str(gc_type)

    # Cache original getters (only on first call to avoid chaining)
    if "should_report_state" not in _ORIGINAL_GOOGLE_CONFIG_PROPS:
        try:
            desc = gc_type.should_report_state
            _ORIGINAL_GOOGLE_CONFIG_PROPS["should_report_state"] = desc.fget
            _LOGGER.debug("Cached original GoogleConfig.should_report_state getter")
        except AttributeError:
            _LOGGER.warning(
                "GoogleConfig (%s) has no should_report_state property. "
                "The 'Enable state reporting' toggle will not work correctly.",
                gc_type_name,
            )
            _ORIGINAL_GOOGLE_CONFIG_PROPS["should_report_state"] = None

    if "secure_devices_pin" not in _ORIGINAL_GOOGLE_CONFIG_PROPS:
        try:
            desc = gc_type.secure_devices_pin
            _ORIGINAL_GOOGLE_CONFIG_PROPS["secure_devices_pin"] = desc.fget
            _LOGGER.debug("Cached original GoogleConfig.secure_devices_pin getter")
        except AttributeError:
            _LOGGER.warning(
                "GoogleConfig (%s) has no secure_devices_pin property. "
                "The 'Security devices PIN' feature will not work correctly.",
                gc_type_name,
            )
            _ORIGINAL_GOOGLE_CONFIG_PROPS["secure_devices_pin"] = None

    # should_expose is a plain method (not a property) on the config-entry
    # GoogleConfig. The core implementation uses the legacy YAML exposure model
    # (expose_by_default / exposed_domains / entity_config), which our config
    # dict never populates. Bridge it to the modern exposed_entities registry
    # under our ASSISTANT_ID — the same key the UI expose page writes to.
    if "should_expose" not in _ORIGINAL_GOOGLE_CONFIG_PROPS:
        try:
            _ORIGINAL_GOOGLE_CONFIG_PROPS["should_expose"] = gc_type.should_expose
            _LOGGER.debug("Cached original GoogleConfig.should_expose method")
        except AttributeError:
            _LOGGER.warning(
                "GoogleConfig (%s) has no should_expose method. "
                "Entities exposed via the UI will not be synced to Google.",
                gc_type_name,
            )
            _ORIGINAL_GOOGLE_CONFIG_PROPS["should_expose"] = None

    orig_srs = _ORIGINAL_GOOGLE_CONFIG_PROPS["should_report_state"]
    orig_sdp = _ORIGINAL_GOOGLE_CONFIG_PROPS["secure_devices_pin"]
    orig_se = _ORIGINAL_GOOGLE_CONFIG_PROPS["should_expose"]

    def _should_report_state(self: Any) -> bool:
        if self is google_config:
            options = entry.options
            # A soft-disabled integration reports no state (mirrors cloud, which
            # gates should_report_state on enabled).
            return bool(options.get("enabled", True)) and bool(
                options.get(CONF_REPORT_STATE)
            )
        if orig_srs:
            return orig_srs(self)
        return False

    def _secure_devices_pin(self: Any) -> str | None:
        if self is google_config:
            options = entry.options
            return options.get(CONF_SECURE_DEVICES_PIN)
        if orig_sdp:
            return orig_sdp(self)
        return None

    def _should_expose(self: Any, entity_id: str) -> bool:
        if self is google_config:
            # Soft-disabled integration exposes nothing (SYNC returns no
            # devices) even though the core entry/view stay registered.
            if not entry.options.get("enabled", True):
                return False
            try:
                from homeassistant.components.homeassistant.exposed_entities import (
                    async_should_expose,
                )

                result = async_should_expose(self.hass, ASSISTANT_ID, entity_id)
                _LOGGER.debug(
                    "should_expose(%s) -> %s (registry key '%s')",
                    entity_id,
                    result,
                    ASSISTANT_ID,
                )
                return result
            except Exception:
                _LOGGER.exception(
                    "Failed to resolve exposure for '%s' via exposed_entities "
                    "registry. Falling back to core GoogleConfig.should_expose.",
                    entity_id,
                )
                if orig_se:
                    return orig_se(self, entity_id)
                return False
        if orig_se:
            return orig_se(self, entity_id)
        return False

    try:
        gc_type.should_report_state = property(_should_report_state)
        gc_type.secure_devices_pin = property(_secure_devices_pin)
        if orig_se:
            gc_type.should_expose = _should_expose
            _LOGGER.info(
                "Bridged GoogleConfig.should_expose to exposed_entities registry "
                "under '%s' on %s",
                ASSISTANT_ID,
                gc_type_name,
            )
        else:
            _LOGGER.warning(
                "GoogleConfig.should_expose NOT bridged (no original method on %s). "
                "UI-exposed entities will not sync to Google.",
                gc_type_name,
            )
        _LOGGER.debug(
            "Successfully patched GoogleConfig properties on %s", gc_type_name
        )
    except Exception:
        _LOGGER.exception(
            "Failed to patch GoogleConfig properties on %s. "
            "Report state and PIN settings will require a full reload to take effect.",
            gc_type_name,
        )


# ---------------------------------------------------------------------------
# WebSocket commands — entry discovery (always available)
# ---------------------------------------------------------------------------


def _register_entry_discovery(hass: HomeAssistant) -> None:
    """Register the entry_id discovery WS command (always available)."""

    @callback
    @websocket_api.require_admin
    @websocket_api.websocket_command(
        {
            vol.Required("type"): "google_assistant_manual/get_entry_id",
        }
    )
    def ws_get_entry_id(
        _hass: HomeAssistant,
        connection: websocket_api.ActiveConnection,
        msg: dict[str, Any],
    ) -> None:
        """Return the first config entry ID for this integration."""
        try:
            entries = _hass.config_entries.async_entries(DOMAIN)
        except Exception as exc:
            _LOGGER.exception("Failed to look up config entries in ws_get_entry_id")
            connection.send_error(
                msg["id"],
                "internal_error",
                f"Failed to look up config entries: {exc}",
            )
            return

        if not entries:
            _LOGGER.debug(
                "ws_get_entry_id: no config entries found for domain '%s'. "
                "The integration needs to be added via Settings → Devices & Services.",
                DOMAIN,
            )
            connection.send_error(
                msg["id"],
                "not_found",
                f"No config entry found for {DOMAIN}. "
                "Add the integration via Settings → Devices & Services → Add Integration.",
            )
            return

        entry_id = entries[0].entry_id
        _LOGGER.debug(
            "ws_get_entry_id: returning entry_id=%s for project='%s'",
            entry_id,
            _project_id(entries[0]),
        )
        connection.send_result(msg["id"], {"entry_id": entry_id})

    try:
        websocket_api.async_register_command(hass, ws_get_entry_id)
        _LOGGER.debug("Registered WS command: google_assistant_manual/get_entry_id")
    except Exception:
        _LOGGER.exception(
            "Failed to register WS command: google_assistant_manual/get_entry_id"
        )


# ---------------------------------------------------------------------------
# WebSocket commands — config entry operations
# ---------------------------------------------------------------------------

WS_CONFIG_SCHEMA = vol.Schema(
    {
        vol.Optional(CONF_REPORT_STATE): bool,
        vol.Optional(CONF_SECURE_DEVICES_PIN): vol.Any(str, None),
    }
)


def _safe_get_entry(
    hass: HomeAssistant,
    entry_id: str,
    ws_msg_id: int,
    ws_connection: websocket_api.ActiveConnection,
) -> ConfigEntry | None:
    """Look up a config entry safely, sending an error response on failure.

    Returns the ConfigEntry or None (error already sent).
    """
    try:
        entry = hass.config_entries.async_get_entry(entry_id)
    except Exception as exc:
        _LOGGER.exception("Error looking up config entry '%s'", entry_id)
        ws_connection.send_error(
            ws_msg_id,
            "internal_error",
            f"Failed to look up config entry: {exc}",
        )
        return None

    if entry is None:
        _LOGGER.debug(
            "WS command referenced unknown entry_id='%s'. "
            "The entry may have been deleted.",
            entry_id,
        )
        ws_connection.send_error(
            ws_msg_id,
            "not_found",
            "Config entry not found. It may have been deleted. "
            "Re-add the integration via Settings → Devices & Services.",
        )
        return None

    return entry


def _register_ws_commands(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Register WebSocket command handlers for the assistant card."""

    # -----------------------------------------------------------------------
    # get_config
    # -----------------------------------------------------------------------

    @callback
    @websocket_api.require_admin
    @websocket_api.websocket_command(
        {
            vol.Required("type"): WS_GET_CONFIG,
            vol.Required("entry_id"): str,
        }
    )
    def ws_get_config(
        _hass: HomeAssistant,
        connection: websocket_api.ActiveConnection,
        msg: dict[str, Any],
    ) -> None:
        """Return current config including enabled state."""
        current_entry = _safe_get_entry(_hass, msg["entry_id"], msg["id"], connection)
        if current_entry is None:
            return

        try:
            # enabled is the user's toggle state (entry options), which is the
            # source of truth. The core entry may stay loaded while soft-disabled,
            # so runtime_data presence is not a reliable signal.
            enabled = bool(current_entry.options.get("enabled", True))

            result = {
                "enabled": enabled,
                "yaml_suppressed": current_entry.options.get("yaml_suppressed", False),
                CONF_REPORT_STATE: current_entry.options.get(CONF_REPORT_STATE, False),
                CONF_SECURE_DEVICES_PIN: current_entry.options.get(
                    CONF_SECURE_DEVICES_PIN, ""
                ),
            }

            _LOGGER.debug(
                "ws_get_config for project='%s': enabled=%s report_state=%s",
                _project_id(current_entry),
                enabled,
                result[CONF_REPORT_STATE],
            )
            connection.send_result(msg["id"], result)
        except Exception as exc:
            _LOGGER.exception("Error building config response for ws_get_config")
            connection.send_error(
                msg["id"],
                "internal_error",
                f"Failed to read config: {exc}. Check Home Assistant logs for details.",
            )

    # -----------------------------------------------------------------------
    # update_config
    # -----------------------------------------------------------------------

    @callback
    @websocket_api.require_admin
    @websocket_api.websocket_command(
        {
            vol.Required("type"): WS_UPDATE_CONFIG,
            vol.Required("entry_id"): str,
            vol.Required("data"): WS_CONFIG_SCHEMA,
        }
    )
    def ws_update_config(
        _hass: HomeAssistant,
        connection: websocket_api.ActiveConnection,
        msg: dict[str, Any],
    ) -> None:
        """Update config options and trigger live patches."""
        current_entry = _safe_get_entry(_hass, msg["entry_id"], msg["id"], connection)
        if current_entry is None:
            return

        data: dict[str, Any] = msg["data"]
        project_id = _project_id(current_entry)
        _LOGGER.debug(
            "ws_update_config for project='%s': keys=%s",
            project_id,
            list(data.keys()),
        )

        try:
            new_options = {**current_entry.options}

            if CONF_REPORT_STATE in data:
                new_val = data[CONF_REPORT_STATE]
                new_options[CONF_REPORT_STATE] = new_val
                _LOGGER.info(
                    "Updated report_state=%s for project='%s'", new_val, project_id
                )

            if CONF_SECURE_DEVICES_PIN in data:
                pin_val = data[CONF_SECURE_DEVICES_PIN]
                new_options[CONF_SECURE_DEVICES_PIN] = pin_val
                _LOGGER.info(
                    "Updated secure_devices_pin=%s for project='%s'",
                    "<set>" if pin_val else "<cleared>",
                    project_id,
                )

            _hass.config_entries.async_update_entry(current_entry, options=new_options)

            # Live patch: enable/disable report_state without full reload
            runtime = current_entry.runtime_data
            google_config = (
                runtime.get("google_config") if isinstance(runtime, dict) else None
            )

            if google_config is not None and CONF_REPORT_STATE in data:
                try:
                    if data[CONF_REPORT_STATE]:
                        google_config.async_enable_report_state()
                        _LOGGER.debug(
                            "Live-enabled report_state for project='%s'", project_id
                        )
                    else:
                        google_config.async_disable_report_state()
                        _LOGGER.debug(
                            "Live-disabled report_state for project='%s'", project_id
                        )
                    # willReportState is a per-device attribute in the SYNC
                    # response, so re-sync to push the new value to Google.
                    google_config.async_schedule_google_sync_all()
                except Exception:
                    _LOGGER.exception(
                        "Failed to live-toggle report_state for project='%s'. "
                        "Toggle the integration off and on to apply.",
                        project_id,
                    )

            connection.send_result(msg["id"])
        except Exception as exc:
            _LOGGER.exception("Error in ws_update_config for project='%s'", project_id)
            connection.send_error(
                msg["id"],
                "internal_error",
                f"Failed to update config: {exc}. Check Home Assistant logs for details.",
            )

    # -----------------------------------------------------------------------
    # enable
    # -----------------------------------------------------------------------

    @callback
    @websocket_api.require_admin
    @websocket_api.websocket_command(
        {
            vol.Required("type"): WS_ENABLE,
            vol.Required("entry_id"): str,
        }
    )
    def ws_enable(
        _hass: HomeAssistant,
        connection: websocket_api.ActiveConnection,
        msg: dict[str, Any],
    ) -> None:
        """Enable core GA — re-run setup-phase re-trigger."""

        async def _enable() -> None:
            current_entry = _safe_get_entry(
                _hass, msg["entry_id"], msg["id"], connection
            )
            if current_entry is None:
                return

            project_id = _project_id(current_entry)
            _LOGGER.info("Enabling Google Assistant for project='%s'", project_id)

            try:
                await _setup_core_ga(_hass, current_entry)
                _LOGGER.info(
                    "Successfully enabled Google Assistant for project='%s'",
                    project_id,
                )
                connection.send_result(msg["id"])
            except RuntimeError as exc:
                _LOGGER.error(
                    "Failed to enable Google Assistant for project='%s': %s",
                    project_id,
                    exc,
                )
                connection.send_error(
                    msg["id"],
                    "setup_failed",
                    str(exc),
                )
            except Exception:
                _LOGGER.exception(
                    "Unexpected error enabling Google Assistant for project='%s'",
                    project_id,
                )
                connection.send_error(
                    msg["id"],
                    "setup_failed",
                    "An unexpected error occurred while enabling Google Assistant. "
                    "Check Home Assistant logs for the full traceback.",
                )

        _hass.async_create_task(_enable())

    # -----------------------------------------------------------------------
    # disable
    # -----------------------------------------------------------------------

    @callback
    @websocket_api.require_admin
    @websocket_api.websocket_command(
        {
            vol.Required("type"): WS_DISABLE,
            vol.Required("entry_id"): str,
        }
    )
    def ws_disable(
        _hass: HomeAssistant,
        connection: websocket_api.ActiveConnection,
        msg: dict[str, Any],
    ) -> None:
        """Disable core GA — tear down webhook, stop report_state."""

        async def _disable() -> None:
            current_entry = _safe_get_entry(
                _hass, msg["entry_id"], msg["id"], connection
            )
            if current_entry is None:
                return

            project_id = _project_id(current_entry)
            _LOGGER.info("Disabling Google Assistant for project='%s'", project_id)

            try:
                await _teardown_core_ga(_hass, current_entry, disable=True)
                _LOGGER.info(
                    "Successfully disabled Google Assistant for project='%s'",
                    project_id,
                )
                connection.send_result(msg["id"])
            except Exception as exc:
                _LOGGER.exception(
                    "Error disabling Google Assistant for project='%s'",
                    project_id,
                )
                connection.send_error(
                    msg["id"],
                    "teardown_failed",
                    f"Failed to disable integration: {exc}. "
                    "Check Home Assistant logs for details.",
                )

        _hass.async_create_task(_disable())

    # Register all four commands
    commands = [
        ("ws_get_config", ws_get_config),
        ("ws_update_config", ws_update_config),
        ("ws_enable", ws_enable),
        ("ws_disable", ws_disable),
    ]
    for name, handler in commands:
        try:
            websocket_api.async_register_command(hass, handler)
        except Exception:
            _LOGGER.exception("Failed to register WS command: %s", name)


# ---------------------------------------------------------------------------
# Core assistant + WS schema patching
# ---------------------------------------------------------------------------


def _patch_core_assistants(hass: HomeAssistant) -> None:
    """Patch core to accept our assistant ID."""
    # --- Patch KNOWN_ASSISTANTS tuple ---
    try:
        import homeassistant.components.homeassistant.exposed_entities as ee

        if ASSISTANT_ID not in ee.KNOWN_ASSISTANTS:
            ee.KNOWN_ASSISTANTS = tuple(list(ee.KNOWN_ASSISTANTS) + [ASSISTANT_ID])
            _LOGGER.info(
                "Added '%s' to KNOWN_ASSISTANTS (now: %s)",
                ASSISTANT_ID,
                ee.KNOWN_ASSISTANTS,
            )
        else:
            _LOGGER.debug("'%s' already in KNOWN_ASSISTANTS, skipping", ASSISTANT_ID)
    except ImportError as exc:
        _LOGGER.error(
            "Cannot import homeassistant.components.homeassistant.exposed_entities: %s. "
            "The voice assistants entity exposure UI will not include '%s'.",
            exc,
            ASSISTANT_ID,
        )
        return
    except Exception as exc:
        _LOGGER.exception(
            "Unexpected error patching KNOWN_ASSISTANTS: %s. "
            "The voice assistants UI may not show '%s'.",
            exc,
            ASSISTANT_ID,
        )
        return

    # --- Patch WS command schemas ---
    handlers: dict[str, Any] = hass.data.get("websocket_api", {})

    if not handlers:
        _LOGGER.warning(
            "websocket_api handlers not yet available; "
            "WS schema patching will be skipped. "
            "The entity exposure WS commands will not accept '%s'. "
            "This is expected during early startup; schemas should be patched "
            "when the frontend first makes an exposure WS call.",
            ASSISTANT_ID,
        )
        return

    patched = 0
    for cmd in _WSC_PATCH_TARGETS:
        if cmd not in handlers:
            _LOGGER.warning(
                "WS command '%s' not found in handlers. "
                "Schema will not be patched — the '%s' assistant may not appear "
                "in entity exposure dropdowns.",
                cmd,
                ASSISTANT_ID,
            )
            continue

        try:
            _handler, schema = handlers[cmd]
            _add_assistant_to_schema(schema, ASSISTANT_ID)
            patched += 1
            _LOGGER.info("Patched WS schema for '%s' to accept '%s'", cmd, ASSISTANT_ID)
        except Exception:
            _LOGGER.exception(
                "Failed to patch WS schema for '%s'. "
                "The '%s' assistant may not appear in entity exposure dropdowns "
                "for this command.",
                cmd,
                ASSISTANT_ID,
            )

    _LOGGER.debug(
        "WS schema patching complete: %d/%d targets patched",
        patched,
        len(_WSC_PATCH_TARGETS),
    )


def _add_assistant_to_schema(schema: object, assistant_id: str) -> None:
    """Recursively walk a voluptuous schema and add assistant_id to vol.In validators."""

    def _walk(obj: object, path: str = "root") -> None:
        try:
            if isinstance(obj, vol.In):
                container = getattr(obj, "container", None)
                if (
                    container is not None
                    and "conversation" in container
                    and assistant_id not in container
                ):
                    obj.container = list(container) + [assistant_id]
                    _LOGGER.debug(
                        "Schema walk [%s]: added '%s' to vol.In (was: %s)",
                        path,
                        assistant_id,
                        container,
                    )
            elif isinstance(obj, vol.Schema):
                _walk(obj.schema, f"{path}.Schema")
            elif isinstance(obj, dict):
                for key, value in obj.items():
                    _walk(value, f"{path}.{key}")
            elif isinstance(obj, (list, tuple)):
                for i, item in enumerate(obj):
                    _walk(item, f"{path}[{i}]")
        except Exception:
            _LOGGER.exception(
                "Error walking schema at path '%s' (type=%s). "
                "This may indicate the core WS schema structure has changed. "
                "Schema patching will continue for other nodes.",
                path,
                type(obj).__name__,
            )

    _walk(schema)


# ---------------------------------------------------------------------------
# Version helper
# ---------------------------------------------------------------------------


def _get_version() -> str:
    """Return the integration version from manifest.json."""
    return _VERSION
