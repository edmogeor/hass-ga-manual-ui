# Setup-phase re-trigger for core GA

We chose to activate core GA via a setup-phase re-trigger — populating
`hass.data["google_assistant"]` with configuration from our ConfigEntry,
constructing a `ConfigEntry` for the `google_assistant` domain, and directly
calling its `async_setup_entry()` — rather than reversing the integration
load order.

**Why the load order problem exists:** Core GA's `async_setup(hass, yaml_config)`
runs before our integration's `async_setup()`. By the time our monkey-patches
could inject dependencies into core GA's manifest, HA's loader has already
completed the dependency graph build. Reversing the load order would require
monkey-patching `builtins.open()` or `json.load()` to intercept manifest reads
during bootstrap — fragile and invasive.

**Why the re-trigger works:** Core GA's `async_setup()` returns `True` immediately
when no `google_assistant:` config exists in `configuration.yaml` (line 102:
`if DOMAIN not in yaml_config: return True`). It's a harmless no-op. After our
integration sets up and the user provides configuration, we can:

1. Populate `hass.data["google_assistant"]["data_config"]` with the config dict
2. Construct a ConfigEntry for domain `google_assistant`  
3. Call core GA's `async_setup_entry(hass, entry)` directly
4. Core GA sets up `GoogleConfig`, registers webhook, enables report state —
   exactly as if YAML config had existed

**Alternatives considered:** Reversing load order via `open()`/`json.load()`
monkey-patching was rejected as too fragile and dependent on HA's internal
bootstrap behavior.
