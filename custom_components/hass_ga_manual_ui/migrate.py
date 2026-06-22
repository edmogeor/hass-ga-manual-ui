"""Migrate / import / export of core-GA `google_assistant:` YAML config.

One shared YAML shape (core GA's `google_assistant:` schema) feeds three callers:
the config-flow migrate checkbox, the card's import button, and the card's export
button. Migrate and import both parse with the permissive ``GA_CONFIG_SCHEMA`` and
apply via ``apply_ga_config``; export builds a strict, standalone-valid block and
validates it against core GA's own schema before dumping.
"""

import logging
from typing import Any

import homeassistant.helpers.config_validation as cv
import voluptuous as vol
import yaml
from homeassistant.core import HomeAssistant, split_entity_id
from homeassistant.util import dt as dt_util

from .const import (
    ASSISTANT_ID,
    CONF_CLIENT_EMAIL,
    CONF_PRIVATE_KEY,
    CONF_PROJECT_ID,
    CONF_REPORT_STATE,
    CONF_SECURE_DEVICES_PIN,
    CONF_SERVICE_ACCOUNT,
    CORE_GA_DOMAIN,
    DOMAIN,
)

_LOGGER = logging.getLogger(__name__)

# YAML dumper that uses literal block style (|) for multi-line strings so
# private keys render cleanly instead of as indented single-quoted blocks.
try:
    from yaml import CSafeDumper as _BaseSafeDumper
except ImportError:
    from yaml import SafeDumper as _BaseSafeDumper


class _ExportDumper(_BaseSafeDumper):  # pyrefly: ignore[invalid-inheritance]
    """YAML dumper that emits multi-line strings as literal block scalars."""


def _str_representer(dumper: yaml.Dumper, data: str) -> Any:
    """Represent multi-line strings with | (literal block) style."""
    if "\n" in data:
        return dumper.represent_scalar("tag:yaml.org,2002:str", data, style="|")
    return dumper.represent_str(data)


_ExportDumper.add_representer(str, _str_representer)


# Core-GA YAML keys (google_assistant/const.py). These are our import/export wire
# format and are stable; literals avoid a module-level core-GA import (which pulls
# in heavy optional deps). DEFAULT_EXPOSED_DOMAINS is imported lazily at use.
_C_EXPOSE = "expose"
_C_EXPOSE_BY_DEFAULT = "expose_by_default"
_C_EXPOSED_DOMAINS = "exposed_domains"
_C_ENTITY_CONFIG = "entity_config"
_C_ALIASES = "aliases"
_C_NAME = "name"
_C_ROOM = "room"

# Permissive schema for IMPORT + MIGRATE input. Everything optional;
# apply_ga_config never touches credentials, but the import handler adopts a
# complete project_id + service_account via import_credentials(). ALLOW_EXTRA so
# a hand-written or older file with deprecated keys still parses.
_ENTITY_CONFIG_SCHEMA = vol.Schema(
    {
        vol.Optional(_C_EXPOSE): cv.boolean,
        vol.Optional(_C_ALIASES): vol.All(cv.ensure_list, [cv.string]),
        vol.Optional(_C_NAME): cv.string,
        vol.Optional(_C_ROOM): cv.string,
    },
    extra=vol.ALLOW_EXTRA,
)

GA_CONFIG_SCHEMA = vol.Schema(
    {
        vol.Optional(CONF_PROJECT_ID): cv.string,
        vol.Optional(CONF_REPORT_STATE): cv.boolean,
        vol.Optional(CONF_SECURE_DEVICES_PIN): vol.Any(str, None),
        vol.Optional(_C_EXPOSE_BY_DEFAULT): cv.boolean,
        vol.Optional(_C_EXPOSED_DOMAINS): cv.ensure_list,
        vol.Optional(_C_ENTITY_CONFIG): {cv.entity_id: _ENTITY_CONFIG_SCHEMA},
        vol.Optional(CONF_SERVICE_ACCOUNT): dict,
    },
    extra=vol.ALLOW_EXTRA,
)


def _all_entity_ids(hass: HomeAssistant) -> set[str]:
    """Return every entity id known to states or the entity registry."""
    from homeassistant.helpers import entity_registry as er

    ent_reg = er.async_get(hass)
    return set(hass.states.async_entity_ids()) | set(ent_reg.entities)


