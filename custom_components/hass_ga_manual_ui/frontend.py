"""Register the companion frontend module that patches the voice assistants UI."""

import hashlib
import logging
from pathlib import Path

from homeassistant.components.frontend import (
    DATA_EXTRA_MODULE_URL,
    add_extra_js_url,
)
from homeassistant.components.http import StaticPathConfig
from homeassistant.core import HomeAssistant

from .const import DOMAIN
from .locale import LOCALE_DIR, LOCALE_URL

_LOGGER = logging.getLogger(__name__)

FRONTEND_JS_PATH = Path(__file__).parent / "frontend.js"
FRONTEND_URL = f"/{DOMAIN}/frontend.js"

BRAND_DIR = Path(__file__).parent / "brand"
BRAND_URL = f"/{DOMAIN}/brand"


def _compute_js_hash() -> str:
    """Return a short content hash of the frontend bundle for cache-busting."""
    return hashlib.sha256(FRONTEND_JS_PATH.read_bytes()).hexdigest()[:12]


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

    # Content-hash the bundle so the browser can cache it long-term while still
    # re-fetching whenever it changes (the hash, and thus the URL, changes too).
    # If hashing fails for any reason, fall back to serving uncached.
    try:
        digest: str | None = await hass.async_add_executor_job(_compute_js_hash)
    except OSError as exc:
        _LOGGER.warning(
            "Could not hash frontend.js (%s); serving without cache headers.", exc
        )
        digest = None

    versioned_url = f"{FRONTEND_URL}?v={digest}" if digest else FRONTEND_URL

    try:
        await hass.http.async_register_static_paths(
            [
                StaticPathConfig(
                    FRONTEND_URL,
                    str(FRONTEND_JS_PATH),
                    cache_headers=digest is not None,
                ),
                # Serve the custom localized strings (config notices + card
                # text). Uncached so updated translations take effect on the
                # next page load without a hashed URL.
                StaticPathConfig(LOCALE_URL, str(LOCALE_DIR), cache_headers=False),
                # Serve our bundled brand icons so the frontend never depends on
                # the brands CDN (which 404s/errors for this manual integration).
                StaticPathConfig(BRAND_URL, str(BRAND_DIR), cache_headers=True),
            ]
        )
        _LOGGER.debug(
            "Registered static paths: %s, %s, %s",
            FRONTEND_URL,
            LOCALE_URL,
            BRAND_URL,
        )
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

        add_extra_js_url(hass, versioned_url)
        _LOGGER.info("Registered frontend companion module: %s", versioned_url)
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
