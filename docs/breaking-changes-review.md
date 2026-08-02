# Breaking-Changes Review: Latest Home Assistant Frontend Reorganisation

**Date:** 2026-08-02
**Review scope:** HA frontend UI for cloud & voice assistants, plus core `google_assistant` component internals.
**References:** `/home/george/Desktop/references/` (frontend + core snapshots).

---

## 1. The Cloud Page Reorganisation

### What changed

The Cloud settings page (`/config/cloud`) has been reworked into a flat overview with links out to sub-pages. Google Assistant and Alexa settings are **no longer rendered inline** on the Cloud page.

The Cloud page structure (`ha-config-cloud.ts`):

| Sub-route | Renders | Purpose |
|---|---|---|
| `account` | `cloud-account` | Overview hub with feature rows |
| `remote` | `cloud-remote-pref` | Remote access toggle |
| `backup` | `cloud-backup-pref` | Cloud backup settings |
| **`voice-assistants`** | **`cloud-tts-pref`** | **TTS voice/language selection (not GA settings!)** |
| `companion` | `cloud-companion-pref` | Companion app prefs |
| `webrtc` | `cloud-ice-servers-pref` | WebRTC ICE servers |
| `webhooks` | `cloud-webhooks` | Cloud webhook management |

The overview page (`cloud-account-overview.ts`) includes a feature row for Alexa & Google Assistant that links **out** to the Voice Assistants page:

```
/config/voice-assistants/assistants?historyBack=1
```

This is a **cross-page link**, not inline settings.

### What did NOT change

The Voice Assistants page (`/config/voice-assistants`) remains the canonical home for all voice assistant settings. It still renders:

- `<assist-pref>` (built-in Assist)
- `<assist-current-device-pref>` (browser device)
- `<cloud-alexa-pref>` (Alexa card, when cloud is logged in)
- `<cloud-google-pref>` (Google Assistant card, when cloud is logged in)
- `<cloud-discover>` (cloud upsell card, when cloud is NOT logged in)

All of these live inside `<div class="content">` of `ha-config-voice-assistants-assistants`.

---

## 2. Breaking-Change Impact Assessment

### Integration patch points: verdict

| Patch | Target | Status | Notes |
|---|---|---|---|
| `KNOWN_ASSISTANTS` tuple | `exposed_entities.py:22` | **No change** | Still `("cloud.alexa", "cloud.google_assistant", "conversation")` |
| WS schema walker (`vol.In`) | `exposed_entities.py:390,442,462` | **No change** | Still uses `vol.In(KNOWN_ASSISTANTS)` in all three commands |
| `voiceAssistants` object | `data/expose.ts:5` | **No change** | Same three entries, same shape |
| `Object.keys()` interceptor | N/A | **No change** | Still iterated in `entity-voice-settings.ts` line 129 and `expose.ts` line 63 |
| `assistantsOrdered` sort array | `assistants-table-column.ts:84` | **No change** | Still `["conversation", "cloud.alexa", "cloud.google_assistant"]` |
| `Array.forEach` sort injection | N/A | **No change** | Same array content |
| `_availableAssistants` getter | `ha-config-voice-assistants-expose.ts:142` | **No change** | Still delegates to `getAvailableAssistants()` |
| `getAvailableAssistants()` | `available-assistants.ts:6` | **No change** | Same logic (conversation always, cloud assistants when logged_in + enabled) |
| `ha-config-voice-assistants-assistants` structure | `ha-config-voice-assistants-assistants.ts` | **No change** | Still has `.content` div, still renders cloud cards inside it |
| `customElements.define` interceptor | N/A | **No change** | Same custom element tags |
| `cloud-google-pref` card DOM | `cloud-google-pref.ts` | **No change** | Same `<ha-card outlined>` structure, same toggle/switches/PIN input |
| `entity-voice-settings` 2FA checkbox | `entity-voice-settings.ts:220-268` | **No change** | Still checks `cloud.google_assistant`, still uses `_googleEntity?.might_2fa` |
| `voice-assistant-brand-icon` | `voice-assistant-brand-icon.ts` | **No change** | Same `render()` path, same `voiceAssistants` lookup |
| `GoogleConfig.should_expose` | `http.py:170` | **No change** | Still legacy YAML-based (domain filter + entity_config), no exposed_entities integration |
| `GoogleConfig.should_2fa` | `http.py:203` | **No change** | Still hardcoded `True` |
| `GoogleConfig.should_report_state` | `http.py:122` | **No change** | Same property |
| `GoogleConfig.secure_devices_pin` | `http.py:116` | **No change** | Same property |
| `AbstractConfig.async_enable/disable_report_state` | `helpers.py:209-223` | **No change** | Same methods |
| `AbstractConfig.async_schedule_google_sync_all` | `helpers.py:289-293` | **No change** | Same method |
| `GOOGLE_ASSISTANT_SCHEMA` | `__init__.py:65-87` | **No change** | Same schema (our export/import relies on it) |
| `GoogleAssistantView` | `http.py:376-398` | **No change** | Same HTTP view registration |

