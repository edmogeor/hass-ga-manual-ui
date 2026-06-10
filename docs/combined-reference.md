# Google Assistant — Combined Config & System Reference

Source: `references/core-dev/homeassistant/components/google_assistant/`, `cloud/`, and `homeassistant/exposed_entities.py`

---

## 1. Architecture Overview

There are **two independent config systems** that both apply:

| System | Location | Storage | Used By |
|--------|----------|---------|---------|
| **YAML config** (`configuration.yaml`) | `google_assistant/__init__.py` + `http.py` | Read from RAM (`hass.data[DOMAIN][DATA_CONFIG]`) | Cloud/manual GA integration |
| **UI-based exposure** (`exposed_entities.py`) | `homeassistant/components/homeassistant/exposed_entities.py` | `.storage/homeassistant.exposed_entities` + entity registry options | All assistants (cloud, manual GA, conversation) |

The manual GA integration (`google_assistant`) uses **both**: YAML controls how GA syncs and reports, and UI exposure controls which entities appear in the sync payload.

---

## 2. YAML Config (Manual GA Integration)

### 2.1 Schema

Defined in `__init__.py:69-91` (ENTITY_SCHEMA on lines 45-52).

```yaml
google_assistant:
  project_id: "my-project-id"           # REQUIRED. Google Cloud project ID
  expose_by_default: true               # default: true
  exposed_domains:                      # default: 22 domains
    - alarm_control_panel
    - binary_sensor
    - climate
    - cover
    - event
    - fan
    - group
    - humidifier
    - input_boolean
    - input_select
    - lawn_mower
    - light
    - lock
    - media_player
    - scene
    - script
    - select
    - sensor
    - switch
    - vacuum
    - valve
    - water_heater
  report_state: false                   # Needs service_account
  secure_devices_pin: "1234"            # PIN for locks/alarms (2FA challenge)
  service_account:                      # Required if report_state=true
    private_key: "-----BEGIN PRIVATE KEY-----..."
    client_email: "name@project.iam.gserviceaccount.com"
  entity_config:                        # Per-entity overrides
    light.living_room:
      name: "Main Light"                # Override primary name
      expose: true/false                # Explicit expose flag
      aliases:                          # Additional nicknames
        - "Big Light"
        - "Overhead"
      room: "Living Room"               # Room hint (overrides HA area)
```

### 2.2 Per-Entity Config Keys

From `const.py:35-46`:

| Key | Field | Type | Description |
|-----|-------|------|-------------|
| `CONF_NAME` | `name` | `str` | Override primary name sent to Google |
| `CONF_EXPOSE` | `expose` | `bool` | Force expose/hide this entity |
| `CONF_ALIASES` | `aliases` | `[str]` | Additional nicknames |
| `CONF_ROOM_HINT` | `room` | `str` | Room assignment hint |

### 2.3 Where YAML Config Lives in Memory

- `async_setup()` (`__init__.py:100-116`): Reads YAML → `hass.data[DOMAIN] = { DATA_CONFIG: yaml_config }`
- `async_setup_entry()` (`__init__.py:119-174`): Merges YAML with config entry → `GoogleConfig(hass, config)`
- Accessed at runtime via `self._config.get(...)` and `self.entity_config.get(...)` on `GoogleConfig` (`http.py:79-191`)

---

## 3. Entity Exposure: YAML vs. UI

### 3.1 YAML-Based Exposure (`GoogleConfig.should_expose()`)

`http.py:160-190`

```python
def should_expose(self, entity_id: str) -> bool:
    expose_by_default = self._config.get(CONF_EXPOSE_BY_DEFAULT)       # default: True
    exposed_domains = self._config.get(CONF_EXPOSED_DOMAINS)           # 22 domains
    explicit_expose = self.entity_config.get(entity_id, {}).get(CONF_EXPOSE)
    auxiliary_entity = (
        registry_entry.entity_category is not None
        or registry_entry.hidden_by is not None
    )
    domain_exposed_by_default = (
        expose_by_default and domain in exposed_domains
    )
    entity_exposed_by_default = domain_exposed_by_default and not auxiliary_entity
    is_default_exposed = entity_exposed_by_default and explicit_expose is not False
    return is_default_exposed or explicit_expose
```

**Decision tree:**
```
expose_by_default = yaml.expose_by_default            # True by default
exposed_domains   = yaml.exposed_domains              # 22 domains by default
explicit_expose   = entity_config[entity_id].expose   # per-entity YAML
auxiliary         = has entity_category OR hidden_by

IF explicit_expose IS True  → EXPOSED
IF explicit_expose IS False → NOT EXPOSED
IF auxiliary                → NOT EXPOSED
IF domain NOT in exposed_domains → NOT EXPOSED
IF NOT expose_by_default    → NOT EXPOSED
ELSE                        → EXPOSED
```

