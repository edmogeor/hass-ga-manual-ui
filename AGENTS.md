# Google Assistant (Manual) - Agent Documentation

## Overview

A Home Assistant custom integration that provides UI-based configuration for the manual
Google Assistant integration, reaching feature parity with the Nabu Casa Cloud Google Assistant.

**Domain:** `hass_ga_manual_ui`
**Assistant ID:** `hass_ga_manual_ui`
**Type:** HA custom integration (Python 3 + vanilla JS)
**Install:** Place this entire project folder as `custom_components/hass_ga_manual_ui/` in HA config, then restart.

## Problem Solved

HA core hardcodes three voice assistants for entity exposure:
- `conversation` (built-in Assist)
- `cloud.alexa` (requires Nabu Casa Cloud)
- `cloud.google_assistant` (requires Nabu Casa Cloud)

Users running the manual Google Assistant integration had to use YAML config, no GUI option. This integration adds a fourth assistant ID so everything is managed through the UI.

## Terminology

**Core GA**:
The built-in Home Assistant `google_assistant` component. Provides webhook handling, state
reporting, request syncing, and device trait mapping. Its `async_setup()` is a no-op when
no YAML config exists, this design property enables setup-phase re-triggering.
_Avoid_: built-in GA, upstream GA, google_assistant component

**Assistant card**:
The settings panel injected into the voice assistants configuration page by `frontend.js`.
Modeled after `cloud-google-pref`. Surfaces toggles for expose-new-entities, report state,
and secure devices PIN. Appears as a `ha-card` under `ha-config-voice-assistants-assistants`.
_Avoid_: preferences card, GA settings panel

**Assistant ID**:
The string `"hass_ga_manual_ui"`. Registered in `KNOWN_ASSISTANTS` to make the
integration appear in entity exposure tables and WS command validation. Distinct from
core GA's domain `"google_assistant"`.
_Avoid_: domain (that's `hass_ga_manual_ui`)

**Config layer**:
This integration is a config management layer on top of core GA. It does not re-implement
webhooks, state reporting, or device syncing. It stores configuration in a `ConfigEntry`
and bridges it to core GA's expected config dict format.
_Avoid_: wrapper, proxy

**Setup-phase re-trigger**:
The mechanism by which this integration activates core GA after it has returned from
`async_setup()` as a no-op. Stores the config in `hass.data["google_assistant"]`,
then registers a real `ConfigEntry` for the `google_assistant` domain via
`hass.config_entries.async_add()`. `async_add()` **both registers and sets up** the
entry (it awaits `async_setup` internally) and persists it, so we must NOT also call
core GA's `async_setup_entry()` ourselves (doing both caused duplicate webhook
registration and "already been setup" errors). A real registered entry (vs the old
`SimpleNamespace` fake) is required so the device registry can link devices to it.
The entry persists across restarts and is reused via `_find_core_entry()` rather than
recreated each boot, which keeps device-registry links stable.

**WebSocket bridge**:
WS commands (`hass_ga_manual_ui/get_config`, `hass_ga_manual_ui/update_config`,
`hass_ga_manual_ui/enable`, `hass_ga_manual_ui/disable`)
that the assistant card uses to read/write settings. These wrap `ConfigEntry.options`
updates. On `update_config`, live property patches on `GoogleConfig` are triggered
(for `report_state` enable/disable) without requiring a full ConfigEntry reload.
On `enable`, the core GA ConfigEntry is created (first time) or reused. On `disable`,
`_teardown_core_ga(..., disable=True)` performs a **soft** disable: it turns off
`report_state` and sets `enabled=False`, but does NOT remove the core entry or its HTTP
view/webhook. The patched `should_expose` returns `False` whenever `enabled` is `False`,
so SYNC reports no devices, an effective disable. This is required because core GA has
**no** `async_unload_entry` and registers an HTTP view + local-SDK webhook that cannot
be cleanly removed at runtime; add/remove churn produced duplicate-webhook and
unremovable-route errors. A plain unload/reload of our entry (HA shutdown, reload) calls
`_teardown_core_ga(..., disable=False)`, which just drops our runtime pointer and leaves
the core entry loaded. The core entry is removed only on entry deletion, or pruned on
the next restart by `_reconcile_core_ga_entries` (a disabled project is not in the
keep-set).

