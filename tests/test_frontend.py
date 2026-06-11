"""Tests for hass_ga_manual_ui/frontend.py."""

import logging
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import hass_ga_manual_ui.frontend as frontend_module
import pytest
from hass_ga_manual_ui.const import DOMAIN
from hass_ga_manual_ui.frontend import (
    FRONTEND_JS_PATH,
    FRONTEND_URL,
    async_setup_frontend,
)
from homeassistant.core import HomeAssistant


class TestPathConstants:
    """Test the path constants defined in frontend.py."""

    def test_frontend_js_path_is_absolute(self) -> None:
        assert FRONTEND_JS_PATH.is_absolute()

    def test_frontend_js_path_exists(self) -> None:
        assert FRONTEND_JS_PATH.exists()

    def test_frontend_js_path_points_to_correct_file(self) -> None:
        assert FRONTEND_JS_PATH.name == "frontend.js"

    def test_frontend_url_includes_domain(self) -> None:
        assert f"/{DOMAIN}/frontend.js" == FRONTEND_URL
        assert FRONTEND_URL.startswith("/")


def _make_hass() -> MagicMock:
    """Create a mock HomeAssistant with async HTTP support."""
    hass = MagicMock(spec=HomeAssistant)
    hass.http.async_register_static_paths = AsyncMock()
    # Run executor jobs inline so _compute_js_hash actually executes in tests.
    hass.async_add_executor_job = AsyncMock(side_effect=lambda func, *a: func(*a))
    return hass


class TestAsyncSetupFrontend:
    """Tests for async_setup_frontend."""

    @pytest.mark.asyncio
    async def test_registers_static_paths(self) -> None:
        """Test that the static path is registered for frontend.js."""
        hass = _make_hass()
        hass.data = {}

        with patch.object(frontend_module, "add_extra_js_url") as mock_add_js:
            await async_setup_frontend(hass)

        hass.http.async_register_static_paths.assert_called_once()
        call_args = hass.http.async_register_static_paths.call_args[0][0]
        assert len(call_args) == 1
        assert any(c.url_path == FRONTEND_URL for c in call_args)
        # The advertised URL is cache-busted with a content hash; the static
        # path itself stays at the unversioned URL.
        mock_add_js.assert_called_once()
        advertised_url = mock_add_js.call_args[0][1]
        assert advertised_url.startswith(f"{FRONTEND_URL}?v=")

    @pytest.mark.asyncio
    async def test_handles_missing_frontend_js(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        """When frontend.js doesn't exist, an error is logged and returns early."""
        hass = MagicMock(spec=HomeAssistant)

        def mock_exists(self: Path) -> bool:
            return False

        with (
            patch.object(Path, "exists", mock_exists),
            caplog.at_level(logging.ERROR),
        ):
            await async_setup_frontend(hass)

        assert any("not found" in r.message for r in caplog.records)
        hass.http.async_register_static_paths.assert_not_called()

    @pytest.mark.asyncio
    async def test_registers_url_manager_when_not_present(self) -> None:
        """When UrlManager isn't in hass.data, it gets initialized."""
        hass = _make_hass()
        hass.data = {}

        with patch.object(frontend_module, "add_extra_js_url") as mock_add_js:
            await async_setup_frontend(hass)

        from homeassistant.components.frontend import DATA_EXTRA_MODULE_URL

        assert DATA_EXTRA_MODULE_URL in hass.data
        mock_add_js.assert_called_once()

    @pytest.mark.asyncio
    async def test_uses_existing_url_manager(self) -> None:
        """When UrlManager is already in hass.data, it is reused."""
        from homeassistant.components.frontend import DATA_EXTRA_MODULE_URL

        hass = _make_hass()
        existing_manager = MagicMock()
        hass.data = {DATA_EXTRA_MODULE_URL: existing_manager}

        with patch.object(frontend_module, "add_extra_js_url") as mock_add_js:
            await async_setup_frontend(hass)

        assert hass.data[DATA_EXTRA_MODULE_URL] is existing_manager
        mock_add_js.assert_called_once()
        assert mock_add_js.call_args[0][1].startswith(f"{FRONTEND_URL}?v=")

    @pytest.mark.asyncio
    async def test_handles_static_path_registration_failure(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        """If registering static paths fails, logs error and returns early."""
        hass = _make_hass()
        hass.http.async_register_static_paths = AsyncMock(
            side_effect=RuntimeError("HTTP subsystem not ready")
        )

        with caplog.at_level(logging.ERROR):
            await async_setup_frontend(hass)

        assert any(
            "Failed to register static paths" in r.message for r in caplog.records
        )

    @pytest.mark.asyncio
    async def test_handles_add_extra_js_url_import_error(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        """If UrlManager import fails, error is logged."""
        hass = _make_hass()
        hass.data = {}

        with (
            patch(
                "homeassistant.components.frontend.UrlManager",
                side_effect=ImportError("No module named 'frontend'"),
            ),
            caplog.at_level(logging.ERROR),
        ):
            await async_setup_frontend(hass)

        assert any(
            "Cannot import Home Assistant frontend module" in r.message
            for r in caplog.records
        )

    @pytest.mark.asyncio
    async def test_handles_add_extra_js_url_generic_exception(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        """A generic exception during JS URL registration is logged."""
        hass = _make_hass()
        from homeassistant.components.frontend import DATA_EXTRA_MODULE_URL

        hass.data = {DATA_EXTRA_MODULE_URL: MagicMock()}

        with (
            patch.object(
                frontend_module,
                "add_extra_js_url",
                side_effect=ValueError("unexpected"),
            ),
            caplog.at_level(logging.ERROR),
        ):
            await async_setup_frontend(hass)

        assert any(
            "Failed to register extra JS URL" in r.message for r in caplog.records
        )