**Key:** Explicit expose (True) always wins. Explicit hide (False) always wins. Otherwise defaults apply.

### 3.2 UI-Based Exposure (`ExposedEntities.async_should_expose()`)

`exposed_entities.py:244-268`

```python
def async_should_expose(self, assistant: str, entity_id: str) -> bool:
    registry_entry = entity_registry.async_get(entity_id)
    # Check if already stored in entity options
    if assistant in registry_entry.options:
        if "should_expose" in registry_entry.options[assistant]:
            return registry_entry.options[assistant]["should_expose"]
    # Fall back to "expose new entities" + default rules
    if self.async_get_expose_new_entities(assistant):
        should_expose = self._is_default_exposed(entity_id, registry_entry)
    else:
        should_expose = False
    # Store result in entity options for future lookups
    entity_registry.async_update_entity_options(
        entity_id, assistant, {"should_expose": should_expose}
    )
    return should_expose
```

### 3.3 Default Exposure Domains (UI System)

`exposed_entities.py:29-62`

| Category | Default Exposed |
|----------|----------------|
| **Domains** | `climate, cover, fan, humidifier, light, media_player, scene, switch, todo, vacuum, water_heater` |
| **Binary sensor classes** | `DOOR, GARAGE_DOOR, LOCK, MOTION, OPENING, PRESENCE, WINDOW` |
| **Sensor classes** | `AQI, CO, CO2, HUMIDITY, PM10, PM25, TEMPERATURE, VOLATILE_ORGANIC_COMPOUNDS` |
| **Excluded** | Any entity with `entity_category` set or `hidden_by` set |

Note: The YAML system has a broader default list (22 domains) vs. the UI system (11 domains).

---

## 4. WebSocket Commands (UI Exposure)

All defined in `exposed_entities.py:389-471`

| Command | Params | Description |
|---------|--------|-------------|
| `homeassistant/expose_entity` | `assistants: [str]`, `entity_ids: [str]`, `should_expose: bool` | Set per-entity exposure for one or more assistants |
| `homeassistant/expose_entity/list` | (none) | List all exposed entities across all assistants |
| `homeassistant/expose_new_entities/get` | `assistant: str` | Get "expose new" preference for an assistant |
| `homeassistant/expose_new_entities/set` | `assistant: str`, `expose_new: bool` | Set "expose new" preference for an assistant |

Each command schema uses `vol.In(KNOWN_ASSISTANTS)` to validate the assistant ID.

---

## 5. Room / Zone Assignment

`helpers.py:646-649`

**Priority order:**
1. **YAML `room:` config** on the entity → used as `roomHint`
2. **HA Area** assigned to the entity → used as `roomHint`
3. **HA Area** assigned to the entity's parent device → used as `roomHint`
4. **No area** → no `roomHint` sent (Google places device in default room)

**Area resolution chain** (`helpers.py:57-87`):
```
entity_id → EntityRegistry entity_entry
  ├─ entity_entry.area_id → AreaRegistry area_entry
  └─ entity_entry.device_id → DeviceRegistry device_entry
       └─ device_entry.area_id → AreaRegistry area_entry
```

**Key:** Area resolution checks `entity.area_id` first, then falls back to the device's `area_id`. The YAML `room:` config takes priority over both.

### Room/Area Caveats

- Multiple homes in Google account breaks automatic room assignment
- `scene`/`script` must be assigned to an HA area for shared household members
- Without area, only the linking user sees scene/script devices

---

## 6. Aliases & Device Naming

`helpers.py:615-626`

```python
# Get entity aliases from the intent system
aliases = intent.async_get_entity_aliases(hass, entity_entry, state=state)
name, *aliases = aliases

# YAML name override takes priority
name = entity_config.get(CONF_NAME) or name

device["name"] = {"name": name}

# Build nicknames: [primary_name, *yaml_aliases, *intent_aliases]
if (config_aliases := entity_config.get(CONF_ALIASES, [])) or aliases:
    device["name"]["nicknames"] = [name, *config_aliases, *aliases]
```

**Alias resolution order:**
1. `intent.async_get_entity_aliases()` — returns list from entity name + intent aliases (e.g., `["Living Room Light", "living room", "main"]`)
2. First element → primary `name`
3. YAML `name:` config → overrides primary name
4. Nicknames assembled as: `[primary_name, *yaml_aliases, *remaining_intent_aliases]`
5. Nicknames always include the primary name in position 0

