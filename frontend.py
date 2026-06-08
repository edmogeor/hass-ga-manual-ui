"""Register the companion frontend module that patches the voice assistants UI."""

import logging
from pathlib import Path

from homeassistant.components.frontend import (
    DATA_EXTRA_MODULE_URL,
    add_extra_js_url,
)
from homeassistant.components.http import StaticPathConfig
from homeassistant.core import HomeAssistant

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

FRONTEND_JS_PATH = Path(__file__).parent / "frontend.js"
FRONTEND_URL = f"/{DOMAIN}/frontend.js"
ASSETS_PATH = Path(__file__).parent / "assets"
ASSETS_URL = f"/{DOMAIN}/assets"


async def async_setup_frontend(hass: HomeAssistant) -> None:
    """Set up the frontend companion module."""
    if not FRONTEND_JS_PATH.exists():
        _LOGGER.error(
            "Frontend companion JS not found at %s. "
            "The Google Assistant (Manual) card will not appear in the voice "
            "assistants UI. Ensure 'frontend.js' is present in the integration directory.",
            FRONTEND_JS_PATH,
        )
        return

    if not ASSETS_PATH.exists():
        _LOGGER.warning(
            "Assets directory not found at %s. "
            "The Google Assistant brand icon may not render correctly.",
            ASSETS_PATH,
        )
    elif not (ASSETS_PATH / "icon.png").exists():
        _LOGGER.warning(
            "Brand icon not found at %s/icon.png. "
            "The Google Assistant card will appear without a brand icon.",
            ASSETS_PATH,
        )

    try:
        static_configs = [
            StaticPathConfig(
                FRONTEND_URL,
                str(FRONTEND_JS_PATH),
                cache_headers=False,
            ),
        ]
        if ASSETS_PATH.exists():
            static_configs.append(
                StaticPathConfig(
                    ASSETS_URL,
                    str(ASSETS_PATH),
                    cache_headers=True,
                )
            )

        await hass.http.async_register_static_paths(static_configs)
        _LOGGER.debug("Registered static paths: %s, %s", FRONTEND_URL, ASSETS_URL)
    except Exception as exc:
        _LOGGER.exception(
            "Failed to register static paths. "
            "The Google Assistant (Manual) frontend companion will not load. "
            "This may indicate an incompatible Home Assistant version. Error: %s",
            exc,
        )
        return

    try:
        if DATA_EXTRA_MODULE_URL not in hass.data:
            from homeassistant.components.frontend import UrlManager

            hass.data[DATA_EXTRA_MODULE_URL] = UrlManager(lambda *_: None, [])
            _LOGGER.debug("Initialized UrlManager for extra JS modules")

        add_extra_js_url(hass, FRONTEND_URL)
        _LOGGER.info("Registered frontend companion module: %s", FRONTEND_URL)
    except ImportError as exc:
        _LOGGER.error(
            "Cannot import Home Assistant frontend module: %s. "
            "The frontend companion JS will not be loaded. "
            "This may indicate an incompatible Home Assistant version.",
            exc,
        )
    except Exception:
        _LOGGER.exception(
            "Failed to register extra JS URL. "
            "The Google Assistant (Manual) card will not appear in the UI."
        )
