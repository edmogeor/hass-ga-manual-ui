"""Google Assistant Manual integration.

Adds a "Google Assistant (Manual)" entry under voice assistants when exposing
a device, without requiring Nabu Casa Cloud.
"""

import logging

import voluptuous as vol

from homeassistant.core import HomeAssistant
from homeassistant.helpers.typing import ConfigType

from .const import ASSISTANT_ID, DOMAIN
from .frontend import async_setup_frontend

_LOGGER = logging.getLogger(__name__)

_WSC_PATCH_TARGETS = (
    "homeassistant/expose_entity",
    "homeassistant/expose_new_entities/get",
    "homeassistant/expose_new_entities/set",
)


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Set up the Google Assistant Manual integration."""
    hass.data.setdefault(DOMAIN, {})

    _patch_core_assistants(hass)

    await async_setup_frontend(hass)

    _LOGGER.info("Google Assistant (Manual) is set up")
    return True


def _patch_core_assistants(hass: HomeAssistant) -> None:
    """Patch core to accept our assistant ID."""
    try:
        import homeassistant.components.homeassistant.exposed_entities as ee

        if ASSISTANT_ID not in ee.KNOWN_ASSISTANTS:
            ee.KNOWN_ASSISTANTS = tuple(list(ee.KNOWN_ASSISTANTS) + [ASSISTANT_ID])
            _LOGGER.debug("Added %s to KNOWN_ASSISTANTS", ASSISTANT_ID)
    except Exception as exc:
        _LOGGER.error("Failed to patch KNOWN_ASSISTANTS: %s", exc)
        return

    handlers: dict = hass.data.get("websocket_api", {})

    if not handlers:
        _LOGGER.debug(
            "websocket_api handlers not yet available; "
            "WS schema patching will be skipped"
        )
        return

    for cmd in _WSC_PATCH_TARGETS:
        if cmd not in handlers:
            _LOGGER.debug("WS command %s not found in handlers", cmd)
            continue
        _handler, schema = handlers[cmd]
        _add_assistant_to_schema(schema, ASSISTANT_ID)
        _LOGGER.info("Patched WS schema for %s", cmd)


def _add_assistant_to_schema(schema: object, assistant_id: str) -> None:
    """Recursively walk a voluptuous schema and add assistant_id to vol.In validators."""

    def _walk(obj: object) -> None:
        if isinstance(obj, vol.In):
            container = getattr(obj, "container", None)
            if container is not None and "conversation" in container:
                if assistant_id not in container:
                    obj.container = list(container) + [assistant_id]
        elif isinstance(obj, vol.Schema):
            _walk(obj.schema)
        elif isinstance(obj, dict):
            for value in obj.values():
                _walk(value)
        elif isinstance(obj, (list, tuple)):
            for item in obj:
                _walk(item)

    _walk(schema)