**Example:**
- Entity: `light.living_room`, Friendly Name: "Living Room Light"
- Intent aliases: `["Living Room Light", "living room", "main"]`
- YAML: `name: "Main Light"`, `aliases: ["Big Light"]`
- Result: `name: "Main Light"`, `nicknames: ["Main Light", "Big Light", "living room", "main"]`

---

## 7. Sync Payload Structure

### 7.1 Single Entity Serialization

`helpers.py:591-683` (`GoogleEntity.sync_serialize()`)

```json
{
    "id": "light.living_room",
    "type": "action.devices.types.LIGHT",
    "traits": [
        "action.devices.traits.OnOff",
        "action.devices.traits.Brightness",
        "action.devices.traits.ColorSetting"
    ],
    "name": {
        "name": "Living Room Light",
        "nicknames": ["Living Room Light", "Big Light", "living room", "main"]
    },
    "willReportState": true,
    "attributes": {
        "colorModel": "hsv",
        "colorTemperatureRange": { "temperatureMinK": 2000, "temperatureMaxK": 6500 }
    },
    "roomHint": "Living Room",
    "deviceInfo": {
        "manufacturer": "Philips",
        "model": "Hue Bulb",
        "swVersion": "1.46.13"
    }
}
```

### 7.2 Full SYNC Response

`smart_home.py:359-364` (`create_sync_response()`)

```json
{
    "requestId": "ff36a3cc-ec34-11e6-b1a0-64510650abcf",
    "payload": {
        "agentUserId": "58379784...",
        "devices": [ /* array of device objects from sync_serialize() */ ]
    }
}
```

### 7.3 Serialized Entity Data Sources (from `sync_serialize()`)

| Data | Source | Code |
|------|--------|------|
| Entity name | Friendly name → intent aliases | `helpers.py:619-623` |
| Nicknames | Intent aliases | `helpers.py:619-626` |
| Room hint | HA area name | `helpers.py:646-649` |
| Device info | Device registry (manufacturer, model, sw_version) | `helpers.py:670-681` |
| Matter info | Matter integration device data | `helpers.py:654-668` |
| Local SDK | `otherDeviceIds`, `customData` | `helpers.py:628-635` |
| Traits | All 24 traits auto-resolved from domain/features/device_class | `helpers.py:495-515` |
| Type | Domain + device class → Google type | `helpers.py:488-492` |

---

## 8. Config Storage Systems

### 8.1 GA Integration Storage (`GoogleConfigStore`)

`http.py:294-357`

- **File:** `.storage/google_assistant`
- **Schema version:** 1 (minor version 2)
- **Contents:**
  ```json
  {
    "version": 1,
    "minor_version": 2,
    "key": "google_assistant",
    "data": {
      "agent_user_ids": {
        "user-id-string": {
          "local_webhook_id": "generated-webhook-id"
        }
      }
    }
  }
  ```
- **Purpose:** Tracks connected agent users + their local SDK webhook IDs
- **Managed by:** `GoogleConfigStore.add_agent_user_id()` / `pop_agent_user_id()`

### 8.2 UI Exposure Storage (`ExposedEntities`)

`exposed_entities.py:100-386`

- **File:** `.storage/homeassistant.exposed_entities`
- **Schema version:** 1
- **Contents:**
  ```json
  {
    "version": 1,
    "key": "homeassistant.exposed_entities",
    "data": {
      "assistants": {
        "conversation": { "expose_new": true },
        "cloud.google_assistant": { "expose_new": true }
      },
      "exposed_entities": {
        "light.old_light": {
          "assistants": {
            "conversation": { "should_expose": true }
          }
        }
      }
    }
  }
  ```
- **Two-tier storage:**
  - Entities **with `unique_id`** → options stored in the **entity registry** (as `options[assistant_id]`)
  - Entities **without `unique_id`** (legacy) → stored in this file under `exposed_entities`
- **Assistants registered:** Defined in `KNOWN_ASSISTANTS` tuple (`"conversation"`, `"cloud.alexa"`, `"cloud.google_assistant"`)

### 8.3 Entity Registry Options Format

For entities with `unique_id`, exposure data is stored as entity registry options:
```python
entity_registry.async_get(entity_id).options == {
    "cloud.google_assistant": {"should_expose": True},
    "conversation": {"should_expose": False}
}
```

---

## 9. State Reporting (Proactive Push)

`report_state.py` (205 lines) + `http.py:280-291`

