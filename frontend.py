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
        _LOGGER.warning("Frontend companion JS not found at %s", FRONTEND_JS_PATH)
        return

    await hass.http.async_register_static_paths(
        [
            StaticPathConfig(
                FRONTEND_URL,
                str(FRONTEND_JS_PATH),
                cache_headers=False,
            ),
            StaticPathConfig(
                ASSETS_URL,
                str(ASSETS_PATH),
                cache_headers=True,
            ),
        ]
    )

    if DATA_EXTRA_MODULE_URL not in hass.data:
        from homeassistant.components.frontend import UrlManager

        hass.data[DATA_EXTRA_MODULE_URL] = UrlManager(lambda *_: None, [])

    add_extra_js_url(hass, FRONTEND_URL)
    _LOGGER.info("Registered frontend companion module: %s", FRONTEND_URL)
