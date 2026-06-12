"""Load integration-custom localized strings from `locale/<lang>.json`.

These strings (`yaml_notice`, `install_notice`, and the `frontend` card table)
live outside Home Assistant's translation files because hassfest only permits
HA's fixed translation schema. They are served to the frontend over HTTP (see
frontend.py) and read here for server-side use in the config flow.
"""

from __future__ import annotations

import json
import logging
from functools import cache
from pathlib import Path
from typing import Any

from homeassistant.core import HomeAssistant

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

LOCALE_DIR = Path(__file__).parent / "locale"
LOCALE_URL = f"/{DOMAIN}/locale"
_DEFAULT_LANG = "en"


@cache
def _read(lang: str) -> dict[str, Any]:
    """Read one locale file, or {} if it's missing/unreadable."""
    try:
        return json.loads((LOCALE_DIR / f"{lang}.json").read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as exc:
        _LOGGER.debug("Could not read locale '%s': %s", lang, exc)
        return {}


def _candidates(language: str) -> list[str]:
    """English first, then base language, then the exact tag (precedence order)."""
    langs = [_DEFAULT_LANG]
    if language:
        base = language.split("-")[0]
        if base and base != _DEFAULT_LANG:
            langs.append(base)
        if language not in langs:
            langs.append(language)
    return langs


async def async_load_locale(hass: HomeAssistant, language: str) -> dict[str, Any]:
    """Return the custom strings for `language`, falling back to English."""

    def _load() -> dict[str, Any]:
        result: dict[str, Any] = {}
        for lang in _candidates(language):
            result.update(_read(lang))
        return result

    return await hass.async_add_executor_job(_load)