**Flow:**
1. On startup: wait 60s (`INITIAL_REPORT_DELAY`), then send initial state for all exposed+supported entities
2. Subscribe to `EVENT_STATE_CHANGED`, filtered to exposed+supported entities
3. Batch states for 1 second (`REPORT_STATE_WINDOW`), then send `POST .../devices:reportStateAndNotification`
4. Uses serialized entity data comparison for "significant change" detection
5. Also sends notification events (e.g., doorbell rings) via `reportStateAndNotification` with `eventId`

**Auth:** JWT Bearer token via service account → HomeGraph API

---

## 10. Trait Mapping

`const.py:142-167` (DOMAIN_TO_GOOGLE_TYPES) and `const.py:169-208` (DEVICE_CLASS_TO_GOOGLE_TYPES)

Trait assignment is dynamic — `supported_traits_for_state()` (`helpers.py:495-515`) iterates all 24 registered traits and calls each `Trait.supported(domain, features, device_class, attributes)`.

Key type mappings:

| HA Domain | Google Type |
|-----------|-------------|
| `light` | `LIGHT` |
| `switch` | `SWITCH` (or `OUTLET`) |
| `climate` | `THERMOSTAT` |
| `cover` | `BLINDS` (overridden by device class: `AWNING`, `CURTAIN`, `DOOR`, `GARAGE`, etc.) |
| `fan` | `FAN` |
| `media_player` | `SETTOP` (overridden: `SPEAKER`, `TV`, `RECEIVER`) |
| `lock` | `LOCK` |
| `alarm_control_panel` | `SECURITYSYSTEM` |
| `vacuum` | `VACUUM` |
| `camera` | `CAMERA` |
| `humidifier` | `HUMIDIFIER` (or `DEHUMIDIFIER`) |
| `water_heater` | `WATERHEATER` |
| `valve` | `VALVE` |
| `lawn_mower` | `MOWER` |
| `binary_sensor.DOOR` | `DOOR` |
| `binary_sensor.SMOKE` | `SMOKE_DETECTOR` |
| `event.DOORBELL` | `DOORBELL` |

### Climate Mode Mappings

`trait.py:1190-1213` (`TemperatureSettingTrait`)

**HVAC mode → Google:**

| HA `HVACMode` | Google |
|---------------|--------|
| `HEAT` | `heat` |
| `COOL` | `cool` |
| `OFF` | `off` |
| `AUTO` | `auto` |
| `HEAT_COOL` | `heatcool` |
| `FAN_ONLY` | `fan-only` |
| `DRY` | `dry` |
| `ECO` (preset) | `eco` |

**HVAC action → Google (`activeThermostatMode`):**

| HA `HVACAction` | Google |
|-----------------|--------|
| `HEATING`, `DEFROSTING`, `PREHEATING` | `heat` |
| `COOLING` | `cool` |
| `DRYING` | `dry` |
| `FAN` | `fan-only` |
| `IDLE` | `none` |

`availableThermostatModes` is dynamically generated from `hvac_modes` + `preset_modes`. If `off` + any heat/cool mode exists, `"on"` is added. All temperatures sent in Celsius.

---

## 11. Secure Devices & 2FA (PIN Challenge)

`trait.py:_verify_pin_challenge()` (line 2523)

**Entities requiring PIN for unlock/open/disarm:**

| Domain | Condition | `might_2fa()` |
|--------|-----------|---------------|
| `lock` | Always | `LockUnlockTrait` → True |
| `alarm_control_panel` | Always | `ArmDisArmTrait` → True |
| `cover` | `DOOR`, `GARAGE`, or `GATE` device class | `OpenCloseTrait.COVER_2FA` |

**PIN challenge flow:**
1. Google sends execute command → `GoogleEntity.execute()` checks `might_2fa(state)`
2. If true and `secure_devices_pin` is not set → `ERR_CHALLENGE_NOT_SETUP` (command denied)
3. If true and no `challenge` in request → `ChallengeNeeded(CHALLENGE_PIN_NEEDED)` → Google prompts "What's your PIN?"
4. If `challenge.pin != secure_devices_pin` → `ChallengeNeeded(CHALLENGE_FAILED_PIN_NEEDED)` → "That PIN was incorrect"
5. If match → command proceeds

**Locking/closing/arming** never requires PIN — only unlocking, opening, and disarming do.

---

## 12. Nabu Casa Cloud Google Assistant Config Management

