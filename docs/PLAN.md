# Implementation Plan: Google Assistant (Manual) HACS Integration

## Goal

Turn the existing UI-patching prototype into a fully functional HACS integration that
reaches feature parity with the Nabu Casa Cloud Google Assistant integration, enabling
users to configure the manual Google Assistant entirely through the UI — no YAML required
(but YAML import supported for migration).

## Decisions Made (this session)

| Q# | Decision | Rationale |
|----|----------|-----------|
| 1  | Scope: **Full config replacement** (B) | Project_id, service_account, report_state, PIN all in UI |
| 2  | **Config layer** on top of core GA (B) | Core GA does heavy lifting (webhooks, state reporting); this integration manages config |
| 3  | Storage: **ConfigEntry with YAML import** (D) | Backwards-compatible; YAML seeds defaults, ConfigEntry is authoritative |
| 4/5 | **Setup-phase re-trigger** — register core entry via `async_add()` | Core GA is no-op without YAML; after setup, populate `hass.data["google_assistant"]` and register a real `ConfigEntry` via `hass.config_entries.async_add()` (which registers, sets up, and persists it). The entry is reused across restarts and only fully removed on disable. _Superseded the original direct `async_setup_entry` call on a `SimpleNamespace` — calling both `async_add()` and `async_setup_entry()` caused duplicate webhook/setup._ |
| 6  | Config flow: **project_id + service_account only** | Other settings (report_state, PIN, exposure) live in assistants-UI card |
| 7  | Service account: **textarea paste**, parse JSON on submit | Avoids non-standard file upload; extract `client_email` + `private_key` |
| 8  | Product: **config_flow.py + hacs.json + translations** | Standard HACS integration shape |
| 9  | Card settings: **WS + ConfigEntry options** (D) | WS commands wrap ConfigEntry options updates |
| 10 | `exposed_domains`: **skip** (B) | Cloud version doesn't surface it; YAML import ports it but UI doesn't edit it. Exposure flows through the modern `exposed_entities` registry instead of the legacy YAML model — `GoogleConfig.should_expose` is monkey-patched to read it under our `ASSISTANT_ID` (see Phase 2 step 7) |
| 11 | HA version: **target latest, expand later** | `"homeassistant": "2025.6.0"` in manifest |
| 12 | Load order: **setup-phase re-trigger** | Avoid `open()`/manifest monkey-patching; use core GA's no-YAML-no-op design |
| 13 | YAML compat: **Import top-level, skip entity_config, warn** (C-mod) | Port project_id, service_account, report_state, expose_by_default, exposed_domains, secure_devices_pin. Skip entity_config. Warn user. ConfigEntry takes precedence after import. |
| 14 | WS API: **get, update, enable, disable** | `google_assistant_manual/get_config` + `update_config` for settings; `enable`/`disable` for the global toggle that loads/unloads core GA |
| 15 | Config flow: **two steps** — step 1: project_id, step 2: service account textarea | Simple, works with HA's form-based config flows |
| 16 | Global toggle: **unload/reload core GA ConfigEntry** (A) | Toggle off = tear down webhook/report_state, card stays but settings hidden. Toggle on = re-setup. Mirrors `cloud-google-pref` behavior exactly. |

---

## Files to Create

### 1. `hacs.json`
HACS dashboard metadata. Minimal:
```json
{
  "render_readme": true,
  "homeassistant": "2025.6.0",
  "hide_default_brand": false
}
```

### 2. `config_flow.py`
Standard HA config flow. Two steps:

**Step 1** (`async_step_user` → `async_step_service_account`):
- Fields: `project_id` (required, text)
- On submit: validate format, transition to step 2

**Step 2** (`async_step_service_account`):
- Fields: `service_account_json` (required, multi-line textarea, description linking to GCP docs)
- On submit: parse JSON, extract `client_email` + `private_key`, validate both present
- Handle JSON parse errors gracefully (show error string)
- Create entry with: `data = {"project_id": ..., "service_account": {"client_email": ..., "private_key": ...}}`

**Import flow** (`async_step_import`):
- Triggered when YAML config exists
- Read YAML's `google_assistant:` section
- Extract top-level keys: `project_id`, `service_account`, `report_state`, `expose_by_default`, `exposed_domains`, `secure_devices_pin`
- Pre-fill step 1 with `project_id`, step 2 with service_account
- Set `options` from the other keys (report_state, etc.)
- Show a warning: "Per-entity settings from YAML will not be migrated. Configure entity exposure via the Voice Assistants UI."
- On confirm, create entry with imported data

