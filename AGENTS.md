# Google Assistant (Manual) — Agent Documentation

## Overview

A Home Assistant custom integration that provides UI-based configuration for the manual
Google Assistant integration, reaching feature parity with the Nabu Casa Cloud Google Assistant.

**Domain:** `google_assistant_manual`
**Assistant ID:** `google_assistant_manual`
**Type:** HA custom integration (Python 3 + vanilla JS)
**Install:** Place this entire project folder as `custom_components/google_assistant_manual/` in HA config, then restart.
**Version:** 0.1.0

## Problem Solved

HA core hardcodes three voice assistants for entity exposure:
- `conversation` (built-in Assist)
- `cloud.alexa` (requires Nabu Casa Cloud)
- `cloud.google_assistant` (requires Nabu Casa Cloud)

Users running the manual Google Assistant integration had to use YAML config — no GUI option. This integration adds a fourth assistant ID so everything is managed through the UI.

## Terminology

**Core GA**:
The built-in Home Assistant `google_assistant` component. Provides webhook handling, state
reporting, request syncing, and device trait mapping. Its `async_setup()` is a no-op when
no YAML config exists — this design property enables setup-phase re-triggering.
_Avoid_: built-in GA, upstream GA, google_assistant component

**Assistant card**:
The settings panel injected into the voice assistants configuration page by `frontend.js`.
Modeled after `cloud-google-pref`. Surfaces toggles for expose-new-entities, report state,
and secure devices PIN. Appears as a `ha-card` under `ha-config-voice-assistants-assistants`.
_Avoid_: preferences card, GA settings panel