**Core GA entry reconciliation**:
When our integration loads, `_reconcile_core_ga_entries()` runs in `async_setup()`. It
does NOT remove the managed core entry (that carries device-registry links). Instead it
(1) seeds `hass.data["google_assistant"][DATA_CONFIG]` from our config entry so HA's
boot-time auto-setup of the persisted core entry doesn't crash with
`KeyError: 'google_assistant'`, and (2) prunes orphan/duplicate core entries left by
older versions (keeps one per enabled project). `hass.data["google_assistant"]` is also
initialised as an empty dict early in `async_setup()` as a safety net. If the boot
auto-setup still loses the race for `DATA_CONFIG`, `_setup_core_ga()` self-heals by
reloading the existing core entry once our config is present.

> "google_assistant" can mean the core HA component, the Google cloud platform, or
> the Nabu Casa Cloud integration, always use **core GA** for the HA component.

## Architecture

Two-layer monkey-patching approach. Neither layer modifies core HA files on disk, all patches are applied at runtime.

### Layer 1: Python Backend

**Files:** `__init__.py`, `config_flow.py`, `const.py`, `frontend.py`

On `async_setup()`:
1. Initiálises `hass.data["google_assistant"]` as an empty dict (safety for stale entries).
2. Reconciles core GA ConfigEntries via `_reconcile_core_ga_entries()`: seeds `DATA_CONFIG` from our entry (prevents boot `KeyError`) and prunes orphan/duplicate core entries, but keeps the managed one.
3. Patches `KNOWN_ASSISTANTS` tuple in `homeassistant.components.homeassistant.exposed_entities` to include `"hass_ga_manual_ui"`.
4. Walks the Voluptuous schemas for three WebSocket commands and injects the new assistant ID into any `vol.In` validator that contains `"conversation"`.
5. Registers static HTTP paths to serve `frontend.js` and `assets/icon.png`.
6. Registers `frontend.js` as an extra JS module so the HA frontend loads it.
7. Registers the `get_entry_id` WS discovery command.

On `async_setup_entry()`:
1. Builds config dict from `entry.data` + `entry.options`.
2. Sets `hass.data["google_assistant"]["config"]`.
3. Reuses the existing core GA entry (`_find_core_entry`) if present, setting it up only if not already loaded, otherwise registers a fresh one via `hass.config_entries.async_add()` (which also sets it up). Never calls core GA's `async_setup_entry` directly (that would double-set-up).
4. Stores `GoogleConfig` reference (from `core_entry.runtime_data`) in `entry.runtime_data`.
5. Monkey-patches `GoogleConfig.should_report_state` and `.secure_devices_pin` to read from `entry.options`, and `GoogleConfig.should_2fa` to read the per-entity `disable_2fa` option from the registry (core GA hard-codes `should_2fa` to `True`; cloud reads the option, this powers the "Ask for PIN" toggle).
6. Monkey-patches `GoogleConfig.should_expose` to delegate to `async_should_expose(hass, "hass_ga_manual_ui", entity_id)`, bridging the core config-entry path (which otherwise uses the legacy YAML `expose_by_default`/`entity_config` model) to the modern `exposed_entities` registry the UI writes to. Without this, SYNC returns zero devices ("Account linked, but no devices found"). When the integration is soft-disabled (`enabled=False`) it returns `False`, so SYNC reports nothing.
7. Registers Cloud-parity auto-resync listeners (`_register_sync_listeners`): on exposure changes, entity-registry updates (Google-relevant attrs), and device-area changes it calls `GoogleConfig.async_schedule_google_sync_all()` (Google `requestSync`). The core config-entry `GoogleConfig` lacks these; only Nabu Casa Cloud has them. Unsubscribes are stored in `runtime_data["sync_unsubs"]` and removed on teardown.
8. Registers WS commands for the assistant card (`get_config`, `update_config`, `enable`, `disable`).

**Patched WS commands (entity exposure):**
- `homeassistant/expose_entity`, set per-entity exposure
- `homeassistant/expose_new_entities/get`, read "expose new entities" toggle
- `homeassistant/expose_new_entities/set`, write "expose new entities" toggle