### 3. `translations/en.json`
Strings for the config flow UI (HA requires translations for config flows):
- Step titles, field labels, descriptions
- Error messages (invalid JSON, missing fields, invalid project_id)
- YAML import warning text

### 4. `strings.json`
Source-of-truth translation keys (HA generate script reads this to produce `translations/en.json`).

---

## Files to Modify

### 5. `__init__.py` — major changes

**Add `async_setup_entry(hass, entry)`**:
1. Build config dict from entry.data + entry.options
2. Set `hass.data.setdefault("google_assistant", {})["data_config"] = config_dict`
3. Import `async_setup_entry` from `homeassistant.components.google_assistant`
4. Construct a `ConfigEntry` for domain `"google_assistant"` via `ConfigEntry(version=1, ...)`
5. Register it in `hass.config_entries._entries`
6. Call core GA's `async_setup_entry(hass, ga_entry)`
7. Store reference to `GoogleConfig` instance (from `entry.runtime_data`) in your entry's runtime_data
8. Patch `GoogleConfig` properties: `should_report_state` and `secure_devices_pin` to read from entry.options
9. Register WS commands for card settings

**Add `async_reload_entry(hass, entry)`**:
- Teardown: remove core GA's ConfigEntry from `hass.config_entries._entries`, call `async_unload_entry` if available
- Call `async_setup_entry(hass, entry)` again

**Modify `async_setup()`**:
- Keep existing `KNOWN_ASSISTANTS` and WS schema patching (unchanged)
- Keep `frontend.async_setup_frontend()` (unchanged)
- Add: after `homeassistant` component is loaded, register WS commands

**WS command handlers**:
- `google_assistant_manual/get_config`: read entry.options, return dict with all settings including `enabled` (whether core GA ConfigEntry is currently loaded)
- `google_assistant_manual/update_config`: validate incoming dict, update entry.options via `hass.config_entries.async_update_entry`, trigger monkey-patched live updates (report_state enable/disable on change)
- `google_assistant_manual/enable`: run setup-phase re-trigger to create and load core GA ConfigEntry, update options to mark enabled
- `google_assistant_manual/disable`: unload core GA ConfigEntry (teardown webhook, stop report_state), update options to mark disabled. Keep `google_assistant_manual` entry loaded so card remains visible

### 6. `frontend.js` — medium changes

**Global toggle (card header switch)**:
- Mirrors `cloud-google-pref`'s `google_enabled` toggle exactly
- Toggle OFF → calls `google_assistant_manual/disable` WS command → unloads core GA ConfigEntry, tears down webhook + report_state. Card shows settings rows hidden, "Exposed entities" link hidden (same as cloud card)
- Toggle ON → calls `google_assistant_manual/enable` WS command → re-runs setup-phase re-trigger. Card shows settings rows
- On card mount, fetch enabled state from `get_config`. Toggle reflects current state

**Fix stub handlers**:
- State reporting toggle: bind to `_onReportStateToggle(ev)` → calls `hass.callWS({type: "google_assistant_manual/update_config", data: {report_state: ev.target.checked}})` (only visible when global toggle is ON)
- PIN input: bind to `_onPinChanged(ev)` → debounced call to `hass.callWS({type: "google_assistant_manual/update_config", data: {secure_devices_pin: ev.target.value}})` (only visible when global toggle is ON)

**Add initial state fetch**:
- On card mount, call `hass.callWS({type: "google_assistant_manual/get_config"})` to populate toggle states (including `enabled`)

### 7. `manifest.json` — update

```json
{
  "domain": "google_assistant_manual",
  "name": "Google Assistant (Manual)",
  "after_dependencies": ["homeassistant"],
  "codeowners": [],
  "config_flow": true,
  "dependencies": ["frontend"],
  "homeassistant": "2025.6.0",
  "integration_type": "service",
  "iot_class": "local_push",
  "version": "2.0.0"
}
```
Changes: add `"config_flow": true`, `"homeassistant": "2025.6.0"`, bump version.

### 8. `const.py` — add keys

Add constants for ConfigEntry data/options keys and WS command names.

### 9. `frontend.py` — minor changes

Register WS static paths for the new commands, or delegate to `__init__.py`.

---

## Data Flow Diagram (updated)