**Assistant ID**:
The string `"google_assistant_manual"`. Registered in `KNOWN_ASSISTANTS` to make the
integration appear in entity exposure tables and WS command validation. Distinct from
core GA's domain `"google_assistant"`.
_Avoid_: domain (that's `google_assistant_manual`)

**Config layer**:
This integration is a config management layer on top of core GA. It does not re-implement
webhooks, state reporting, or device syncing. It stores configuration in a `ConfigEntry`
and bridges it to core GA's expected config dict format.
_Avoid_: wrapper, proxy

**Setup-phase re-trigger**:
The mechanism by which this integration activates core GA after it has returned from
`async_setup()` as a no-op. Stores the config in `hass.data["google_assistant"]`,
constructs a fake `ConfigEntry` for the `google_assistant` domain via `SimpleNamespace`,
and directly calls core GA's `async_setup_entry()`. Avoids load-order issues and manifest patching.

**WebSocket bridge**:
WS commands (`google_assistant_manual/get_config`, `google_assistant_manual/update_config`,
`google_assistant_manual/enable`, `google_assistant_manual/disable`)
that the assistant card uses to read/write settings. These wrap `ConfigEntry.options`
updates. On `update_config`, live property patches on `GoogleConfig` are triggered
(for `report_state` enable/disable) without requiring a full ConfigEntry reload.
On `enable`/`disable`, the core GA ConfigEntry is loaded/unloaded entirely — matching
the `google_enabled` toggle behavior of the cloud card.

**YAML suppression**:
When our integration is enabled, any existing `google_assistant:` configuration in
`configuration.yaml` is neutralised. `_suppress_yaml_config()` removes YAML-based
core GA `ConfigEntry` instances (with `source == "import"`) before our own setup
runs. Our `ConfigEntry` is the single authoritative source of truth for Google
Assistant configuration. Users migrating from YAML should remove the
`google_assistant:` section from their configuration after installing this integration.

> "google_assistant" can mean the core HA component, the Google cloud platform, or
> the Nabu Casa Cloud integration — always use **core GA** for the HA component.

## Architecture

Two-layer monkey-patching approach. Neither layer modifies core HA files on disk — all patches are applied at runtime.

### Layer 1: Python Backend

**Files:** `__init__.py`, `config_flow.py`, `const.py`, `frontend.py`

On `async_setup()`:
1. Patches `KNOWN_ASSISTANTS` tuple in `homeassistant.components.homeassistant.exposed_entities` to include `"google_assistant_manual"`.
2. Walks the Voluptuous schemas for three WebSocket commands and injects the new assistant ID into any `vol.In` validator that contains `"conversation"`.
3. Registers static HTTP paths to serve `frontend.js` and `assets/icon.png`.
4. Registers `frontend.js` as an extra JS module so the HA frontend loads it.
5. Registers the `get_entry_id` WS discovery command.

On `async_setup_entry()`:
1. Neutralises any YAML-based core GA ConfigEntries via `_suppress_yaml_config()`.
2. Builds config dict from `entry.data` + `entry.options`.
3. Sets `hass.data["google_assistant"]["config"]`.
4. Imports and calls core GA's `async_setup_entry` with a `SimpleNamespace`-based fake entry.
5. Stores `GoogleConfig` reference in `entry.runtime_data`.
6. Monkey-patches `GoogleConfig.should_report_state` and `.secure_devices_pin` to read from `entry.options`.
7. Registers WS commands for the assistant card (`get_config`, `update_config`, `enable`, `disable`).

**Patched WS commands (entity exposure):**
- `homeassistant/expose_entity` — set per-entity exposure
- `homeassistant/expose_new_entities/get` — read "expose new entities" toggle
- `homeassistant/expose_new_entities/set` — write "expose new entities" toggle

### Layer 2: JavaScript Frontend Companion

**File:** `frontend.ts` (~1370 lines, TypeScript, compiled to `frontend.js` via esbuild)

Four patching mechanisms applied at `init()`:

| # | Function | Mechanism | Purpose |
|---|----------|-----------|---------|
| 1 | `patchVoiceAssistants()` | Monkey-patch `Object.keys()` | Detects when code iterates the `voiceAssistants` map and injects `{ google_assistant_manual: { domain: "google_assistant", name: "Google Assistant (Manual)" } }` |
| 2 | `patchSortKey()` | Monkey-patch `Array.prototype.forEach()` | Injects `"google_assistant_manual"` into the sort-order array `["conversation", "cloud.alexa", "cloud.google_assistant"]` so the new assistant appears in the correct position |
| 3 | `patchExposePage()` | Wrap `_availableAssistants` getter on `ha-config-voice-assistants-expose` | Makes the new assistant ID appear in the per-entity exposure dropdown |
| 4 | `patchCustomElements()` | Intercept `customElements.define()` and retroactively patch already-defined elements | Patches three custom element prototypes (see below) |

**Patched custom elements:**

- `ha-config-voice-assistants-assistants` — injects lifecycle hooks (`connectedCallback`, `firstUpdated`, `updated`) that call `injectCardInto()` to insert the custom settings card
- `voice-assistant-brand-icon` — overrides `render()` for our assistant ID to show the custom Google Assistant icon from `assets/icon.png`
- `voice-assistants-expose-assistant-icon` — overrides `render()` for our assistant ID to show custom expose status icons

**Card structure (`buildCard()`):**
```
<ha-card outlined data-ga-manual-card="1">
  <h1.card-header>
    <voice-assistant-brand-icon> (Google Assistant brand icon)
    "Google Assistant (Manual)"
    <div> (header actions)
      <ha-icon-button> (help link to integration docs)
      <ha-switch> (global toggle → enable/disable WS)
  <div.card-content>
    <p> (description text)
    <ha-md-list-item> "Expose new entities" + <ha-switch>
    <ha-md-list-item> "Enable state reporting" + <ha-switch>
    <ha-md-list-item> "Security devices" (info text)
    <ha-input> (PIN input for security devices, debounced 500ms)
  <div.card-actions>
    <a> → "Exposed entities" <ha-button> (with live count)
```

All settings rows hidden by default. State fetched via `get_config` WS on mount. Global toggle shows/hides them and calls `enable`/`disable` WS.

**Card injection (`injectCardInto()`):**
- Idempotent — guarded by `[data-ga-manual-card]` marker
- Inserts into `.content` of `ha-config-voice-assistants-assistants`
- Calculates insertion point via `INSERTION_LOOKUP` priority list
- Uses `MutationObserver` to wait if `.content` is still empty
- `_observerActive` WeakSet prevents duplicate observers

**DOM scanning:**
- `findAllAssistantsElements()` recursively walks the DOM including all shadow roots
- Called at init and via a document-level `MutationObserver` to catch dynamically loaded elements

## Relationships

- The **config flow** produces a **ConfigEntry** for `google_assistant_manual`.
- The **ConfigEntry** bridges to **core GA** via setup-phase re-trigger, populating `hass.data["google_assistant"]` and calling `async_setup_entry`.
- The **assistant card** reads/writes settings through the **WebSocket bridge**, which updates the **ConfigEntry** and triggers live patches on **core GA**'s `GoogleConfig` instance.
- The assistant card's **global toggle** enables/disables core GA entirely via `enable`/`disable` WS commands — unloading the core GA tears down the webhook and stops `report_state`; re-enabling re-runs setup-phase re-trigger.
- Entity exposure is handled by core's `KNOWN_ASSISTANTS` (patched at startup) and the per-entity expose page (patched by `frontend.js`).

## Data Flow

```
HA starts
  → async_setup() called
    → _patch_core_assistants(): adds ID to KNOWN_ASSISTANTS + WS schemas
    → async_setup_frontend(): registers static paths + extra JS URL
    → _register_entry_discovery(): get_entry_id WS command
  → Integration ready

User adds integration via UI:
  → config_flow: project_id → service_account (JSON textarea)
    → ConfigEntry created for domain "google_assistant_manual"
      → async_setup_entry() fires:
        1. Neutralises YAML-based core GA ConfigEntries (source == "import")
        2. Populates hass.data["google_assistant"]["config"]
        3. Constructs fake ConfigEntry for "google_assistant" domain
        4. Calls core GA's async_setup_entry()
        5. Patches GoogleConfig.should_report_state → entry.options
        6. Patches GoogleConfig.secure_devices_pin → entry.options
        7. Registers WS commands (get_config/update_config/enable/disable)

Browser loads HA frontend
  → HA loads /google_assistant_manual/frontend.js as extra module
  → init() runs immediately (or on DOMContentLoaded)
    → patchVoiceAssistants(): intercepts Object.keys
    → patchSortKey(): intercepts Array.forEach
    → patchCustomElements(): wraps customElements.define + patches existing
    → injectIntoAllAssistantsElements(): scans DOM for assistants elements
    → Document MutationObserver starts watching for dynamic elements
    → patchExposePage(): wraps _availableAssistants getter

User visits voice assistants config page
  → ha-config-voice-assistants-assistants renders
  → connectedCallback fires → injectCardInto(el)
  → Card calls hass.callWS() for:
      - google_assistant_manual/get_entry_id (discover entry)
      - google_assistant_manual/get_config (enabled, report_state, PIN)
      - homeassistant/expose_new_entities/get (populate "expose new" toggle)
      - homeassistant/expose_entity/list (populate entity count badge)

User toggles global enable/disable in card header:
  → JS calls google_assistant_manual/enable or /disable
  → enable: re-runs setup-phase re-trigger (steps 1-5 above)
  → disable: unloads GoogleConfig, tears down webhook/report_state

User changes settings in card (when enabled):
  → JS calls google_assistant_manual/update_config
  → Python handler:
    - Updates entry.options
    - If report_state changed: calls GoogleConfig.async_enable/disable_report_state()
    - If PIN changed: no action needed (live property patch)
```

## Example dialogue

> **Dev:** "When the user changes the report state toggle in the assistant card, does core GA get reloaded?"
> **Domain expert:** "No — the ConfigEntry options are updated via WS, and a live monkey-patch on `GoogleConfig.should_report_state` reads the new value. If enabling, `async_enable_report_state()` is called directly on the `GoogleConfig` instance. A full reload (tearing down webhooks) only happens when `project_id` or `service_account` changes, or when the global toggle disables and re-enables the entire integration."

> **Dev:** "What happens when the user flips the global toggle off on the assistant card?"
> **Domain expert:** "The core GA instance is unloaded — webhook unregistered, report_state subscriptions torn down, token cache cleared. Our ConfigEntry stays loaded so the card is still visible, just with settings rows hidden. Flipping it back on re-runs the full setup-phase re-trigger."

## Key Constants

```python
# const.py
DOMAIN = "google_assistant_manual"
ASSISTANT_ID = "google_assistant_manual"
```

```ts
// frontend.ts
const ASSISTANT_ID = "google_assistant_manual";
const ASSISTANT_NAME = "Google Assistant (Manual)";
const SORT_TARGET = ["conversation", "cloud.alexa", "cloud.google_assistant"];
const ASSET_URL = "/google_assistant_manual/assets";

const WS_GET_ENTRY_ID = `${ASSISTANT_ID}/get_entry_id`;
const WS_GET_CONFIG = `${ASSISTANT_ID}/get_config`;
const WS_UPDATE_CONFIG = `${ASSISTANT_ID}/update_config`;
const WS_ENABLE = `${ASSISTANT_ID}/enable`;
const WS_DISABLE = `${ASSISTANT_ID}/disable`;
```

## Directory Structure

Integration files live in `custom_components/google_assistant_manual/` (standard HACS layout). Dev tooling stays at repo root.

```
./
├── custom_components/
│   └── google_assistant_manual/     # Integration (what HACS/HA loads)
│       ├── __init__.py              # Integration entry point, core GA bridge, WS commands
│       ├── config_flow.py           # Two-step config flow (project_id → service_account)
│       ├── const.py                 # DOMAIN, ASSISTANT_ID, CONF_* keys, WS constants
│       ├── frontend.py              # Serves frontend.js and assets via HA HTTP
│       ├── frontend.js              # Compiled JS artifact (esbuild output, git-committed)
│       ├── manifest.json            # HA integration manifest
│       ├── hacs.json                # HACS dashboard metadata
│       ├── strings.json             # Config flow translation keys
│       ├── assets/
│       │   └── icon.png             # Google Assistant brand icon
│       └── translations/
│           └── en.json              # Generated English translations
├── tests/                           # Test suites (colocated at repo root)
│   ├── __init__.py                  # Python test package (imports custom_components)
│   ├── conftest.py                  # Shared fixtures (mock_config_entry, FakeGoogleConfig, etc.)
│   ├── test_init.py                 # Tests for __init__.py (bridge, WS, schema walker, teardown)
│   ├── test_config_flow.py          # Tests for config_flow.py (validation, flow steps)
│   ├── test_const.py                # Tests for const.py (constant values, no drift)
│   ├── test_frontend.py             # Tests for frontend.py (static path registration)
│   └── frontend.test.ts             # Tests for frontend.ts (patch logic, card building, WS)
├── frontend.ts                      # TypeScript source (~1340 lines, strict mode)
├── package.json                     # npm scripts and dev dependencies
├── tsconfig.json                    # TypeScript strict config, ES2020/DOM target
├── vitest.config.ts                 # Vitest runner config (DOM environment)
├── pytest.ini                       # Pytest config (asyncio mode, markers)
├── eslint.config.mjs                # ESLint flat config (typescript-eslint recommended)
├── pyrefly.toml                     # Python type checker config (strict preset)
├── ruff.toml                        # Python linter + formatter config
├── build/                           # Generated distribution (gitignored)
│   └── custom_components/           # Clean copy for deployment
├── docs/
│   ├── PLAN.md
│   ├── adr/
│   └── combined-reference.md
└── references/                      # READ-ONLY reference copies (gitignored)
    ├── core-dev/
    └── frontend-dev/
```

`.gitignore` excludes: `references/`, `__pycache__/`, `.pyrefly/`, `node_modules/`, `build/`, `.ruff_cache/`

## Dependencies

### Python
- `homeassistant` (core framework)
- `voluptuous` (schema validation, available in HA)
- No external pip dependencies

### JavaScript
- **None at runtime.** Compiled JS targets ES2020 and runs as an IIFE.
- At build time: `typescript`, `esbuild`.
- Uses `hass.callWS()` for WebSocket calls (provided by HA frontend).
- Uses `hass.localize()` for i18n where available, with English fallbacks.
- Uses `hass.callService("persistent_notification", ...)` for user-facing error toasts.

## Development Setup

### Prerequisites

```bash
# Python tools (global install)
pip install --break-system-packages pyrefly ruff

# Node tools (project-local)
npm install
```

### Commands

| Command | What it does |
|---|---|
| `npm run build` | Compile `frontend.ts` → `frontend.js` (esbuild, <10ms) |
| `npm run build:dist` | Build JS + create `build/custom_components/google_assistant_manual/` with only runtime files |
| `npm run watch` | Rebuild `frontend.js` on every `.ts` change |
| `npm run check` | Full type-check: `tsc --noEmit` + `pyrefly check` |
| `npm run lint` | Full lint: `eslint frontend.ts tests/` + `ruff check .` + `ruff format --check .` |
| `npm run fix` | Auto-fix all: `eslint --fix` + `ruff check --fix` + `ruff format` |
| `npm test` | Run all tests: `vitest run` (17 TS tests) + `python -m pytest tests/ -q` (139 Python tests) |

### Testing

Two test frameworks serve different parts of the codebase:

**Vitest** (`vitest.config.ts`) — TypeScript tests:
- DOM environment (via `@vitest/environment-dom` / `jsdom`)
- 17 tests in `tests/frontend.test.ts`
- Covers patch logic, card building, DOM manipulation, and WebSocket interactions
- Runs as `vitest run` (single shot, no watch mode)

**pytest** (`pytest.ini`) — Python tests:
- 139 tests across 5 files in `tests/`
- Async-compatible via `pytest-asyncio` (auto mode)
- Shared fixtures in `tests/conftest.py`:
  - `mock_config_entry()` / `mock_config_entry_minimal()` — build `ConfigEntry`-like objects for all test scenarios
  - `FakeGoogleConfig` — stand-in for core GA's `GoogleConfig` with `should_report_state` and `secure_devices_pin` properties
  - `mock_ws_connection()` — fake WebSocket connection with `send_result` / `send_error` tracking
  - `reset_version_cache`, `reset_original_props_cache` — autouse fixtures to prevent test pollution
- Test files:
  - `test_init.py` — `_build_core_config`, `_make_core_entry`, `_safe_get_entry`, WS schemas, `_add_assistant_to_schema`, `_patch_google_config_properties`, `_teardown_core_ga`, `_patch_core_assistants`
  - `test_config_flow.py` — validation, `_parse_service_account_json`, `_is_valid_project_id`, flow steps
  - `test_const.py` — constant values match expectations and don't drift between Python and JS
  - `test_frontend.py` — HTTP path registration, asset serving
  - `frontend.test.ts` — JS patch functions, card DOM structure, WS client calls

### Tooling

**TypeScript** (`tsconfig.json`):
- `strict: true`, ES2020 target, DOM lib
- Source: `frontend.ts`, no emit (esbuild handles output)

**esbuild** (package.json `build` script):
- Bundles `frontend.ts` as an IIFE targeting ES2020
- No dependencies — self-contained output in `frontend.js`

**ESLint** (`eslint.config.mjs`):
- Flat config with `typescript-eslint` recommended rules
- `no-explicit-any` off (not needed — zero `any` in code)
- `no-unused-vars` with `argsIgnorePattern: "^_"`

**Ruff** (`ruff.toml`):
- Rules: pycodestyle, pyflakes, isort, pyupgrade, bugbear, simplify, comprehensions
- Formatter: double quotes, spaces
- Target: Python 3.14

**Pyrefly** (`pyrefly.toml`):
- Preset: `strict`
- All `homeassistant.*` and `voluptuous` imports replaced with `Any` (packages not installable outside HA)
- Search path: `..` (so the `google_assistant_manual` package resolves relative imports)
- Excludes: `references/`, `.venv/`

### Pre-commit workflow

```bash
npm run lint    # catch style/format issues
npm run check   # catch type errors
npm run build   # verify JS compiles
npm test        # verify tests pass
```

`lint`, `check`, `build`, and `test` must all pass with zero errors before committing.

## Build / Deployment

The project source is TypeScript and Python. Deployment requires the compiled JS artifact.

```bash
# Build the distributable directory
npm run build:dist

# Copy into HA config
cp -r build/custom_components/google_assistant_manual /config/custom_components/
```

Then go to Settings → Devices & Services → Add Integration → Google Assistant (Manual).

## Key Design Decisions

1. **Monkey-patching over forking.** Rather than modifying HA core files, all changes are runtime patches. This makes the integration a drop-in custom component that works with any HA version (within reason).

2. **TypeScript over vanilla JS.** The frontend companion is TypeScript with strict mode, compiled to vanilla JS via esbuild for deployment. This catches null errors, wrong argument counts, and DOM API misuse at build time without adding runtime dependencies.

3. **Idempotent card injection.** The card injection is designed to be called from multiple lifecycle hooks (`connectedCallback`, `firstUpdated`, `updated`, DOM scans, MutationObservers) without creating duplicates. The `[data-ga-manual-card]` marker ensures only one card exists.

4. **Defensive patching with comprehensive logging.** Every patch, WS call, and DOM operation is wrapped in try/except (Python) or try/catch (JS). All failures are logged with `[GA Manual]` prefix, full tracebacks, and actionable messages. The JS side surfaces critical errors via `persistent_notification` toasts so users can see them without opening browser dev tools.

5. **Schema walking for WS patches.** Rather than manually updating each Voluptuous schema, `_walk()` recursively finds all `vol.In` validators containing `"conversation"` and adds the new ID. Each walked node is tracked by path for targeted error reporting if the schema structure changes.

6. **Config layer architecture.** This integration is a config management layer on top of core GA. It stores configuration in a `ConfigEntry.options` and bridges to core GA via setup-phase re-trigger + live property monkey-patches. Settings changes take effect immediately without requiring a full reload — only the global toggle or credential changes trigger a full teardown/re-setup cycle.

## Known Limitations

1. **HA version coupling.** If HA core renames `KNOWN_ASSISTANTS`, moves `exposed_entities`, changes WebSocket command schemas, or renames custom element tags, patches may fail. All failures are logged with detailed context to assist debugging.

2. **WebSocket handler availability.** `_patch_core_assistants()` accesses `hass.data["websocket_api"]`, which may not be populated yet during `async_setup`. The code logs a warning and skips WS patching if handlers are unavailable — the patching will be attempted on the first WS call that triggers validation.

3. **Sort key injection is fragile.** `patchSortKey()` detects the sort array by exact content match `["conversation", "cloud.alexa", "cloud.google_assistant"]`. If HA changes the sort order, the patch won't fire and the card will appear at the bottom.

4. **Single-entry assumption.** The integration is designed for one Google Assistant project. Multiple entries are not tested. The JS fetches the first entry via `get_entry_id` WS.

5. **Core GA availability.** This integration requires the built-in `google_assistant` component to be available. If import fails, setup raises a descriptive `RuntimeError`.

6. **Route cleanup.** HTTP routes registered by core GA are tracked via snapshot diffing and removed via `_routes.remove()`. This accesses aiohttp internals and may break on major aiohttp version bumps.

## How to Extend

### Adding a new setting to the card

1. In `buildCard()`, add a new `makeSwitchSettingItem()` or `makeSettingItem()` call.
2. If it needs a toggle handler, add the handler function and attach it in `sw.addEventListener("change", handler)`.
3. If it needs to read/write state via WebSocket, use the `hass.callWS()` pattern from `onReportStateToggle()`.
4. Add the setting key to `WS_CONFIG_SCHEMA` in `__init__.py`.
5. Handle the new key in `ws_update_config`.
6. Return the new key in `ws_get_config`.

### Adding a new custom element to patch

1. Add the element tag name and patcher function to the `PATCHERS` object.
2. Write a patcher function following the `_patchXxxProto()` pattern.
3. The custom elements infrastructure handles both new definitions (via `customElements.define` interceptor) and already-defined elements (via the fallback loop).

### Changing the assistant name or icon

- Update `ASSISTANT_ID` and `ASSISTANT_NAME` in both `const.py` and `frontend.ts` (then `npm run build`).
- Replace `assets/icon.png`.
- Ensure `manifest.json` name and domain stay consistent.
- Update `strings.json` and `translations/en.json` if the displayed name changes.

## Reference Materials

The `references/` directory contains snapshots of:
- **`core-dev/`** — `home-assistant/core` (the built-in `google_assistant` integration, `exposed_entities.py`, WebSocket API schemas)
- **`frontend-dev/`** — `home-assistant/frontend` (Lit custom elements, voice assistant UI components, expose page)

These are **read-only study materials** used during development to understand how the core voice assistant system works. They are not part of the project and should not be modified.
