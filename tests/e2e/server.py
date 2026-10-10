"""Run a disposable real HA instance for E2E tests without Google credentials."""

import argparse
import asyncio
import json
import logging
import signal
import time
from http import HTTPStatus
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import AsyncMock, patch

from aiohttp import web
from homeassistant import bootstrap, loader
from homeassistant.components.http import HomeAssistantView
from homeassistant.components.http.config import async_get_and_load_store
from homeassistant.config_entries import ConfigEntry, ConfigEntryState
from homeassistant.core import HomeAssistant

ROOT = Path(__file__).resolve().parents[2]
DOMAIN = "hass_ga_manual_ui"


class ReadyView(HomeAssistantView):
    """Expose readiness only after fixture setup and test auth are complete."""

    url = "/e2e-ready"
    name = "e2e:ready"
    requires_auth = False

    def __init__(self, ready: asyncio.Event) -> None:
        """Keep the fixture's readiness event."""
        self.ready = ready

    async def get(self, request: web.Request) -> web.Response:
        """Let Playwright wait without exposing any credentials."""
        return web.Response(status=200 if self.ready.is_set() else 503)


async def serve(port: int, state_file: Path, config_dir: Path) -> None:
    """Load HA and our integration, publish test auth, and stop on SIGTERM."""
    (config_dir / "custom_components").symlink_to(ROOT / "custom_components")
    storage = config_dir / ".storage"
    storage.mkdir()
    (storage / "onboarding").write_text(
        json.dumps(
            {
                "version": 4,
                "minor_version": 1,
                "key": "onboarding",
                "data": {"done": ["user", "core_config", "integration", "analytics"]},
            }
        )
    )
    hass = HomeAssistant(str(config_dir))
    hass.config.skip_pip = True
    loader.async_setup(hass)
    config = {
        "homeassistant": {
            "name": "E2E test",
            "latitude": 0,
            "longitude": 0,
            "elevation": 0,
            "unit_system": "metric",
            "time_zone": "UTC",
        },
        "http": {"server_host": "127.0.0.1", "server_port": port},
        "frontend": {},
        "config": {},
        "lovelace": {"mode": "storage"},
        "conversation": {},
        "assist_pipeline": {},
        "analytics": {},
        "recorder": {},
        "input_boolean": {"e2e_switch": {"name": "E2E test switch"}},
    }
    # Only Google's outbound HomeGraph boundary is mocked. Core GA setup,
    # GoogleConfig, entity traits, HA's exposure handlers, and storage stay real.
    with patch(
        "homeassistant.components.google_assistant.http.GoogleConfig.async_call_homegraph_api",
        new=AsyncMock(return_value=HTTPStatus.OK),
    ):
        try:
            if await bootstrap.async_from_config_dict(config, hass) is None:
                raise RuntimeError("Home Assistant bootstrap failed")
            if missing := set(config) - hass.config.components:
                raise RuntimeError(f"Required HA components did not load: {missing}")
            entry = ConfigEntry(
                version=1,
                minor_version=1,
                domain=DOMAIN,
                title="E2E test Google Assistant",
                data={
                    "project_id": "e2e-test-project",
                    "service_account": {
                        "client_email": "e2e-test@example.invalid",
                        "private_key": "unused: HomeGraph is mocked",
                    },
                },
                options={
                    "enabled": True,
                    "report_state": False,
                    "hide_home_assistant_cloud": True,
                },
                source="user",
                entry_id=None,
                unique_id="e2e-test-project",
                discovery_keys={},
                subentries_data=(),
                pref_disable_new_entities=False,
                pref_disable_polling=False,
            )
            await hass.config_entries.async_add(entry)
            if entry.state is not ConfigEntryState.LOADED or not entry.runtime_data:
                raise RuntimeError("Integration or core GA did not load")

            user = await hass.auth.async_create_user("E2E test owner")
            base_url = f"http://127.0.0.1:{port}"
            token = await hass.auth.async_create_refresh_token(
                user, client_id=f"{base_url}/"
            )
            auth = {
                "hassUrl": base_url,
                "clientId": f"{base_url}/",
                "access_token": hass.auth.async_create_access_token(token),
                "refresh_token": token.token,
                "token_type": "Bearer",
                "expires_in": 1800,
                "expires": (time.time() + 1800) * 1000,
            }
            ready = asyncio.Event()
            hass.http.register_view(ReadyView(ready))
            await hass.async_start()
            http_store = await async_get_and_load_store(hass)
            if http_store.pending is not None:
                await http_store.async_promote_pending()
            state_file.parent.mkdir(parents=True, exist_ok=True)
            state_file.write_text(
                json.dumps({"auth": auth, "entry_id": entry.entry_id})
            )
            state_file.chmod(0o600)
            ready.set()
            print(f"E2E HA ready on port {port}", flush=True)

            stopped = asyncio.Event()
            for sig in (signal.SIGTERM, signal.SIGINT):
                hass.loop.add_signal_handler(sig, stopped.set)
            await stopped.wait()
        finally:
            await hass.async_stop()
            state_file.unlink(missing_ok=True)


def main() -> None:
    """Create a fresh temporary HA configuration for each test run."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=18096)
    parser.add_argument("--state-file", type=Path, default=ROOT / ".e2e/state.json")
    args = parser.parse_args()
    logging.basicConfig(level=logging.WARNING)
    with TemporaryDirectory(prefix="ga-manual-e2e-") as config_dir:
        asyncio.run(serve(args.port, args.state_file, Path(config_dir)))


if __name__ == "__main__":
    main()