```
User configures via UI
  → config_flow async_step_user (project_id)
    → async_step_service_account (service account JSON)
      → ConfigEntry created for "google_assistant_manual"
        → async_setup_entry() fires:
          1. Populates hass.data["google_assistant"]["data_config"]
          2. Reuses the existing core GA ConfigEntry, or registers a fresh one
             via hass.config_entries.async_add() (which ALSO sets it up — no
             manual second async_setup_entry call)
          3. Reads GoogleConfig from core_entry.runtime_data
          4. Patches GoogleConfig.should_report_state → entry.options
          5. Patches GoogleConfig.secure_devices_pin → entry.options
          6. Patches GoogleConfig.should_expose → async_should_expose(hass, ASSISTANT_ID, entity_id)
          7. Registers WS commands (get/update/enable/disable)

User visits Voice Assistants config page
  → Card renders (existing injection mechanism)
  → Card fetches state via 'google_assistant_manual/get_config'
  → Global toggle reflects enabled state, show/hide settings rows
  → Toggles active, bound to WS handlers

User toggles global enable/disable in card header
  → JS calls 'google_assistant_manual/enable' or 'disable'
  → enable:  re-runs setup-phase re-trigger (reuses or creates the core entry)
  → disable: _teardown_core_ga(remove_entry=True) — deinits GoogleConfig, removes
             HTTP routes, removes the core GA ConfigEntry
  (plain unload/reload uses remove_entry=False and keeps the persisted core entry)

User changes settings in card (when enabled)
  → JS calls 'google_assistant_manual/update_config'
  → Python handler:
    - Updates entry.options
    - If report_state changed: calls GoogleConfig.async_enable/disable_report_state()
    - If PIN changed: no action needed (live property patch)
```

---

## Implementation Order

### Phase 1: Config Flow Foundation
1. Create `config_flow.py` with two-step user flow
2. Create `strings.json` + `translations/en.json`
3. Update `manifest.json` (`config_flow: true`)
4. Test: integration appears in "Add Integration" dialog, config flow works

### Phase 2: Core GA Bridge
5. Implement `async_setup_entry()` in `__init__.py`
6. Register the core GA `ConfigEntry` via `async_add()` (reuse if it already exists; never also call `async_setup_entry` manually), and reconcile/persist it across restarts (`_reconcile_core_ga_entries`, `_find_core_entry`)
7. Implement `GoogleConfig` property monkey-patches (`should_report_state`, `secure_devices_pin`) plus the `should_expose` method patch that bridges exposure to the `exposed_entities` registry under our `ASSISTANT_ID`
8. Test: after config flow, core GA is functional (webhook registered, devices appear in Google Home)

### Phase 3: WS Commands
9. Register `get_config`, `update_config`, `enable`, `disable` WS commands
10. Implement report_state enable/disable live toggle
11. Implement PIN update handler
12. Implement enable/disable handlers (unload/reload core GA ConfigEntry)
13. Test: WS commands work via dev tools `hass.callWS()` 

### Phase 4: JS Card Fixes
13. Fix stub handlers in `frontend.js` (report_state, PIN)
14. Add initial state fetch on card mount
15. Test: card toggles and PIN persist across page reloads

### Phase 5: YAML Import
16. Implement `async_step_import` in config_flow
17. Add warning for entity_config not being migrated
18. Test: import from existing YAML config, verify settings port correctly

### Phase 6: Packaging
19. Create `hacs.json`
20. Version bump, tag release
21. Test full install via HACS

---

## Risk Register

| Risk | Impact | Mitigation |
|------|--------|------------|
| Core GA `async_setup_entry` not designed for external call | Blocker | Test early (Phase 2). Fallback: import and call internal setup functions directly |
| ConfigEntry construction via private `_entries` dict breaks on HA update | Medium | HA's `ConfigEntry.__init__` is stable. `_entries` access is common in custom integrations |
| `GoogleConfig` property monkey-patches break on HA update | Medium | Wrap in try/except, log error. Toggles fall back to requiring reload |
| `strings.json` → `translations/en.json` generation tool not available in dev | Low | Write `translations/en.json` manually for v1, add build script later |
| Service account JSON with extra fields rejected by validation | Low | `vol.Schema(extra=vol.ALLOW_EXTRA)` on the service account sub-schema |
| YAML import detects partial config (only `project_id`, no `service_account`) | Low | Validate complete config before import; skip import if incomplete |
