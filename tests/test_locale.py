"""Tests for locale precedence and missing/unreadable translation fallback."""

import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest
from hass_ga_manual_ui import locale


@pytest.mark.parametrize(
    ("regional", "expected"),
    [
        (None, "Base"),
        ("invalid JSON", "Base"),
        (json.dumps({"yaml_notice": "Regional"}), "Regional"),
    ],
)
async def test_locale_falls_back_per_key(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, regional: str | None, expected: str
) -> None:
    """Exact tags override base language, with English filling untranslated keys."""
    (tmp_path / "en.json").write_text(
        json.dumps({"yaml_notice": "English", "install_notice": "Refresh"})
    )
    (tmp_path / "pt.json").write_text(json.dumps({"yaml_notice": "Base"}))
    if regional is not None:
        (tmp_path / "pt-BR.json").write_text(regional)
    monkeypatch.setattr(locale, "LOCALE_DIR", tmp_path)
    locale._read.cache_clear()
    hass = MagicMock()
    hass.async_add_executor_job = AsyncMock(side_effect=lambda job: job())
    try:
        assert await locale.async_load_locale(hass, "pt-BR") == {
            "yaml_notice": expected,
            "install_notice": "Refresh",
        }
        assert await locale.async_load_locale(hass, "unknown") == {
            "yaml_notice": "English",
            "install_notice": "Refresh",
        }
    finally:
        locale._read.cache_clear()