The Nabu Casa Cloud integration (`cloud`) has a completely separate config management layer from the manual GA integration. It uses `CloudGoogleConfig` instead of `GoogleConfig`, and stores all settings in `.storage/cloud` via `CloudPreferences`.

### 12.1 Architecture

```
nabu casa cloud subscription
  └── cloud component (homeassistant/components/cloud/)
       ├── client.py: CloudClient — bridges HA ↔ hass_nabucasa library
       ├── google_config.py: CloudGoogleConfig — extends AbstractConfig (same base as manual GA)
       ├── prefs.py: CloudPreferences — persistent key-value store
       └── http_api.py: WebSocket/HTTP API for GA config
```

**Key difference:** The Cloud never uses YAML for GA config. Everything is either:
- Stored as UI preferences (`.storage/cloud`)
- Delegated to the shared `exposed_entities` system (`.storage/homeassistant.exposed_entities` + entity registry)

### 12.2 Config Storage: CloudPreferences

`cloud/prefs.py:108-435`

- **File:** `.storage/cloud`
- **Schema version:** 1 (minor version 4)
- **Migration:** `CloudPreferencesStore._async_migrate_func()` (line 61-105) handles schema upgrades

**Full default config** (`_empty_config`, lines 411-434):

```python
{
    "alexa_default_expose":        DEFAULT_EXPOSED_DOMAINS,
    "alexa_entity_configs":        {},
    "alexa_settings_version":      3,
    "cloud_user":                  None,
    "cloudhooks":                  {},
    "enable_alexa":                True,
    "enable_google":               True,
    "enable_remote":               False,
    "cloud_ice_servers_enabled":   True,
    "google_connected":            False,        # Whether Google account linked
    "google_default_expose":       DEFAULT_EXPOSED_DOMAINS,
    "google_entity_configs":       {},           # Legacy per-entity config (pre-migration)
    "google_settings_version":     3,
    "google_local_webhook_id":     "<generated>",
    "instance_id":                 "<uuid4>",
    "google_secure_devices_pin":   None,         # PIN for locks/alarms
    "remote_domain":               None,
    "remote_allow_remote_enable":  True,
    "username":                    ""
}
```

**Google-specific preference keys** (from `cloud/const.py`):

| Key | Purpose |
|-----|---------|
| `PREF_ENABLE_GOOGLE` | Global GA toggle |
| `PREF_GOOGLE_REPORT_STATE` | Proactive state reporting toggle |
| `PREF_GOOGLE_SECURE_DEVICES_PIN` | PIN for 2FA challenge on locks/alarms |
| `PREF_GOOGLE_CONNECTED` | Whether Google has been linked (agent user registered) |
| `PREF_GOOGLE_DEFAULT_EXPOSE` | Domain filter for default exposure (legacy) |
| `PREF_GOOGLE_ENTITY_CONFIGS` | Per-entity overrides (legacy, migrated to entity registry) |
| `PREF_GOOGLE_SETTINGS_VERSION` | Schema migration version |
| `PREF_GOOGLE_LOCAL_WEBHOOK_ID` | Webhook ID for local SDK |
| `PREF_DISABLE_2FA` | Per-entity 2FA disable toggle |
| `PREF_SHOULD_EXPOSE` | Per-entity expose flag (legacy key in `google_entity_configs`) |

### 12.3 Cloud Entity Exposure

`cloud/google_config.py:278-313`

The cloud has a **dual exposure path**:

```
CloudGoogleConfig.should_expose(entity_id):
  ├── IF YAML filter exists (google_user_config["filter"])
  │     → Use entity filter (backwards compat for YAML cloud.google_actions config)
  │
  └── ELSE
        → Delegate to exposed_entities.async_should_expose(hass, CLOUD_GOOGLE, entity_id)
```

Where `CLOUD_GOOGLE = "cloud.google_assistant"` — this is the assistant ID used in the UI exposure system.

On each entity in the entity registry, the cloud stores:
```python
entity_registry.options["cloud.google_assistant"] = {
    "should_expose": True,     # Boolean expose flag
    "disable_2fa": False,      # Optional 2FA disable
}
```

### 12.4 Cloud WebSocket APIs for Google Config

`cloud/http_api.py:974-1085`

The cloud exposes three dedicated WebSocket commands (separate from `homeassistant/expose_entity` commands):

| Command | Params | Description |
|---------|--------|-------------|
| `cloud/google_assistant/entities/get` | `entity_id: str` | Get traits, might_2fa status for a single entity |
| `cloud/google_assistant/entities` | (none) | List all supported entities with traits |
| `cloud/google_assistant/entities/update` | `entity_id: str`, `disable_2fa: bool` | Toggle 2FA disable per entity |