### Non-breaking changes in core GA that are notable

1.  **`AbstractConfig._on_deinitialize`** (`helpers.py:103,114,117-121`): New list of cleanup callbacks tracked in the abstract config. `async_initialize()` appends the `async_at_started` sync listener to it. A new `async_deinitialize()` pops and calls all listeners. This does **not** affect our soft-disable approach (we never call `async_deinitialize`), and core GA still has no `async_unload_entry`.

2.  **`GoogleConfigEntry` type alias** (`__init__.py:93`): New `type GoogleConfigEntry = ConfigEntry[GoogleConfig]` typing alias. Purely cosmetic; does not change runtime behaviour.

3.  **`AbstractConfig.is_reporting_state`** (`helpers.py:138-141`): New property that checks `_unsub_report_state is not None`. Informational only.

### Verdict: zero breaking changes

All patching targets (Python tuples, WS schemas, custom element prototypes, DOM insertion points, JS module exports) are **identical** to the versions our integration was built against. The cloud page reorganisation moves settings *away* from the cloud page *toward* the voice assistants page, which is already where our card injects.

---

## 3. Answer to the specific questions

**Q: Has the voice assistant management UI changed?**

The structural DOM of `ha-config-voice-assistants-assistants` and its children (`cloud-google-pref`, `cloud-alexa-pref`, `assist-pref`, `entity-voice-settings`) is unchanged. Cards, toggles, WS calls, and data flows are identical. The only meaningful UI change is in the **Cloud section**: the cloud account overview now links to `/config/voice-assistants/assistants` for GA/Alexa settings rather than rendering them inline.

**Q: Does the cloud page just link through to the voice assistants page?**

Yes. The new cloud account overview page (`cloud-account-overview.ts`) has a feature row labeled "Alexa & Google Assistant" that links to `/config/voice-assistants/assistants?historyBack=1`. The cloud page no longer renders `cloud-google-pref` or `cloud-alexa-pref` inline. The `voice-assistants` sub-route within the cloud page goes to `cloud-tts-pref` (text-to-speech voice/language settings), not GA settings.

---

## 4. Impact on user experience

This reorganisation is a **net positive** for our integration:

- The voice assistants page (`/config/voice-assistants/assistants`) is now the **undisputed single home** for all voice assistant settings. Our card sits naturally alongside the cloud Google and Alexa cards.
- The cloud page acts as a discovery hub that funnels users to the voice assistants page.
- Users who manage manual Google Assistant alongside cloud-based assistants see everything in one place.

---

## 5. Action required

**None.** No code changes are needed. All patching strategies remain valid. The card injection point (`div.content` in `ha-config-voice-assistants-assistants`) is unchanged. All WebSocket commands, entity exposure paths, and DOM structures we depend on are identical.
