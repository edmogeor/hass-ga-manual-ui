#!/usr/bin/env python3
"""One-shot: move integration-custom strings out of the HA translation files.

hassfest only permits HA's fixed translation schema, so our custom
`config.yaml_notice`, `config.install_notice`, and the top-level `frontend`
block are rejected. This relocates them into a parallel `locale/<lang>.json`
store (loaded directly by the integration) and strips them from
`strings.json` + `translations/*.json`.

Idempotent: keys already absent are simply skipped.
"""

from __future__ import annotations

import json
from pathlib import Path

BASE = (
    Path(__file__).resolve().parent.parent / "custom_components" / "hass_ga_manual_ui"
)
TRANSLATIONS = BASE / "translations"
LOCALE = BASE / "locale"

CUSTOM_CONFIG_KEYS = ("yaml_notice", "install_notice")


def load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def dump(path: Path, data: dict) -> None:
    path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def split(data: dict) -> dict:
    """Pop the custom keys out of `data` and return them as a locale dict."""
    extracted: dict = {}
    config = data.get("config", {})
    for key in CUSTOM_CONFIG_KEYS:
        if key in config:
            extracted[key] = config.pop(key)
    if "frontend" in data:
        extracted["frontend"] = data.pop("frontend")
    return extracted


def main() -> None:
    LOCALE.mkdir(exist_ok=True)

    # strings.json is the English dev source; strip only (locale/en.json comes
    # from translations/en.json, which must stay byte-identical in content).
    strings = BASE / "strings.json"
    data = load(strings)
    split(data)
    dump(strings, data)
    print(f"stripped {strings.relative_to(BASE)}")

    for path in sorted(TRANSLATIONS.glob("*.json")):
        data = load(path)
        extracted = split(data)
        dump(path, data)
        if extracted:
            dump(LOCALE / path.name, extracted)
            print(f"{path.name}: extracted {sorted(extracted)}")
        else:
            print(f"{path.name}: nothing to extract")


if __name__ == "__main__":
    main()