The `entity/get` response:
```json
{
  "entity_id": "light.living_room",
  "traits": ["action.devices.traits.OnOff", "action.devices.traits.Brightness"],
  "might_2fa": false,
  "disable_2fa": null
}
```

Global cloud prefs update WebSocket:
```json
{
  "type": "cloud/update_prefs",
  "google_enabled": true,
  "google_report_state": true,
  "google_secure_devices_pin": "1234"
}
```

### 12.5 Cloud Migration: Legacy Config → Entity Registry Options

`cloud/google_config.py:189-212`

The `_migrate_google_entity_settings_v1()` method moved all per-entity settings from `google_entity_configs` (in cloud prefs) to entity registry options, using the shared `exposed_entities` API:

```
For each entity in (all HA states ∪ google_entity_configs keys):
  1. Compute should_expose using legacy logic
  2. Call async_expose_entity(hass, CLOUD_GOOGLE, entity_id, should_expose)
  3. If entity had disable_2fa set, store it via:
     async_set_assistant_option(hass, CLOUD_GOOGLE, entity_id, PREF_DISABLE_2FA, value)
```

The migration is triggered when `google_settings_version` < current version (checks v1→v2 and v2→v3).

### 12.6 Config Flow

The cloud's `async_setup_entry()` (`cloud/__init__.py:429-442`) sets up binary_sensor, STT, TTS, AI task, and conversation platforms. The Google Assistant integration (`google_assistant` component) gets loaded lazily on first use — triggered either by:
1. A Google Sync request arriving
2. User toggling `google_enabled` in preferences

When loaded, `CloudGoogleConfig.async_initialize()` (`cloud/google_config.py:214-276`) does:
1. Sets up entity/device registry change listeners → auto-sync entities to Google
2. Sets up `exposed_entities` change listener → auto-sync on exposure changes
3. Sets up cloud preferences change listener → enable/disable local SDK + report state dynamically
4. Runs migration if `google_settings_version` is outdated

---

## 13. Config Without Restart — How the Cloud Does It

The Nabu Casa Cloud never requires a HA restart to apply Google Assistant config changes. It achieves this through a three-layer architecture:

### 13.1 Layer 1: Persistent Config Storage

`cloud/prefs.py:108-435`

All config lives in `.storage/cloud` as a single JSON blob. Any UI toggle writes to this store via `prefs.async_update()`:

```
UI toggle → WS: cloud/update_prefs { google_report_state: true }
  → CloudPreferences.async_update(google_report_state=True)
    → persist to .storage/cloud
    → notify all listeners
```

### 13.2 Layer 2: Dynamic Listener System

`cloud/google_config.py:262-276`

`CloudGoogleConfig.async_initialize()` registers reactive listeners:

```python
# 1. Listen for cloud preferences changes
self._prefs.async_listen_updates(self._async_prefs_updated)

# 2. Listen for entity registry changes (area reassignment, name changes)
self.hass.bus.async_listen(
    er.EVENT_ENTITY_REGISTRY_UPDATED,
    self._handle_entity_registry_updated,
)

# 3. Listen for device registry changes (area reassignment)
self.hass.bus.async_listen(
    dr.EVENT_DEVICE_REGISTRY_UPDATED,
    self._handle_device_registry_updated,
)

# 4. Listen for exposed entity changes (exposure toggles in UI)
async_listen_entity_updates(
    self.hass, CLOUD_GOOGLE, self._async_exposed_entities_updated
)
```

### 13.3 Layer 3: Hot Reload Handler

`cloud/google_config.py:402-439`

When any preference changes, `_async_prefs_updated()` runs. It dynamically enables/disables subsystems and triggers syncs:

```python
async def _async_prefs_updated(self, prefs):
    if not self._cloud.is_logged_in:
        if self.is_reporting_state:
            self.async_disable_report_state()
        if self.is_local_sdk_active:
            self.async_disable_local_sdk()
        return

    # Lazy-load the google_assistant component if needed
    if (self.enabled
        and GOOGLE_DOMAIN not in self.hass.config.components
        and self.hass.is_running
    ):
        await async_setup_component(self.hass, GOOGLE_DOMAIN, {})

    sync_entities = False

    # Hot toggle: report state on/off
    if self.should_report_state != self.is_reporting_state:
        if self.should_report_state:
            self.async_enable_report_state()
        else:
            self.async_disable_report_state()
        sync_entities = True

    # Hot toggle: local SDK on/off
    if self.enabled and not self.is_local_sdk_active:
        self.async_enable_local_sdk()
        sync_entities = True
    elif not self.enabled and self.is_local_sdk_active:
        self.async_disable_local_sdk()
        sync_entities = True

    if sync_entities and self.hass.is_running:
        await self.async_sync_entities_all()
```