**Own WS commands for per-entity 2FA (mirror cloud's `cloud/google_assistant/entities/*`):**
- `hass_ga_manual_ui/get_entity`, returns `{traits, might_2fa, disable_2fa}` for an entity (built from core GA's `GoogleEntity` against our `GoogleConfig`)
- `hass_ga_manual_ui/update_entity`, writes the `disable_2fa` option under our assistant id via `async_set_assistant_option`

### Layer 2: JavaScript Frontend Companion

**File:** `frontend.ts` (~1370 lines, TypeScript, compiled to `frontend.js` via esbuild)

Four patching mechanisms applied at `init()`:

| # | Function | Mechanism | Purpose |
|---|----------|-----------|---------|
| 1 | `patchVoiceAssistants()` | Monkey-patch `Object.keys()` | Detects when code iterates the `voiceAssistants` map and injects `{ hass_ga_manual_ui: { domain: "google_assistant", name: "Google Assistant (Manual)" } }` |
| 2 | `patchSortKey()` | Monkey-patch `Array.prototype.forEach()` | Injects `"hass_ga_manual_ui"` into the sort-order array `["conversation", "cloud.alexa", "cloud.google_assistant"]` so the new assistant appears in the correct position |
| 3 | `patchExposePage()` | Wrap `_availableAssistants` getter on `ha-config-voice-assistants-expose` | Makes the new assistant ID appear in the per-entity exposure dropdown |
| 4 | `patchCustomElements()` | Intercept `customElements.define()` and retroactively patch already-defined elements | Patches four custom element prototypes (see below) |

**Patched custom elements:**

- `ha-config-voice-assistants-assistants`, injects lifecycle hooks (`connectedCallback`, `firstUpdated`, `updated`) that call `injectCardInto()` to insert the custom settings card
- `voice-assistant-brand-icon`, overrides `render()` for our assistant ID to show the custom Google Assistant icon from `assets/icon.png`
- `voice-assistants-expose-assistant-icon`, overrides `render()` for our assistant ID to show custom expose status icons
- `entity-voice-settings`, in `updated`/`firstUpdated`, fetches the entity's 2FA info via `get_entity` and injects an identical "Ask for PIN" `ha-checkbox` (same `ui.dialogs.voice-settings.ask_pin` key) into our assistant's row for security devices, wired to `update_entity`. HA only renders this checkbox for `cloud.google_assistant` and gates the data fetch on the cloud component, so we replicate it.

**Card structure (`buildCard()`):**
```
<ha-card outlined data-ga-manual-card="1">
  <h1.card-header>
    <img data-ga-manual> (our bundled brand icon, served at /<domain>/brand/)
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
- Idempotent, guarded by `[data-ga-manual-card]` marker
- Inserts into `.content` of `ha-config-voice-assistants-assistants`
- Calculates insertion point via `INSERTION_LOOKUP` priority list
- Uses `MutationObserver` to wait if `.content` is still empty
- `_observerActive` WeakSet prevents duplicate observers

**DOM scanning:**
- `findAllAssistantsElements()` recursively walks the DOM including all shadow roots
- Called at init and via a document-level `MutationObserver` to catch dynamically loaded elements

**Refresh-after-install / stale-bundle handling:**

`frontend.py` serves `frontend.js` at a content-hashed URL (`?v=<sha256[:12]>`), so the file itself is cache-busted. But the `<script>` tag is injected into HA's app document, and HA's frontend service worker can keep serving a previously-cached app shell, so a **brand-new install or an update needs a one-time hard browser refresh** before the new/updated module loads. Two mechanisms surface this to the user (a scripted `location.reload()` can't help: it's a soft reload that won't bypass the service worker, and would risk a reload loop):

- **First install**, `config_flow._notify_installed()` posts a one-time `persistent_notification` (`notification_id="hass_ga_manual_ui_install"`) telling the user to hard-refresh. Server-side, so it reaches the user even though our JS hasn't loaded yet. Localized via `install_notice` in `locale/<lang>.json` with an English fallback.
- **Update**, the bundle bakes in its version at build time (esbuild `--define:__BUILD_VERSION__` from `manifest.json`, exposed as `BUILD_VERSION`). `ws_get_config` returns the installed `version`; `_maybePromptReload()` compares them and, on a mismatch (stale cached bundle), posts a `persistent_notification` (id `hass_ga_manual_ui_update`) once per session, consistent with the install notification, and pointing at a hard refresh (a soft reload just re-serves the cached shell). `_checkVersionForReloadPrompt()` runs this at init so it fires on any page, not just the Assistants card. Localized via `frontend.update_available`. `_VERSION` is read at Python import time, so the server only reports the new version after the HACS-prompted HA restart, the prompt can't fire prematurely.

## Relationships

- The **config flow** produces a **ConfigEntry** for `hass_ga_manual_ui`.
- The **ConfigEntry** bridges to **core GA** via setup-phase re-trigger, populating `hass.data["google_assistant"]` and calling `async_setup_entry`.
- The **assistant card** reads/writes settings through the **WebSocket bridge**, which updates the **ConfigEntry** and triggers live patches on **core GA**'s `GoogleConfig` instance.
- The assistant card's **global toggle** enables/disables core GA entirely via `enable`/`disable` WS commands, unloading the core GA tears down the webhook and stops `report_state`; re-enabling re-runs setup-phase re-trigger.
- Entity exposure is handled by core's `KNOWN_ASSISTANTS` (patched at startup), the per-entity expose page (patched by `frontend.js`), and the `GoogleConfig.should_expose` monkey-patch that routes core GA's exposure decisions to the `exposed_entities` registry under our assistant ID. The expose page writes exposures into that registry; `should_expose` reads them back at SYNC time, so UI changes take effect without a resync.

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
    → ConfigEntry created for domain "hass_ga_manual_ui"
      → async_setup_entry() fires:
        1. Populates hass.data["google_assistant"]["config"]
        2. Reuses existing core GA entry (_find_core_entry) or registers a fresh
           one via async_add(), which also sets it up (no manual second setup)
        3. Reads GoogleConfig from core_entry.runtime_data
        4. Patches GoogleConfig.should_report_state → entry.options
        5. Patches GoogleConfig.secure_devices_pin → entry.options
        6. Patches GoogleConfig.should_expose → async_should_expose(hass, ASSISTANT_ID, entity_id)
        7. Registers auto-resync listeners (exposure / entity- + device-registry → requestSync)
        8. Registers WS commands (get_config/update_config/enable/disable)

Browser loads HA frontend
  → HA loads /hass_ga_manual_ui/frontend.js as extra module
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
      - hass_ga_manual_ui/get_entry_id (discover entry)
      - hass_ga_manual_ui/get_config (enabled, report_state, PIN)
      - homeassistant/expose_new_entities/get (populate "expose new" toggle)
      - homeassistant/expose_entity/list (populate entity count badge)

User toggles global enable/disable in card header:
  → JS calls hass_ga_manual_ui/enable or /disable
  → enable: re-runs setup-phase re-trigger (reuses or creates the core entry)
  → disable: _teardown_core_ga(disable=True), soft disable: report_state off +
             enabled=False; should_expose then returns False so SYNC has no devices
             (core entry/view/webhook are left registered, core GA can't unload)

User changes settings in card (when enabled):
  → JS calls hass_ga_manual_ui/update_config
  → Python handler:
    - Updates entry.options
    - If report_state changed: calls GoogleConfig.async_enable/disable_report_state() + async_schedule_google_sync_all() (willReportState is per-device, so Google must be re-synced)
    - If PIN changed: no action needed (live property patch)
```

## Example dialogue

> **Dev:** "When the user changes the report state toggle in the assistant card, does core GA get reloaded?"
> **Domain expert:** "No, the ConfigEntry options are updated via WS, and a live monkey-patch on `GoogleConfig.should_report_state` reads the new value. If enabling, `async_enable_report_state()` is called directly on the `GoogleConfig` instance. A full reload (tearing down webhooks) only happens when `project_id` or `service_account` changes, or when the global toggle disables and re-enables the entire integration."

> **Dev:** "What happens when the user flips the global toggle off on the assistant card?"
> **Domain expert:** "The core GA instance is unloaded, webhook unregistered, report_state subscriptions torn down, token cache cleared. Our ConfigEntry stays loaded so the card is still visible, just with settings rows hidden. Flipping it back on re-runs the full setup-phase re-trigger."

## Key Constants

```python
# const.py
DOMAIN = "hass_ga_manual_ui"
ASSISTANT_ID = "hass_ga_manual_ui"
```

```ts
// frontend.ts
const ASSISTANT_ID = "hass_ga_manual_ui";
const ASSISTANT_NAME = "Google Assistant (Manual)";
const SORT_TARGET = ["conversation", "cloud.alexa", "cloud.google_assistant"];
const ASSET_URL = "/hass_ga_manual_ui/assets";

const WS_GET_ENTRY_ID = `${ASSISTANT_ID}/get_entry_id`;
const WS_GET_CONFIG = `${ASSISTANT_ID}/get_config`;
const WS_UPDATE_CONFIG = `${ASSISTANT_ID}/update_config`;
const WS_ENABLE = `${ASSISTANT_ID}/enable`;
const WS_DISABLE = `${ASSISTANT_ID}/disable`;
```

## Directory Structure

Integration files live in `custom_components/hass_ga_manual_ui/` (standard HACS layout). Dev tooling stays at repo root.

```
./
├── custom_components/
│   └── hass_ga_manual_ui/     # Integration (what HACS/HA loads)
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
- Uses `hass.callService("persistent_notification", ...)` for user-facing error toasts.
- i18n: see [Frontend localization](#frontend-localization).

### Frontend localization

UI strings come from three places:

1. **Config flow (Python)**, HA's translation keys in `strings.json` /
   `translations/en.json`, rendered by HA's backend. Standard form fields,
   errors, titles, etc.
2. **Frontend strings that exist in HA core**, localized at the call site with
   `hass.localize("ui.panel...")` and an English fallback. Free translations in
   70+ languages; reuse a core key wherever one fits.
3. **Strings unique to this integration**, the YAML/install notices and the
   card text. These live in `locale/<lang>.json` (NOT the HA translation files,
   which only accept HA's fixed schema, hassfest rejects custom keys). Shape:
   `{ "yaml_notice": "...", "install_notice": "...", "frontend": { …card… } }`.

For (3), the same `locale/<lang>.json` files are read two ways:

- **Python** (`locale.async_load_locale`) reads `yaml_notice` (injected into the
  config-flow step via `description_placeholders`) and `install_notice` (the
  post-install notification), with English fallback. The notification *title*
  still comes from the standard `config.step.user.title` key.
- **Frontend**, `frontend.py` serves `locale/` at `/<domain>/locale/`;
  `ensureTranslationsLoaded()` `fetch()`es `/<domain>/locale/<lang>.json` once
  (exact tag, then base language) and maps its `frontend` block into
  `_loadedStrings`. `t("key", { … })` returns the loaded string, falling back to
  `EN_STRINGS`, with `{placeholders}` substituted. `EN_STRINGS` is **not**
  hand-maintained: `frontend.ts` imports `locale/en.json` and esbuild inlines its
  `frontend` block at build time (`resolveJsonModule`), so `en.json` is the single
  English source of truth. `LocaleTable` still pins the key set, so a key missing
  from `en.json`'s `frontend` block is a compile error. Because the fetch is
  async, text rendered at card-build time registers a `_retranslate` callback so
  it refreshes once strings arrive.

To add a language: add `config`/`options` blocks to `translations/<lang>.json`
(HA schema) **and** a `locale/<lang>.json` for the custom strings, no code
changes. Keep `strings.json` and `translations/en.json` identical for English.

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
| `npm run build:dist` | Build JS + create `build/custom_components/hass_ga_manual_ui/` with only runtime files |
| `npm run watch` | Rebuild `frontend.js` on every `.ts` change |
| `npm run check` | Full type-check: `tsc --noEmit` + `pyrefly check` |
| `npm run lint` | Full lint: `eslint frontend.ts tests/` + `ruff check .` + `ruff format --check .` |
| `npm run fix` | Auto-fix all: `eslint --fix` + `ruff check --fix` + `ruff format` |
| `npm test` | Run all tests: `vitest run` (18 TS tests) + `python -m pytest tests/ -q` (163 Python tests) |

### Testing

Two test frameworks serve different parts of the codebase:

**Vitest** (`vitest.config.ts`), TypeScript tests:
- DOM environment (via `@vitest/environment-dom` / `jsdom`)
- 18 tests in `tests/frontend.test.ts`
- Covers patch logic, card building, DOM manipulation, and WebSocket interactions
- Runs as `vitest run` (single shot, no watch mode)

**pytest** (`pytest.ini`), Python tests:
- 163 tests across 5 files in `tests/`
- Async-compatible via `pytest-asyncio` (auto mode)
- Shared fixtures in `tests/conftest.py`:
  - `mock_config_entry()` / `mock_config_entry_minimal()`, build `ConfigEntry`-like objects for all test scenarios
  - `FakeGoogleConfig`, stand-in for core GA's `GoogleConfig` with `should_report_state` and `secure_devices_pin` properties and a `should_expose` method
  - `mock_ws_connection()`, fake WebSocket connection with `send_result` / `send_error` tracking
  - `reset_version_cache`, `reset_original_props_cache`, autouse fixtures to prevent test pollution
- Test files:
  - `test_init.py`, `_build_core_config`, `_make_core_entry`, `_find_core_entry`, `_reconcile_core_ga_entries`, `_safe_get_entry`, WS schemas, `_add_assistant_to_schema`, `_patch_google_config_properties`, `_teardown_core_ga` (unload vs disable), `_patch_core_assistants`
  - `test_config_flow.py`, validation, `_parse_service_account_json`, `_is_valid_project_id`, flow steps
  - `test_const.py`, constant values match expectations and don't drift between Python and JS
  - `test_frontend.py`, HTTP path registration, asset serving
  - `frontend.test.ts`, JS patch functions, card DOM structure, WS client calls

### Tooling

**TypeScript** (`tsconfig.json`):
- `strict: true`, ES2020 target, DOM lib
- Source: `frontend.ts`, no emit (esbuild handles output)

**esbuild** (package.json `build` script):
- Bundles `frontend.ts` as an IIFE targeting ES2020
- No dependencies, self-contained output in `frontend.js`

**ESLint** (`eslint.config.mjs`):
- Flat config with `typescript-eslint` recommended rules
- `no-explicit-any` off (not needed, zero `any` in code)
- `no-unused-vars` with `argsIgnorePattern: "^_"`

**Ruff** (`ruff.toml`):
- Rules: pycodestyle, pyflakes, isort, pyupgrade, bugbear, simplify, comprehensions
- Formatter: double quotes, spaces
- Target: Python 3.14

**Pyrefly** (`pyrefly.toml`):
- Preset: `strict`
- All `homeassistant.*` and `voluptuous` imports replaced with `Any` (packages not installable outside HA)
- Search path: `..` (so the `hass_ga_manual_ui` package resolves relative imports)
- Excludes: `references/`, `.venv/`

### Pre-commit workflow

```bash
npm run lint    # catch style/format issues
npm run check   # catch type errors
npm run build   # verify JS compiles
npm test        # verify tests pass
```

`lint`, `check`, `build`, and `test` must all pass with zero errors before committing.

## Commenting conventions

**Python:** every function, class, and module gets a docstring (`"""..."""`). Inner closures and nested callbacks get the same treatment, no bare functions. Docstrings are concise (one line for simple helpers, a few lines for complex logic). Inline `#` comments explain *why*, not *what*; they belong next to surprising behaviour, design compromises, and gotchas, not on every line.

**TypeScript:** no JSDoc. Use `//` line comments above functions for headers and `//` inline comments for rationale. A `//` header sketches the function's job and any non-obvious decisions. Comment density mirrors the Python side, every public function gets a header, private helpers get one when their purpose isn't obvious from the name.

**Separators:** `// ----` (TS) and `# ----` (Python) bracket major logical sections inside long files. Source code uses dashes; tests use equals (`====` / `====`). Keep separator banners narrow (~80 chars) with a short label.

**Block comments:** never use `/* */` for inline comments, use `//` everywhere.

## Build / Deployment

The project source is TypeScript and Python. Deployment requires the compiled JS artifact.

```bash
# Build the distributable directory
npm run build:dist

# Copy into HA config
cp -r build/custom_components/hass_ga_manual_ui /config/custom_components/
```

Then go to Settings → Devices & Services → Add Integration → Google Assistant (Manual).

## Key Design Decisions

1. **Monkey-patching over forking.** Rather than modifying HA core files, all changes are runtime patches. This makes the integration a drop-in custom component that works with any HA version (within reason).

2. **TypeScript over vanilla JS.** The frontend companion is TypeScript with strict mode, compiled to vanilla JS via esbuild for deployment. This catches null errors, wrong argument counts, and DOM API misuse at build time without adding runtime dependencies.

3. **Idempotent card injection.** The card injection is designed to be called from multiple lifecycle hooks (`connectedCallback`, `firstUpdated`, `updated`, DOM scans, MutationObservers) without creating duplicates. The `[data-ga-manual-card]` marker ensures only one card exists.

4. **Defensive patching with tiered logging.** Every patch, WS call, and DOM operation is wrapped in try/except (Python) or try/catch (JS). All failures are logged with `[GA Manual]` prefix, full tracebacks, and actionable messages. The JS side surfaces critical errors via `persistent_notification` toasts.

   **Backend logging** uses the standard `_LOGGER`: `.debug()` for verbose tracing (only emitted when the integration's log level is DEBUG) and `.error()`/`.exception()` for problems (always emitted). Users enable verbose logging via the config entry's ⋮ → **Enable debug logging**, or `logger:` in `configuration.yaml` (`custom_components.hass_ga_manual_ui: debug`). No code needed, HA handles it.

   **Frontend logging** mirrors this in three tiers:
   - `_banner()`, always logged to the console **and** once to the HA logs (via `system_log.write`, logger `hass_ga_manual_ui.frontend`) so the user can confirm the companion loaded without dev tools.
   - `_warn()`/`_error()`, always logged to the console **and** forwarded to the HA logs.
   - `_debug()`/`_info()`, verbose; only logged when the debug flag is set: `localStorage.setItem("gaManualDebug", "1")` (or `?gaManualDebug` in the URL), then reload.

5. **Schema walking for WS patches.** Rather than manually updating each Voluptuous schema, `_walk()` recursively finds all `vol.In` validators containing `"conversation"` and adds the new ID. Each walked node is tracked by path for targeted error reporting if the schema structure changes.

6. **Config layer architecture.** This integration is a config management layer on top of core GA. It stores configuration in a `ConfigEntry.options` and bridges to core GA via setup-phase re-trigger + live property monkey-patches. Settings changes take effect immediately without requiring a full reload, only the global toggle or credential changes trigger a full teardown/re-setup cycle.

## Known Limitations

1. **HA version coupling.** If HA core renames `KNOWN_ASSISTANTS`, moves `exposed_entities`, changes WebSocket command schemas, or renames custom element tags, patches may fail. All failures are logged with detailed context to assist debugging.

2. **WebSocket handler availability.** `_patch_core_assistants()` accesses `hass.data["websocket_api"]`, which may not be populated yet during `async_setup`. The code logs a warning and skips WS patching if handlers are unavailable, the patching will be attempted on the first WS call that triggers validation.

3. **Sort key injection is fragile.** `patchSortKey()` detects the sort array by exact content match `["conversation", "cloud.alexa", "cloud.google_assistant"]`. If HA changes the sort order, the patch won't fire and the card will appear at the bottom.

4. **Single-entry assumption.** The integration is designed for one Google Assistant project. Multiple entries are not tested. The JS fetches the first entry via `get_entry_id` WS.

5. **Core GA availability.** This integration requires the built-in `google_assistant` component to be available. If import fails, setup raises a descriptive `RuntimeError`.

6. **No clean runtime teardown of core GA.** Core GA has no `async_unload_entry` and registers an HTTP view + local-SDK webhook that aiohttp cannot remove at runtime. The integration therefore sets the core entry up at most once per process and uses a **soft disable** (report_state off + `should_expose` gated on `enabled`) instead of unloading. The view/webhook persist (idle) while disabled and are only cleared by an HA restart.

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
- **`core-dev/`**, `home-assistant/core` (the built-in `google_assistant` integration, `exposed_entities.py`, WebSocket API schemas)
- **`frontend-dev/`**, `home-assistant/frontend` (Lit custom elements, voice assistant UI components, expose page)

These are **read-only study materials** used during development to understand how the core voice assistant system works. They are not part of the project and should not be modified.