def _yaml_should_expose(
    hass: HomeAssistant,
    entity_id: str,
    expose_by_default: bool,
    exposed_domains: list[str],
    entity_config: dict[str, Any],
) -> bool:
    """Core GA's YAML exposure rule, hand-copied from google_assistant/http.py.

    Reimplemented (vs instantiating a real GoogleConfig) to keep migration light;
    the unit test pins this against core so drift is caught.
    """
    from homeassistant.helpers import entity_registry as er

    registry_entry = er.async_get(hass).async_get(entity_id)
    if registry_entry:
        auxiliary_entity = (
            registry_entry.entity_category is not None
            or registry_entry.hidden_by is not None
        )
    else:
        auxiliary_entity = False

    explicit_expose = entity_config.get(entity_id, {}).get(_C_EXPOSE)
    domain_exposed_by_default = (
        expose_by_default and split_entity_id(entity_id)[0] in exposed_domains
    )
    entity_exposed_by_default = domain_exposed_by_default and not auxiliary_entity
    is_default_exposed = entity_exposed_by_default and explicit_expose is not False
    return bool(is_default_exposed or explicit_expose)


def _str_aliases(aliases: Any) -> list[str]:
    """Existing registry aliases as plain strings (drops the COMPUTED_NAME sentinel).

    Works for both the current ``list[AliasEntry]`` and the legacy ``set[str]``
    registry models.
    """
    return [a for a in aliases if isinstance(a, str)]


def _merge_aliases(existing: Any, added: list[str]) -> Any:
    """Additively merge ``added`` into ``existing``, preserving container type.

    Keeps any non-str sentinels (e.g. COMPUTED_NAME) and, for lists, order.
    """
    existing_str = _str_aliases(existing)
    new = [a for a in added if a not in existing_str]
    if not new:
        return None
    if isinstance(existing, set):
        return existing | set(new)
    return list(existing) + new


def apply_ga_config(
    hass: HomeAssistant, entry: Any, cfg: dict[str, Any]
) -> dict[str, int]:
    """Apply a parsed core-GA config block to our settings (migrate + import).

    Exposure/flags live under our assistant id, so they are an authoritative
    replace. Aliases live in the shared entity registry, so they are merged
    additively and never clobbered. Returns a counts summary.
    """
    from homeassistant.components.homeassistant.const import DATA_EXPOSED_ENTITIES
    from homeassistant.components.homeassistant.exposed_entities import (
        DEFAULT_EXPOSED_DOMAINS as _DEFAULT,
    )
    from homeassistant.components.homeassistant.exposed_entities import (
        async_expose_entity,
    )
    from homeassistant.helpers import entity_registry as er

    summary = {"exposed": 0, "hidden": 0, "aliases_added": 0}

    # 1. report_state + secure_devices_pin -> our entry options.
    new_options = {**entry.options}
    report_state = cfg.get(CONF_REPORT_STATE)
    if report_state is not None:
        new_options[CONF_REPORT_STATE] = bool(report_state)
    if CONF_SECURE_DEVICES_PIN in cfg:
        new_options[CONF_SECURE_DEVICES_PIN] = cfg[CONF_SECURE_DEVICES_PIN] or ""
    hass.config_entries.async_update_entry(entry, options=new_options)

    expose_by_default = bool(cfg.get(_C_EXPOSE_BY_DEFAULT, True))
    exposed_domains = list(cfg.get(_C_EXPOSED_DOMAINS) or _DEFAULT)
    entity_config: dict[str, Any] = cfg.get(_C_ENTITY_CONFIG, {})

    # 2. expose_new <- expose_by_default (approximation for future entities).
    exposed_entities = hass.data.get(DATA_EXPOSED_ENTITIES)
    if exposed_entities is not None:
        exposed_entities.async_set_expose_new_entities(ASSISTANT_ID, expose_by_default)

    # 3. Per-entity exposure: compute YAML exposure and write it explicitly.
    for entity_id in _all_entity_ids(hass):
        should = _yaml_should_expose(
            hass, entity_id, expose_by_default, exposed_domains, entity_config
        )
        async_expose_entity(hass, ASSISTANT_ID, entity_id, should)
        summary["exposed" if should else "hidden"] += 1

    # 4. Aliases: additive merge into the shared registry (never clobber).
    ent_reg = er.async_get(hass)
    for entity_id, ent_cfg in entity_config.items():
        added = [a.strip() for a in ent_cfg.get(_C_ALIASES, []) if a and a.strip()]
        if not added:
            continue
        reg_entry = ent_reg.async_get(entity_id)
        if reg_entry is None:
            # YAML can list stale ids; async_update_entity raises on unknown ones.
            continue
        try:
            merged = _merge_aliases(reg_entry.aliases, added)
            if merged is None:
                continue
            ent_reg.async_update_entity(entity_id, aliases=merged)
            summary["aliases_added"] += len(_str_aliases(merged)) - len(
                _str_aliases(reg_entry.aliases)
            )
        except Exception:
            _LOGGER.warning(
                "Could not merge aliases for '%s'; skipping", entity_id, exc_info=True
            )

    # 5. report_state live side effects (None-safe; skipped when disabled).
    if report_state is not None:
        from . import _live_toggle_report_state, _our_google_config, _project_id

        _live_toggle_report_state(
            _our_google_config(hass), bool(report_state), _project_id(entry)
        )

    _LOGGER.info("Applied GA config: %s", summary)
    return summary