`async_sync_entities_all()` sends `requestSync` to Google's HomeGraph API, which tells Google to re-request SYNC. All entity info updates without restart.

### 13.4 Registry Change → Auto-Sync

When entity/device registry changes (e.g., area renamed, entity moved), listeners schedule a debounced sync:

```python
def _handle_entity_registry_updated(self, event):
    if not self.enabled or self.hass.state is not CoreState.running:
        return
    # Only sync if describing attributes changed (name, area, device_class, etc.)
    if event.data["action"] == "update" and not bool(
        set(event.data["changes"]) & er.ENTITY_DESCRIBING_ATTRIBUTES
    ):
        return
    if not self.should_expose(entity_id):
        return
    self.async_schedule_google_sync_all()   # 15-second debounce

def _handle_device_registry_updated(self, event):
    if (event.data["action"] != "update"
        or "area_id" not in event.data["changes"]
    ):
        return
    for entity_entry in er.async_entries_for_device(
        er.async_get(self.hass), event.data["device_id"]
    ):
        if entity_entry.area_id is None and self.should_expose(entity_entry.entity_id):
            self.async_schedule_google_sync_all()
            break
```

### 13.5 Exposed Entities Change → Auto-Sync

```python
def _async_exposed_entities_updated(self):
    self.async_schedule_google_sync_all()
```

### 13.6 Preferences Update Flow

```
Frontend → WS: cloud/update_prefs { google_enabled: true, google_report_state: true }
  → prefs.async_update(google_enabled=True, google_report_state=True)
    → CloudPreferences._save_prefs(prefs)
      → Notifies all listeners (including CloudGoogleConfig._async_prefs_updated)
        → Enables/disables report state and local SDK as needed
        → Triggers async_sync_entities_all() if changed
```

---

## 14. Manual GA vs. Cloud GA — Side-by-Side

| Aspect | Manual GA (`google_assistant`) | Cloud GA (`cloud`) |
|--------|-------------------------------|-------------------|
| **Config base class** | `GoogleConfig(AbstractConfig)` | `CloudGoogleConfig(AbstractConfig)` |
| **YAML required?** | Yes (`google_assistant:` section) | No (all in `.storage/cloud`) |
| **Entity exposure decision** | YAML `expose_by_default` + `exposed_domains` + `entity_config.expose` | `exposed_entities.async_should_expose()` with `CLOUD_GOOGLE` assistant ID |
| **Per-entity name override** | YAML `entity_config.name:` | Not available (never migrated) |
| **Per-entity aliases** | YAML `entity_config.aliases:` | Not available |
| **Per-entity room hint** | YAML `entity_config.room:` | Not available (uses HA area only) |
| **Secure devices PIN** | YAML `secure_devices_pin` | Cloud prefs `google_secure_devices_pin` (settable via `cloud/update_prefs`) |
| **2FA control** | Per entity via `should_2fa()` | Per entity via `disable_2fa` in entity options + `DEFAULT_DISABLE_2FA=False` |
| **Agent user tracking** | `GoogleConfigStore` (`.storage/google_assistant`) | Cloud prefs `google_connected` boolean |
| **Report state** | Direct HomeGraph API JWT auth | Via `hass_nabucasa.google_report_state` |
| **Local SDK** | Webhooks per agent user | Single webhook (`google_local_webhook_id`) |
| **Sync trigger** | `async_sync_entities_all()` via HomeGraph `requestSync` | Via `hass_nabucasa` cloud IOT |
| **Config migration** | None | `google_settings_version` transitions (v1→v2→v3) |
| **Entity registry integration** | Creates device entry for `project_id` | No direct device entry |
| **Dependencies** | Service account private key | Nabu Casa subscription + `hass_nabucasa` library |
| **Restart for config?** | Yes (YAML changes) | No (hot reload via listeners) |

---

## 15. Key Files Reference

### Manual GA Integration (`google_assistant/`)

| File | Lines | Purpose |
|------|-------|---------|
| `const.py` | 238 | All constants, type mappings, config keys |
| `__init__.py` | 174 | Integration entry, YAML schema, service registration |
| `helpers.py` | 819 | Entity fetching, serialization, trait resolution, sync scheduling |
| `http.py` | 404 | Manual GA `GoogleConfig`, JWT auth, HomeGraph API, agent user store |
| `smart_home.py` | 379 | Smart Home intent handlers (SYNC/QUERY/EXECUTE/DISCONNECT) |
| `trait.py` | 2918 | 24 trait implementations |
| `report_state.py` | 205 | Proactive state reporting engine |
| `config_flow.py` | 21 | Minimal config entry import from YAML |

