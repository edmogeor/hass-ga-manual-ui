# Google Assistant (Manual) — Agent Documentation

## Overview

A Home Assistant custom integration that adds a "Google Assistant (Manual)" entry to the voice assistants UI, enabling GUI-based entity exposure for the [manual Google Assistant integration](https://www.home-assistant.io/integrations/google_assistant/) (service-account-based, no Nabu Casa Cloud subscription required).

**Domain:** `google_assistant_manual`
**Assistant ID:** `google_assistant_manual`
**Type:** HA custom integration (Python 3 + vanilla JS)
**Install:** Place this entire project folder as `custom_components/google_assistant_manual/` in HA config, then restart.

## Problem Solved

HA core hardcodes three voice assistants for entity exposure:
- `conversation` (built-in Assist)
- `cloud.alexa` (requires Nabu Casa Cloud)
- `cloud.google_assistant` (requires Nabu Casa Cloud)

Users running the manual Google Assistant integration had to use YAML config for entity exposure — there was no GUI option. This integration adds a fourth assistant ID so exposure can be managed entirely through the UI.

## Architecture

Two-layer monkey-patching approach. Neither layer modifies core HA files on disk — all patches are applied at runtime.

### Layer 1: Python Backend

**Files:** `__init__.py`, `const.py`, `frontend.py`

On `async_setup()`:
1. Patches `KNOWN_ASSISTANTS` tuple in `homeassistant.components.homeassistant.exposed_entities` to include `"google_assistant_manual"`.
2. Walks the Voluptuous schemas for three WebSocket commands and injects the new assistant ID into any `vol.In` validator that contains `"conversation"`.
3. Registers static HTTP paths to serve `frontend.js` and `assets/icon.png`.
4. Registers `frontend.js` as an extra JS module so the HA frontend loads it.

**Patched WS commands:**
- `homeassistant/expose_entity` — set per-entity exposure
- `homeassistant/expose_new_entities/get` — read "expose new entities" toggle
- `homeassistant/expose_new_entities/set` — write "expose new entities" toggle

**No config entries, no entities, no services, no storage.** Fully stateless — all state lives in HA core's `exposed_entities` storage.

### Layer 2: JavaScript Frontend Companion

**File:** `frontend.js` (604 lines, vanilla JS, no framework, no bundler)

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
      <ha-switch> (global toggle)
  <div.card-content>
    <p> (description text)
    <ha-md-list-item> "Expose new entities" + <ha-switch>
    <ha-md-list-item> "Enable state reporting" + <ha-switch>
    <ha-md-list-item> "Security devices" (info text)
    <ha-input> (PIN input for security devices)
  <div.card-actions>
    <a> → "Exposed entities" <ha-button> (with live count)
```

All settings rows are hidden by default. The global toggle shows/hides them.

**Card injection (`injectCardInto()`):**
- Idempotent — guarded by `[data-ga-manual-card]` marker
- Inserts into `.content` of `ha-config-voice-assistants-assistants`
- Calculates insertion point via `INSERTION_LOOKUP` priority list
- Uses `MutationObserver` to wait if `.content` is still empty
- `_observerActive` WeakSet prevents duplicate observers

**DOM scanning:**
- `findAllAssistantsElements()` recursively walks the DOM including all shadow roots
- Called at init and via a document-level `MutationObserver` to catch dynamically loaded elements

## Key Constants

```python
# const.py
DOMAIN = "google_assistant_manual"
ASSISTANT_ID = "google_assistant_manual"
```

```js
// frontend.js
const ASSISTANT_ID = "google_assistant_manual";
const ASSISTANT_NAME = "Google Assistant (Manual)";
const SORT_TARGET = ["conversation", "cloud.alexa", "cloud.google_assistant"];
const ASSET_URL = "/google_assistant_manual/assets";
```

## Directory Structure

All source files live at repo root for development. For deployment, users create the HA-required path.

```
./
├── __init__.py          # Integration entry point, patches core assistants + WS schemas
├── const.py             # DOMAIN and ASSISTANT_ID constants
├── frontend.py          # Serves JS and static assets via HA HTTP
├── frontend.js          # 604-line JS companion that patches the HA frontend UI
├── manifest.json        # HA integration manifest
└── assets/
    └── icon.png         # Google Assistant brand icon

references/              # READ-ONLY reference copies (not project code)
├── core-dev/            # Snapshot of home-assistant/core repo
│   └── homeassistant/components/
│       ├── google_assistant/   # The built-in cloud Google Assistant integration
│       └── homeassistant/exposed_entities.py  # Defines KNOWN_ASSISTANTS tuple
└── frontend-dev/        # Snapshot of home-assistant/frontend repo
    └── ...              # Lit/TypeScript frontend source (for reference)
```

## Data Flow

```
HA starts
  → async_setup() called
    → _patch_core_assistants(): adds ID to KNOWN_ASSISTANTS + WS schemas
    → async_setup_frontend(): registers static paths + extra JS URL
  → Integration ready

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
      - homeassistant/expose_new_entities/get (populate "expose new" toggle)
      - homeassistant/expose_entity/list (populate entity count badge)

User toggles "Expose new entities"
  → hass.callWS({ type: "homeassistant/expose_new_entities/set", ... })

User clicks "Exposed entities"
  → navigates to /config/voice-assistants/expose?assistants=google_assistant_manual
  → Expose page shows google_assistant_manual as a voice assistant option
```

## Dependencies

### Python
- `homeassistant` (core framework)
- `voluptuous` (schema validation, available in HA)
- No external pip dependencies

### JavaScript
- **None.** Vanilla JS only. Targets the HA frontend which uses Lit/Material Web.
- Uses `hass.callWS()` for WebSocket calls (provided by HA frontend).
- Uses `hass.localize()` for i18n where available, with English fallbacks.

## Build / Deployment

No build step. Copy the project folder into HA config, then restart.

```bash
cp -r . /config/custom_components/google_assistant_manual/
# or for HA OS / container:
# scp -r . user@ha:/config/custom_components/google_assistant_manual/
```

Then go to Settings → Devices & Services → Add Integration → Google Assistant (Manual).

## Key Design Decisions

1. **Monkey-patching over forking.** Rather than modifying HA core files, all changes are runtime patches. This makes the integration a drop-in custom component that works with any HA version (within reason).

2. **Vanilla JS over bundled framework.** The frontend companion is pure vanilla JS to avoid needing a build system. This simplifies deployment — no bundler, no npm, no compilation step.

3. **Idempotent card injection.** The card injection is designed to be called from multiple lifecycle hooks (`connectedCallback`, `firstUpdated`, `updated`, DOM scans, MutationObservers) without creating duplicates. The `[data-ga-manual-card]` marker ensures only one card exists.

4. **Defensive patching.** The Python side wraps `KNOWN_ASSISTANTS` patching in try/except. The JS side checks for already-patched objects via `WeakSet` and checks element existence before patching.

5. **Schema walking for WS patches.** Rather than manually updating each Voluptuous schema, `_walk()` recursively finds all `vol.In` validators containing `"conversation"` and adds the new ID. This means the patching adapts if HA adds/removes WS parameters.

## Known Limitations / Caveats

1. **HA version coupling.** If HA core renames `KNOWN_ASSISTANTS`, moves `exposed_entities`, changes WebSocket command schemas, or renames custom element tags, patches will silently fail. The `_LOGGER` will log errors.

2. **WebSocket handler availability.** `_patch_core_assistants()` accesses `hass.data["websocket_api"]`, which may not be populated yet during `async_setup`. The code logs a debug message and skips WS patching if handlers are unavailable.

3. **Settings rows are cosmetic.** The "Enable state reporting" toggle, "Security devices" section, and PIN input are displayed but do not actually configure anything — they are UI placeholders. Only the "Expose new entities" toggle has a working WebSocket handler.

4. **No actual Google Assistant configuration.** This integration only handles entity *exposure* in the UI. Users must still configure the manual Google Assistant integration separately (service account, YAML config for `google_assistant:` domain).

5. **Sort key injection is fragile.** `patchSortKey()` detects the sort array by exact content match `["conversation", "cloud.alexa", "cloud.google_assistant"]`. If HA changes the sort order, the patch won't fire.

## How to Extend

### Adding a new setting to the card

1. In `buildCard()` (~line 316), add a new `makeSwitchSettingItem()` or `makeSettingItem()` call.
2. If it needs a toggle handler, add the handler function and attach it in the `sw.addEventListener("change", handler)` call.
3. If it needs to read/write state via WebSocket, use `hass.callWS()` pattern from `refreshExposeToggle()` or `onExposeToggle()`.

### Adding a new custom element to patch

1. Add the element tag name and patcher function to the `PATCHERS` object (~line 246).
2. Write a patcher function following the `_patchXxxProto()` pattern.
3. The custom elements infrastructure handles both new definitions (via `customElements.define` interceptor) and already-defined elements (via the fallback loop at lines 261-264).

### Changing the assistant name or icon

- Update `ASSISTANT_ID` and `ASSISTANT_NAME` in both `const.py` and `frontend.js`.
- Replace `assets/icon.png`.
- Ensure `manifest.json` name and domain stay consistent.

## Reference Materials

The `references/` directory contains snapshots of:
- **`core-dev/`** — `home-assistant/core` (the built-in `google_assistant` integration, `exposed_entities.py`, WebSocket API schemas)
- **`frontend-dev/`** — `home-assistant/frontend` (Lit custom elements, voice assistant UI components, expose page)

These are **read-only study materials** used during development to understand how the core voice assistant system works. They are not part of the project and should not be modified.