def import_credentials(
    cfg: dict[str, Any], current: dict[str, Any] | None = None
) -> dict[str, Any] | None:
    """Pull adoptable credentials out of an imported config block, else None.

    Only returns a value when the file carries a *complete* service account
    (both ``client_email`` and ``private_key``); ``project_id`` rides along when
    present. A bare ``project_id`` without a matching key is ignored, the active
    credentials stay owned by whatever set the entry up.

    When ``current`` (the entry's existing ``data``) is given, returns None if
    the file's credentials already match it, so an import that only changes
    settings does not re-verify against Google or trigger a needless reload.
    """
    sa = cfg.get(CONF_SERVICE_ACCOUNT)
    if not isinstance(sa, dict):
        return None
    email = sa.get(CONF_CLIENT_EMAIL)
    key = sa.get(CONF_PRIVATE_KEY)
    if not email or not key:
        return None
    out: dict[str, Any] = {
        CONF_SERVICE_ACCOUNT: {CONF_CLIENT_EMAIL: email, CONF_PRIVATE_KEY: key}
    }
    if cfg.get(CONF_PROJECT_ID):
        out[CONF_PROJECT_ID] = cfg[CONF_PROJECT_ID]
    if current is not None:
        cur_sa = current.get(CONF_SERVICE_ACCOUNT) or {}
        unchanged = (
            cur_sa.get(CONF_CLIENT_EMAIL) == email
            and cur_sa.get(CONF_PRIVATE_KEY) == key
            and (
                CONF_PROJECT_ID not in out
                or out[CONF_PROJECT_ID] == current.get(CONF_PROJECT_ID)
            )
        )
        if unchanged:
            return None
    return out


def export_filename(entry: Any) -> str:
    """`hass-ga-manual-ui_<project_id>_<YYYY-MM-DD>.yaml` (tracks the domain)."""
    base = DOMAIN.replace("_", "-")
    project_id = entry.data.get(CONF_PROJECT_ID, "config")
    return f"{base}_{project_id}_{dt_util.now():%Y-%m-%d}.yaml"


def export_ga_config(hass: HomeAssistant, entry: Any) -> str:
    """Build a strict, standalone-valid `google_assistant:` block and dump it to YAML.

    The dict is validated against core GA's own GOOGLE_ASSISTANT_SCHEMA so the file
    is guaranteed to load as a standalone manual `google_assistant` config.
    """
    from homeassistant.components.google_assistant import GOOGLE_ASSISTANT_SCHEMA
    from homeassistant.components.homeassistant.exposed_entities import (
        async_should_expose,
    )
    from homeassistant.helpers import entity_registry as er

    cfg: dict[str, Any] = {CONF_PROJECT_ID: entry.data[CONF_PROJECT_ID]}

    # Always include service_account: core GA rejects report_state without it.
    sa = entry.data.get(CONF_SERVICE_ACCOUNT, {})
    if isinstance(sa, dict) and sa:
        cfg[CONF_SERVICE_ACCOUNT] = {
            CONF_PRIVATE_KEY: sa.get(CONF_PRIVATE_KEY, ""),
            CONF_CLIENT_EMAIL: sa.get(CONF_CLIENT_EMAIL, ""),
        }

    cfg[CONF_REPORT_STATE] = bool(entry.options.get(CONF_REPORT_STATE, False))

    pin = entry.options.get(CONF_SECURE_DEVICES_PIN)
    if pin:  # omit the "" cleared sentinel
        cfg[CONF_SECURE_DEVICES_PIN] = pin

    # Per-entity model: expose_by_default false + an explicit expose list.
    cfg[_C_EXPOSE_BY_DEFAULT] = False
    ent_reg = er.async_get(hass)
    entity_config: dict[str, Any] = {}
    for entity_id in sorted(_all_entity_ids(hass)):
        if not async_should_expose(hass, ASSISTANT_ID, entity_id):
            continue
        entry_cfg: dict[str, Any] = {_C_EXPOSE: True}
        reg_entry = ent_reg.async_get(entity_id)
        if reg_entry is not None:
            aliases = sorted(_str_aliases(reg_entry.aliases))
            if aliases:
                entry_cfg[_C_ALIASES] = aliases
        entity_config[entity_id] = entry_cfg
    if entity_config:
        cfg[_C_ENTITY_CONFIG] = entity_config

    # Standalone guarantee: must validate against core GA's real schema.
    GOOGLE_ASSISTANT_SCHEMA(cfg)

    return yaml.dump(
        {CORE_GA_DOMAIN: cfg},
        default_flow_style=False,
        allow_unicode=True,
        sort_keys=False,
        Dumper=_ExportDumper,
    ).replace(": null\n", ":\n")