### Nabu Casa Cloud Integration (`cloud/`)

| File | Lines | Purpose |
|------|-------|---------|
| `google_config.py` | 496 | Cloud GA `CloudGoogleConfig`, exposure delegation, migration, registry listeners |
| `prefs.py` | 435 | `CloudPreferences` storage (`.storage/cloud`), all GA settings |
| `client.py` | 437 | `CloudClient` bridges HA to `hass_nabucasa`; lazy-initializes GA config |
| `http_api.py` | 1223 | Cloud WebSocket API (GA entity list/get/update, prefs update) |
| `const.py` | 96 | Cloud-specific preference keys, defaults |
| `__init__.py` | 482 | Cloud entry point, Google Actions YAML schema (`GACTIONS_SCHEMA`) |

### Shared System

| File | Lines | Purpose |
|------|-------|---------|
| `exposed_entities.py` | 530 | UI-based exposure management, used by both manual and cloud GA |

---

## 16. Current State of `hass_ga_manual_ui`

`const.py` + `__init__.py` + `frontend.py` + `frontend.js`

**Architecture:** Two-layer monkey-patching. No config entries, no entities, no services, no storage — fully stateless.

### What Currently Works

| Feature | Status |
|---------|--------|
| Entity expose toggle per assistant | Works via `exposed_entities` UI |
| Expose new entities toggle | Works via card toggle → `expose_new_entities/set` |
| Per-entity exposure list | Works via `expose_entity/list` |
| Frontend card injection | Works (settings card in voice assistants UI) |
| Runtime patching of `KNOWN_ASSISTANTS` | Works via `__init__.py` |
| WS schema patching | Works via `_walk()` recursive schema patcher |

### What It Gets For Free (No Extra Code Required)

Because `sync_serialize()` in `helpers.py` is the shared serializer used by all `AbstractConfig` subclasses:

| Data Sent to Google | Source in HA | Resolved In |
|---------------------|--------------|-------------|
| `roomHint` | Entity's HA area name (fallback: device's area name, then none) | `helpers.py:646-649` via `_get_registry_entries()` |
| `name.name` | Entity friendly name (from state) | `helpers.py:619-623` via `intent.async_get_entity_aliases()` |
| `name.nicknames` | Intent aliases (e.g., "living room", "main light") | `helpers.py:619-626` via `intent.async_get_entity_aliases()` |
| `deviceInfo` | Device registry (manufacturer, model, sw_version) | `helpers.py:670-681` |
| Matter info | Matter integration device data | `helpers.py:654-668` |
| Traits | All 24 traits auto-resolved from domain/features/device_class | `helpers.py:495-515` |
| Google type | Domain + device class mapping | `helpers.py:488-492` |
| `willReportState` | From `AbstractConfig.should_report_state` | `helpers.py` |

Since the Cloud manages with zero per-entity config (no YAML `entity_config`), the HA built-in data (area names, friendly names, intent aliases) is sufficient for all room/name/alias needs.

### Persistence Model

All state lives in HA's core `exposed_entities` system:
- `.storage/homeassistant.exposed_entities` — assistant exposure preferences
- Entity registry `options[assistant_id]` — per-entity exposure flags

No separate config store exists. No config entry exists. The integration is stateless beyond the runtime monkey-patches.

---

## 17. Official Documentation Caveats

### Service `google_assistant.request_sync`

`services.yaml` + `__init__.py:152-170`

Sends `POST .../devices:requestSync` with JWT. `agent_user_id` defaults to `call.context.user_id`. Only available when service account is configured.

### `requestSync` & Device Sync

Google can also initiate SYNC: "OK Google, sync my devices" → `smart_home.py:async_devices_sync()` → returns full device list.

### TV Channels

Channel numbers only, no names. `ChannelTrait` calls `media_player.play_media` with `media_content_type: "channel"`.

### Prerequisites (Manual Setup)

- HA must be externally accessible with hostname + SSL
- NGINX `proxy_pass` must not have trailing `/`
- Google Home Developer Console: project, HomeGraph API, service account JSON key
- Cloud fulfillment URL: `https://[domain]/api/google_assistant`
- OAuth redirect: `https://oauth-redirect.googleusercontent.com/r/[PROJECT_ID]`
