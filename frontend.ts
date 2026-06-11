/**
 * Google Assistant (Manual) — Frontend companion module.
 * Patches the HA frontend at runtime so the integration appears in the
 * voice assistants UI alongside the built-in cloud assistants.
 */

// ---------------------------------------------------------------------------
// Home Assistant frontend type declarations
// ---------------------------------------------------------------------------

interface HomeAssistant {
  callService(
    domain: string,
    service: string,
    data?: Record<string, unknown>,
  ): void;
  callWS<T = unknown>(msg: Record<string, unknown>): Promise<T>;
  localize(key: string, args?: Record<string, number | string>): string;
  states?: Record<string, unknown>;
  themes?: { darkMode?: boolean };
  language?: string;
  locale?: { language?: string };
}

interface LitLifecycle {
  connectedCallback?(): void;
  firstUpdated?(changedProps: Map<string, unknown>): void;
  updated?(changedProps: Map<string, unknown>): void;
  render?(): unknown;
  requestUpdate?(): void;
}

interface AssistantsPageElement extends HTMLElement, LitLifecycle {
  hass?: HomeAssistant;
  _fetchEntities?(): void;
}

interface VoiceAssistantBrandIcon extends HTMLElement, LitLifecycle {
  voiceAssistantId: string;
  hass?: HomeAssistant;
}

interface ExposeAssistantIcon extends HTMLElement, LitLifecycle {
  assistant: string;
  hass?: HomeAssistant;
  unsupported?: boolean;
  manual?: boolean;
}

interface TogglableElement extends HTMLElement {
  checked: boolean;
  disabled: boolean;
  value: string;
  placeholder: string;
}

interface GaEntityInfo {
  entity_id: string;
  might_2fa: boolean;
  disable_2fa?: boolean;
}

interface EntityVoiceSettingsElement extends HTMLElement, LitLifecycle {
  hass?: HomeAssistant;
  entityId?: string;
  __gaEntityId?: string;
  __gaInfo?: GaEntityInfo | null;
}

interface WSError extends Error {
  error?: string;
  code?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ASSISTANT_ID = "hass_ga_manual_ui";
const ASSISTANT_NAME = "Google Assistant (Manual)";
const SORT_TARGET = ["conversation", "cloud.alexa", "cloud.google_assistant"];

// Use Core's official Google Assistant brand icon from the HA brands CDN so our
// card matches the rest of HA (and tracks any future logo refresh). We hit the
// public CDN directly — the same URL HA's own brandsUrl() builds — rather than
// the instance's tokenized /api/brands/...?token= proxy URL, whose signed token
// is short-lived and can't be hardcoded.
const BRANDS_CDN = "https://brands.home-assistant.io";
const BRAND_DOMAIN = "google_assistant";

const WS_GET_ENTRY_ID = `${ASSISTANT_ID}/get_entry_id`;
const WS_GET_CONFIG = `${ASSISTANT_ID}/get_config`;
const WS_UPDATE_CONFIG = `${ASSISTANT_ID}/update_config`;
const WS_ENABLE = `${ASSISTANT_ID}/enable`;
const WS_DISABLE = `${ASSISTANT_ID}/disable`;
const WS_GET_ENTITY = `${ASSISTANT_ID}/get_entity`;
const WS_UPDATE_ENTITY = `${ASSISTANT_ID}/update_entity`;

// ---------------------------------------------------------------------------
// Localization (see AGENTS.md "Frontend localization")
// ---------------------------------------------------------------------------
// Card strings live in translations/<lang>.json under "frontend" and are fetched
// for the user's language at runtime; EN_STRINGS is the synchronous fallback.

interface LocaleTable {
  yaml_detected: string;
  enable_success: string;
  enable_failed: string;
  enable_fail_hint: string;
  disable_success: string;
  disable_failed: string;
  disable_fail_hint: string;
  check_logs: string;
  report_state_enable_failed: string;
  report_state_disable_failed: string;
  ready_banner: string;
}

const EN_STRINGS: LocaleTable = {
  yaml_detected:
    "The <code>google_assistant:</code> section was detected in your " +
    "<code>configuration.yaml</code> and has been disabled. " +
    "This integration now manages your Google Assistant configuration. " +
    "You can safely remove the <code>google_assistant:</code> section " +
    "from your YAML configuration.",
  enable_success: "Google Assistant enabled successfully",
  enable_failed: "Failed to enable Google Assistant.",
  enable_fail_hint: "Try reloading the integration from Settings → Devices & Services.",
  disable_success: "Google Assistant disabled successfully",
  disable_failed: "Failed to disable Google Assistant.",
  disable_fail_hint: "Try removing the integration from Settings → Devices & Services.",
  check_logs: "Check Home Assistant logs for details.",
  report_state_enable_failed:
    "Failed to enable state reporting. " +
    "Try toggling the integration off and on, or check Home Assistant logs.",
  report_state_disable_failed:
    "Failed to disable state reporting. " +
    "Try toggling the integration off and on, or check Home Assistant logs.",
  ready_banner: "{name} is ready — manage it under Settings → Voice assistants.",
};

type StringKey = keyof LocaleTable;

let _loadedStrings: Partial<LocaleTable> = {};
let _translationsPromise: Promise<void> | null = null;
// Re-apply build-time text (e.g. the YAML alert) once runtime strings arrive.
const _retranslate: Array<() => void> = [];

// Resolve a string (loaded language, else English), replacing {placeholders}.
function t(key: StringKey, args?: Record<string, string | number>): string {
  let str = _loadedStrings[key] ?? EN_STRINGS[key];
  if (args) {
    for (const name of Object.keys(args)) {
      str = str.split("{" + name + "}").join(String(args[name]));
    }
  }
  return str;
}

// Fetch the "frontend" strings once (memoized on the first attempt with hass);
// fails silently to EN_STRINGS.
function ensureTranslationsLoaded(): Promise<void> {
  if (_translationsPromise) return _translationsPromise;
  const hass = getHass();
  if (!hass?.callWS) return Promise.resolve();

  const language = hass.locale?.language || hass.language || "en";
  const prefix = `component.${ASSISTANT_ID}.frontend.`;
  _translationsPromise = hass
    .callWS<{ resources: Record<string, string> }>({
      type: "frontend/get_translations",
      language,
      category: "frontend",
      integration: ASSISTANT_ID,
    })
    .then(({ resources }) => {
      const loaded: Partial<LocaleTable> = {};
      for (const key of Object.keys(EN_STRINGS) as StringKey[]) {
        const val = resources?.[prefix + key];
        if (typeof val === "string") loaded[key] = val;
      }
      _loadedStrings = loaded;
      for (const fn of _retranslate) {
        try {
          fn();
        } catch (e) {
          _debug("retranslate callback failed: " + _errorMessage(e));
        }
      }
    })
    .catch((e: unknown) => {
      _debug("Failed to load frontend translations: " + _errorMessage(e));
    });
  return _translationsPromise;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/** Best-effort human-readable message from a websocket error response. */
function _wsErrorMessage(err: unknown): string {
  const wsErr = err as WSError;
  return wsErr.message || wsErr.error || wsErr.code || String(err);
}

let _entryId: string | null = null;
let _entryIdPromise: Promise<string> | null = null;
let _gaManualEnabled = true;
// Captured reference to HA's voiceAssistants map (from data/expose.ts) the first
// time our Object.keys interceptor sees it. Needed so we can resolve our
// assistant's display name — dialogs do voiceAssistants[id].name directly.
let _voiceAssistantsMap: Record<string, unknown> | null = null;

// ---------------------------------------------------------------------------
// Logging helpers
//
// Three tiers:
//   - _banner(): always shown (console) + a one-time line in the HA logs, so
//     the user can confirm the companion loaded without opening dev tools.
//   - _warn()/_error(): always shown in the console AND forwarded to the HA
//     logs (so problems are visible without dev tools).
//   - _debug()/_info(): verbose; only shown when the debug flag is set.
//
// Enable verbose logging with:  localStorage.setItem("gaManualDebug", "1")
// (or add ?gaManualDebug to the URL), then reload.
// ---------------------------------------------------------------------------

let _DEBUG = false;
try {
  _DEBUG =
    (typeof localStorage !== "undefined" &&
      !!localStorage.getItem("gaManualDebug")) ||
    (typeof location !== "undefined" &&
      /[?&#]gaManualDebug\b/.test(location.search + location.hash));
} catch {
  /* localStorage / location may be unavailable */
}

function _forwardToHaLog(level: "info" | "warn" | "error", message: string): void {
  try {
    const hass = getHass();
    if (!hass || !hass.callService) return;
    // The `logger` already namespaces this in the HA logs, so no message prefix.
    hass.callService("system_log", "write", {
      message,
      level: level === "warn" ? "warning" : level,
      logger: "hass_ga_manual_ui.frontend",
    });
  } catch {
    /* never let logging throw or recurse */
  }
}

function _log(level: "debug" | "info" | "warn" | "error", message: string, data?: unknown): void {
  const isProblem = level === "warn" || level === "error";
  if (_DEBUG || isProblem) {
    const prefixed = "[GA Manual] " + message;
    try {
      if (data !== undefined) {
        console[level](prefixed, data);
      } else {
        console[level](prefixed);
      }
    } catch {
      /* console might be unavailable */
    }
  }
  if (isProblem) _forwardToHaLog(level, message);
}

function _debug(msg: string, data?: unknown): void { _log("debug", msg, data); }
function _info(msg: string, data?: unknown): void { _log("info", msg, data); }
function _warn(msg: string, data?: unknown): void { _log("warn", msg, data); }
function _error(msg: string, data?: unknown): void { _log("error", msg, data); }

// Always-visible load banner: console + a single info line in the HA logs.
let _bannerForwarded = false;
function _banner(message: string): void {
  try {
    // No "[GA Manual]" prefix — this is the user-facing message.
    console.info(message);
  } catch {
    /* console might be unavailable */
  }
  if (!_bannerForwarded) {
    _bannerForwarded = true;
    _forwardToHaLog("info", message);
  }
}

// ---------------------------------------------------------------------------
// User-facing toast notifications (HA-style)
// ---------------------------------------------------------------------------

function _showToast(message: string, isError: boolean): void {
  try {
    const hass = getHass();
    if (!hass || !hass.callService) return;
    hass.callService("persistent_notification", "create", {
      title: ASSISTANT_NAME + (isError ? " — Error" : " — Notice"),
      message,
      notification_id: "hass_ga_manual_ui_notification",
    });
  } catch (e) {
    _error("Failed to show toast: " + _errorMessage(e));
  }
}

// ---------------------------------------------------------------------------
// Entry ID resolution
// ---------------------------------------------------------------------------

/** True when HA is in dark mode, so we can pick the dark brand variant. */
function _isDarkMode(): boolean {
  try {
    const dm = getHass()?.themes?.darkMode;
    if (typeof dm === "boolean") return dm;
  } catch {
    /* hass/themes may be unavailable */
  }
  try {
    return (
      typeof matchMedia !== "undefined" &&
      matchMedia("(prefers-color-scheme: dark)").matches
    );
  } catch {
    return false;
  }
}

/** Core's Google Assistant brand icon from the HA brands CDN (theme-aware). */
function getBrandIconUrl(): string {
  const variant = _isDarkMode() ? "dark_icon" : "icon";
  return `${BRANDS_CDN}/${BRAND_DOMAIN}/${variant}.png`;
}

function getHass(): HomeAssistant | undefined {
  const homeAssistant = document.querySelector("home-assistant") as
    (HTMLElement & { hass?: HomeAssistant }) | null;
  return homeAssistant?.hass;
}

function getEntryId(): Promise<string> {
  if (_entryId) return Promise.resolve(_entryId);
  if (_entryIdPromise) return _entryIdPromise;
  _entryIdPromise = _fetchEntryId().then(
    (id) => {
      _entryId = id;
      _entryIdPromise = null;
      _debug("Resolved entry_id=" + id);
      return id;
    },
    (err: unknown) => {
      _entryIdPromise = null;
      throw err;
    },
  );
  return _entryIdPromise;
}

/**
 * Ensure the captured voiceAssistants map contains our assistant entry.
 * Returns true if the map is known and now contains our entry — i.e. it is
 * safe to advertise ASSISTANT_ID in assistant lists without dialogs throwing
 * on voiceAssistants[ASSISTANT_ID].name.
 */
function _ensureVoiceAssistantEntry(): boolean {
  if (!_voiceAssistantsMap) return false;
  if (!(ASSISTANT_ID in _voiceAssistantsMap)) {
    _voiceAssistantsMap[ASSISTANT_ID] = {
      domain: "google_assistant",
      name: ASSISTANT_NAME,
    };
  }
  return true;
}

let _primeStarted = false;

/**
 * Force the voiceAssistants map to be captured.
 *
 * Capture is otherwise passive — it only happens when HA calls
 * Object.keys(voiceAssistants) (e.g. opening an entity's voice settings). The
 * expose page never does, so on a fresh visit the map stays null, our assistant
 * is gated out of _availableAssistants, and the table shows "no data" until
 * something incidental triggers the capture.
 *
 * We trip it deterministically by constructing a throwaway
 * ha-filter-voice-assistants and calling its firstUpdated(), whose body runs
 * Object.keys(voiceAssistants). requestUpdate is stubbed first so the element
 * never renders — no DOM insertion, no localize context, no side effects. On
 * success the captured map is injected (via the interceptor) and the expose
 * page is refreshed so its getter now advertises us.
 */
function _primeVoiceAssistantsMap(): void {
  if (_voiceAssistantsMap) return;
  const PROBE = "ha-filter-voice-assistants";
  const cls = customElements.get(PROBE);
  if (!cls) {
    // Not loaded yet — retry once it is (e.g. when the filter pane first opens).
    if (!_primeStarted) {
      _primeStarted = true;
      customElements
        .whenDefined(PROBE)
        .then(() => _primeVoiceAssistantsMap())
        .catch(() => undefined);
    }
    return;
  }
  try {
    const probe = new cls() as {
      requestUpdate?: () => void;
      firstUpdated?: (changed: Map<PropertyKey, unknown>) => void;
    };
    probe.requestUpdate = () => undefined;
    probe.firstUpdated?.(new Map());
    if (_voiceAssistantsMap) {
      _info("Primed voiceAssistants map proactively (expose page)");
      _refreshExposePage();
    }
  } catch (e) {
    _debug("Could not prime voiceAssistants map: " + _errorMessage(e));
  }
}

/** Forget the cached entry_id so the next getEntryId() re-resolves it. */
function _invalidateEntryId(): void {
  _entryId = null;
  _entryIdPromise = null;
}

/**
 * Run a WS call against the resolved entry_id; if it fails because the entry no
 * longer exists (e.g. the integration was deleted and re-added), drop the
 * cached id, re-resolve, and retry once.
 */
async function _withEntryRetry<T>(fn: (entryId: string) => Promise<T>): Promise<T> {
  try {
    return await fn(await getEntryId());
  } catch (err: unknown) {
    if (!_isEntryGoneError(err)) throw err;
    _warn("Cached entry_id was stale; re-resolving and retrying");
    _invalidateEntryId();
    return await fn(await getEntryId());
  }
}

/**
 * True when a WS error indicates the entry_id no longer exists — e.g. after the
 * integration was deleted and re-added (which assigns a new entry_id) while a
 * stale id was cached.
 */
function _isEntryGoneError(err: unknown): boolean {
  const wsErr = err as WSError;
  if (wsErr && wsErr.code === "not_found") return true;
  const msg = ((wsErr && wsErr.message) || "").toLowerCase();
  return msg.includes("config entry not found") || msg.includes("not_found");
}

async function _fetchEntryId(): Promise<string> {
  const hass = getHass();
  if (!hass) {
    const err = new Error(
      "Home Assistant not yet loaded. The Google Assistant (Manual) card " +
        "will retry when the page finishes loading.",
    );
    _warn(err.message);
    throw err;
  }

  _debug("Fetching entry_id via WS");
  try {
    const result = await hass.callWS<{ entry_id?: string }>({
      type: WS_GET_ENTRY_ID,
    });
    if (!result || !result.entry_id) {
      throw new Error(
        "Server returned no entry_id. The integration must be added via " +
          "Settings → Devices & Services → Add Integration first.",
      );
    }
    return result.entry_id;
  } catch (err: unknown) {
    _error(
      "Failed to get entry_id from server: " +
        _wsErrorMessage(err) +
        ". " +
        "Add the integration via Settings → Devices & Services → " +
        "Add Integration → Google Assistant (Manual).",
    );
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 1. Inject our key into voiceAssistants (from data/expose.ts)
// ---------------------------------------------------------------------------

function patchVoiceAssistants(): void {
  try {
    const origKeys = Object.keys;

    Object.keys = function (obj: object): string[] {
      try {
        if (
          obj &&
          typeof obj === "object" &&
          !Array.isArray(obj) &&
          "conversation" in obj &&
          "cloud.alexa" in obj &&
          "cloud.google_assistant" in obj
        ) {
          const record = obj as Record<string, unknown>;
          // The voiceAssistants map (data/expose.ts) and per-entity expose
          // settings share the same three keys, but the map's values are
          // { domain, name } descriptors whereas expose settings map to
          // booleans. Only capture/inject the former — matching expose settings
          // would pollute them and break the self-uninstall below.
          const conv = record.conversation;
          if (conv && typeof conv === "object" && "domain" in conv) {
            // Capture the map so we can resolve our assistant name elsewhere.
            _voiceAssistantsMap = record;
            if (!(ASSISTANT_ID in record)) {
              record[ASSISTANT_ID] = { domain: "google_assistant", name: ASSISTANT_NAME };
              _info("Injected " + ASSISTANT_ID + " into voiceAssistants map");
            }
            // voiceAssistants is a module-level constant in HA — once our key is
            // in it, it persists for the session. Restore the native Object.keys
            // so we stop wrapping this very hot global on every future call.
            Object.keys = origKeys;
            _debug("Uninstalled Object.keys interceptor (voiceAssistants captured)");
          }
        }
      } catch (e) {
        _error("Error in Object.keys interceptor: " + _errorMessage(e));
      }
      return origKeys(obj);
    };
    _debug("Patch 1/4 applied: voiceAssistants (Object.keys)");
  } catch (e) {
    _error("Failed to apply patch 1/4 (voiceAssistants): " + _errorMessage(e));
  }
}

// ---------------------------------------------------------------------------
// 2. Intercept Array.prototype.forEach to fix the sort key
// ---------------------------------------------------------------------------

function patchSortKey(): void {
  try {
    const origForEach = Array.prototype.forEach;

    Array.prototype.forEach = function (callback: (value: string, index: number, array: string[]) => void, thisArg?: unknown): void {
      try {
        if (
          this.length === SORT_TARGET.length &&
          SORT_TARGET.every((v, i) => this[i] === v) &&
          !this.includes(ASSISTANT_ID)
        ) {
          this.push(ASSISTANT_ID);
          _info("Injected " + ASSISTANT_ID + " into sort-order array");
        }
      } catch (e) {
        _error("Error in Array.forEach interceptor: " + _errorMessage(e));
      }
      return origForEach.call(this, callback, thisArg);
    };
    _debug("Patch 2/4 applied: sort key (Array.forEach)");
  } catch (e) {
    _error("Failed to apply patch 2/4 (sort key): " + _errorMessage(e));
  }
}

// ---------------------------------------------------------------------------
// 3. Wrap _availableAssistants getter on the expose page
// ---------------------------------------------------------------------------

function findExposeElement(root: Node | null): AssistantsPageElement | null {
  if (!root) return null;
  if (root.nodeType !== 1 && root.nodeType !== 11) return null;
  if (root instanceof HTMLElement && root.nodeName === "HA-CONFIG-VOICE-ASSISTANTS-EXPOSE") {
    return root as unknown as AssistantsPageElement;
  }
  const shadowRoot = (root as HTMLElement).shadowRoot;
  if (shadowRoot) {
    const found = findExposeElement(shadowRoot);
    if (found) return found;
  }
  const children = (root as HTMLElement).children || [];
  for (let i = 0; i < children.length; i++) {
    const found = findExposeElement(children[i]);
    if (found) return found;
  }
  return null;
}

async function patchExposePage(): Promise<void> {
  try {
    await customElements.whenDefined("ha-config-voice-assistants-expose");
    const cls = customElements.get("ha-config-voice-assistants-expose") as
      (CustomElementConstructor & { prototype: AssistantsPageElement }) | undefined;
    if (!cls) {
      _warn(
        "ha-config-voice-assistants-expose element not found. " +
          "The expose page may not have been loaded yet. " +
          "The patch will be attempted when the element first renders.",
      );
      return;
    }

    const desc = Object.getOwnPropertyDescriptor(cls.prototype, "_availableAssistants");
    if (!desc || !desc.get) {
      _warn(
        "_availableAssistants getter not found on expose element. " +
          "HA may have renamed this property — exposure dropdown may not " +
          "include " + ASSISTANT_ID + ".",
      );
      return;
    }

    const orig = desc.get;
    Object.defineProperty(cls.prototype, "_availableAssistants", {
      get: function () {
        try {
          const result = orig.call(this) as string[];
          if (!Array.isArray(result)) return result;
          // Only advertise our assistant when it's enabled AND the
          // voiceAssistants map can resolve its name — otherwise dialogs that do
          // voiceAssistants[id].name (e.g. dialog-expose-entity) throw.
          if (!_gaManualEnabled || !_ensureVoiceAssistantEntry()) {
            // Enabled but the map isn't captured yet: force the capture, which
            // re-renders the page so this getter advertises us on the next read.
            if (_gaManualEnabled) _primeVoiceAssistantsMap();
            return result.filter((id) => id !== ASSISTANT_ID);
          }
          return result.includes(ASSISTANT_ID) ? result : result.concat(ASSISTANT_ID);
        } catch (e) {
          _error("Error in _availableAssistants getter: " + (_errorMessage(e)));
          return orig.call(this);
        }
      },
    });
    _debug("Patch 3/4 applied: expose page (_availableAssistants getter)");

    // Capture the voiceAssistants map up front so the page advertises us on its
    // very first render, not only after the user visits an entity's settings.
    _primeVoiceAssistantsMap();

    const el =
      (document.querySelector("ha-config-voice-assistants-expose") as AssistantsPageElement | null) ||
      findExposeElement(document.documentElement);
    if (el) {
      try {
        el.requestUpdate?.();
      } catch (e) {
        _debug("requestUpdate failed: " + (_errorMessage(e)));
      }
    }
  } catch (e) {
    _error("Failed to apply patch 3/4 (expose page): " + (_errorMessage(e)));
  }
}

// ---------------------------------------------------------------------------
// 4. Patch custom element prototypes (both new definitions and retroactive)
// ---------------------------------------------------------------------------

function _patchAssistantsPageProto(proto: AssistantsPageElement): void {
  try {
    const origConnected = proto.connectedCallback;
    const origFirstUpdated = proto.firstUpdated;
    const origUpdated = proto.updated;

    proto.connectedCallback = function (this: AssistantsPageElement) {
      try {
        if (origConnected) origConnected.call(this);
      } catch (e) {
        _error("Error in original connectedCallback: " + (_errorMessage(e)));
      }
      requestAnimationFrame(() => {
        try {
          injectCardInto(this);
        } catch (e) {
          _error("Error injecting card in connectedCallback: " + (_errorMessage(e)));
        }
      });
    };

    proto.firstUpdated = function (this: AssistantsPageElement, changedProps: Map<string, unknown>) {
      try {
        origFirstUpdated!.call(this, changedProps);
      } catch (e) {
        _error("Error in original firstUpdated: " + (_errorMessage(e)));
      }
      try {
        injectCardInto(this);
      } catch (e) {
        _error("Error injecting card in firstUpdated: " + (_errorMessage(e)));
      }
    };
    proto.updated = function (this: AssistantsPageElement, changedProps: Map<string, unknown>) {
      try {
        origUpdated!.call(this, changedProps);
      } catch (e) {
        _error("Error in original updated: " + (_errorMessage(e)));
      }
      try {
        injectCardInto(this);
      } catch (e) {
        _error("Error injecting card in updated: " + (_errorMessage(e)));
      }
    };
  } catch (e) {
    _error("Failed to patch assistants page proto: " + (_errorMessage(e)));
  }
}

function _renderManualBrandIcon(this: VoiceAssistantBrandIcon): void {
  try {
    const root = this.shadowRoot || (this as unknown as HTMLElement);
    if (root.querySelector("img[data-ga-manual]")) return;
    root.innerHTML = "";
    const img = document.createElement("img");
    img.dataset.gaManual = "1";
    img.className = "logo";
    img.alt = ASSISTANT_NAME;
    img.src = getBrandIconUrl();
    img.crossOrigin = "anonymous";
    img.referrerPolicy = "no-referrer";
    img.onerror = () => {
      _warn("Brand icon failed to load from " + getBrandIconUrl());
    };
    root.appendChild(img);
  } catch (e) {
    _error("Error rendering manual brand icon: " + (_errorMessage(e)));
  }
}

function _patchBrandIconProto(proto: VoiceAssistantBrandIcon): void {
  try {
    const origRender = proto.render;
    const origFirstUpdated = proto.firstUpdated;
    const origUpdated = proto.updated;
    proto.render = function (this: VoiceAssistantBrandIcon) {
      if (this.voiceAssistantId === ASSISTANT_ID) return null;
      return origRender!.call(this);
    };
    proto.firstUpdated = function (this: VoiceAssistantBrandIcon, changedProps: Map<string, unknown>) {
      if (this.voiceAssistantId === ASSISTANT_ID) {
        _renderManualBrandIcon.call(this);
      } else {
        origFirstUpdated!.call(this, changedProps);
      }
    };
    proto.updated = function (this: VoiceAssistantBrandIcon, changedProps: Map<string, unknown>) {
      if (this.voiceAssistantId === ASSISTANT_ID) {
        _renderManualBrandIcon.call(this);
      } else {
        origUpdated!.call(this, changedProps);
      }
    };
  } catch (e) {
    _error("Failed to patch brand icon proto: " + (_errorMessage(e)));
  }
}

function _renderManualExposeIcon(this: ExposeAssistantIcon): void {
  try {
    const root = this.shadowRoot || (this as unknown as HTMLElement);
    if (root.querySelector("[data-ga-manual]")) return;
    root.innerHTML = "";

    const containerId = ((this as unknown as HTMLElement).id || "ga") + "-" + ASSISTANT_ID;
    const container = document.createElement("div");
    container.className = "container";
    container.id = containerId;
    container.dataset.gaManual = "1";

    const icon = document.createElement("voice-assistant-brand-icon") as VoiceAssistantBrandIcon;
    icon.voiceAssistantId = ASSISTANT_ID;
    icon.hass = this.hass;
    if (this.manual) icon.style.filter = "grayscale(100%)";
    container.appendChild(icon);

    if (this.unsupported) {
      const alertIcon = document.createElement("ha-icon");
      alertIcon.setAttribute("icon", "mdi:alert-circle");
      alertIcon.classList.add("unsupported");
      container.appendChild(alertIcon);
    }
    root.appendChild(container);

    const tooltip = document.createElement("ha-tooltip");
    tooltip.setAttribute("for", containerId);
    tooltip.setAttribute("placement", "left");
    if (!this.unsupported && !this.manual) tooltip.setAttribute("disabled", "");

    const localize = this.hass?.localize;
    if (this.unsupported) {
      tooltip.appendChild(
        document.createTextNode(
          localize
            ? localize("ui.panel.config.voice_assistants.expose.not_supported")
            : "",
        ),
      );
      if (this.manual) tooltip.appendChild(document.createElement("br"));
    }
    if (this.manual) {
      tooltip.appendChild(
        document.createTextNode(
          localize
            ? localize("ui.panel.config.voice_assistants.expose.manually_configured")
            : "",
        ),
      );
    }
    root.appendChild(tooltip);
  } catch (e) {
    _error("Error rendering manual expose icon: " + (_errorMessage(e)));
  }
}

function _patchExposeAssistantIconProto(proto: ExposeAssistantIcon): void {
  try {
    const origRender = proto.render;
    const origFirstUpdated = proto.firstUpdated;
    const origUpdated = proto.updated;
    proto.render = function (this: ExposeAssistantIcon) {
      if (this.assistant === ASSISTANT_ID) return null;
      return origRender!.call(this);
    };
    proto.firstUpdated = function (this: ExposeAssistantIcon, changedProps: Map<string, unknown>) {
      if (this.assistant === ASSISTANT_ID) {
        _renderManualExposeIcon.call(this);
      } else {
        origFirstUpdated!.call(this, changedProps);
      }
    };
    proto.updated = function (this: ExposeAssistantIcon, changedProps: Map<string, unknown>) {
      if (this.assistant === ASSISTANT_ID) {
        _renderManualExposeIcon.call(this);
      } else {
        origUpdated!.call(this, changedProps);
      }
    };
  } catch (e) {
    _error("Failed to patch expose assistant icon proto: " + (_errorMessage(e)));
  }
}

// ---------------------------------------------------------------------------
// entity-voice-settings: inject the "Ask for PIN" (2FA) checkbox into our row.
//
// HA only renders this checkbox for cloud.google_assistant (and the whole
// google-entity fetch is cloud-gated), so for our assistant we replicate it:
// fetch the entity's 2FA info via our WS, and inject an identical ha-checkbox
// (same translation key) into our assistant's row, wired to our update WS.
// ---------------------------------------------------------------------------

function _maybeFetchEntity2fa(el: EntityVoiceSettingsElement): void {
  const entityId = el.entityId;
  if (!entityId) return;
  if (el.__gaEntityId === entityId) return; // already fetched/fetching
  el.__gaEntityId = entityId;
  el.__gaInfo = undefined;
  const hass = el.hass || getHass();
  if (!hass) return;
  hass
    .callWS<GaEntityInfo>({ type: WS_GET_ENTITY, entity_id: entityId })
    .then((info) => {
      if (el.__gaEntityId !== entityId) return; // entity changed meanwhile
      el.__gaInfo = info;
      _injectAskPin(el);
    })
    .catch(() => {
      if (el.__gaEntityId !== entityId) return;
      el.__gaInfo = null; // unsupported / not enabled — no checkbox
      _injectAskPin(el);
    });
}

function _findOurAssistantRow(root: ShadowRoot): HTMLElement | null {
  const items = root.querySelectorAll<HTMLElement>("ha-md-list-item");
  for (let i = 0; i < items.length; i++) {
    const icon = items[i].querySelector(
      "voice-assistant-brand-icon",
    ) as VoiceAssistantBrandIcon | null;
    if (icon && icon.voiceAssistantId === ASSISTANT_ID) return items[i];
  }
  return null;
}

function _onAskPinChanged(el: EntityVoiceSettingsElement, cb: TogglableElement): void {
  const hass = el.hass || getHass();
  const entityId = el.entityId;
  if (!hass || !entityId) return;
  const checked = cb.checked; // checked = ask for PIN; disable_2fa = !checked
  hass
    .callWS({ type: WS_UPDATE_ENTITY, entity_id: entityId, disable_2fa: !checked })
    .then(() => {
      if (el.__gaInfo) el.__gaInfo.disable_2fa = !checked;
    })
    .catch((err: WSError) => {
      _error("Failed to update disable_2fa: " + (err.message || err.error || String(err)));
      cb.checked = !checked; // revert on failure (mirrors cloud)
    });
}

function _injectAskPin(el: EntityVoiceSettingsElement): void {
  try {
    const root = el.shadowRoot;
    if (!root) return;
    const row = _findOurAssistantRow(root);
    if (!row) return;

    const info = el.__gaInfo;
    // Collect any previously-injected checkboxes (self-heal duplicates).
    const existingAll = row.querySelectorAll<TogglableElement>("[data-ga-2fa]");

    // Only show for security devices that might require 2FA.
    if (!info || !info.might_2fa) {
      existingAll.forEach((el2) => el2.remove());
      return;
    }
    if (existingAll.length > 0) {
      // Keep the first, drop any extras, sync its state.
      for (let i = 1; i < existingAll.length; i++) existingAll[i].remove();
      existingAll[0].checked = !info.disable_2fa;
      return;
    }

    const hass = el.hass || getHass();
    const cb = document.createElement("ha-checkbox") as unknown as TogglableElement;
    cb.setAttribute("slot", "supporting-text");
    cb.setAttribute("data-ga-2fa", "1");
    cb.checked = !info.disable_2fa;
    cb.textContent =
      (hass && hass.localize("ui.dialogs.voice-settings.ask_pin")) || "Ask for PIN";
    cb.addEventListener("change", () => _onAskPinChanged(el, cb));
    row.appendChild(cb);
  } catch (e) {
    _error("Error injecting ask_pin checkbox: " + _errorMessage(e));
  }
}

function _patchEntityVoiceSettingsProto(proto: EntityVoiceSettingsElement): void {
  try {
    const origFirstUpdated = proto.firstUpdated;
    const origUpdated = proto.updated;
    proto.firstUpdated = function (this: EntityVoiceSettingsElement, changedProps: Map<string, unknown>) {
      try {
        origFirstUpdated?.call(this, changedProps);
      } catch (e) {
        _error("Error in original firstUpdated (entity-voice-settings): " + _errorMessage(e));
      }
      _maybeFetchEntity2fa(this);
      _injectAskPin(this);
    };
    proto.updated = function (this: EntityVoiceSettingsElement, changedProps: Map<string, unknown>) {
      try {
        origUpdated?.call(this, changedProps);
      } catch (e) {
        _error("Error in original updated (entity-voice-settings): " + _errorMessage(e));
      }
      _maybeFetchEntity2fa(this);
      _injectAskPin(this);
    };
  } catch (e) {
    _error("Failed to patch entity-voice-settings proto: " + _errorMessage(e));
  }
}

type ProtoPatcher = (proto: HTMLElement & LitLifecycle) => void;

const PATCHERS: Record<string, ProtoPatcher> = {
  "ha-config-voice-assistants-assistants": _patchAssistantsPageProto as ProtoPatcher,
  "voice-assistant-brand-icon": _patchBrandIconProto as ProtoPatcher,
  "voice-assistants-expose-assistant-icon": _patchExposeAssistantIconProto as ProtoPatcher,
  "entity-voice-settings": _patchEntityVoiceSettingsProto as ProtoPatcher,
};

function patchCustomElements(): void {
  try {
    const origDefine = customElements.define;

    customElements.define = function (
      name: string,
      constructor: CustomElementConstructor,
      options?: ElementDefinitionOptions,
    ) {
      try {
        const patcher = PATCHERS[name];
        if (patcher) patcher(constructor.prototype as HTMLElement & LitLifecycle);
      } catch (e) {
        _error(
          "Error in customElements.define interceptor for '" +
            name +
            "': " +
            (_errorMessage(e)),
        );
      }
      return origDefine.call(this, name, constructor, options);
    };

    for (const name in PATCHERS) {
      try {
        const cls = customElements.get(name);
        if (cls) PATCHERS[name](cls.prototype as HTMLElement & LitLifecycle);
      } catch (e) {
        _error(
          "Error patching already-defined element '" +
            name +
            "': " +
            (_errorMessage(e)),
        );
      }
    }
    _debug("Patch 4/4 applied: custom elements (" + Object.keys(PATCHERS).join(", ") + ")");
  } catch (e) {
    _error("Failed to apply patch 4/4 (custom elements): " + (_errorMessage(e)));
  }
}

// ---------------------------------------------------------------------------
// Card injection
//
// [data-ga-manual-card] marker is the source of truth. Lit may re-render
// .content and remove injected DOM, so re-inject when marker is missing.
// _observerActive prevents duplicate MutationObservers on the same element.
// injectCardInto is idempotent — safe at any lifecycle stage.
// ---------------------------------------------------------------------------

const _observerActive = new WeakSet<AssistantsPageElement>();

interface InsertionPoint {
  ref: HTMLElement | null;
  before: boolean;
}

const INSERTION_LOOKUP = [
  { selector: "assist-pref", before: false },
  { selector: "assist-current-device-pref", before: false },
  { selector: "cloud-discover", before: true },
  { selector: "cloud-google-pref", before: true },
];

function findInsertionPoint(content: HTMLElement): InsertionPoint {
  for (let i = 0; i < INSERTION_LOOKUP.length; i++) {
    const item = INSERTION_LOOKUP[i];
    try {
      const el = content.querySelector<HTMLElement>(item.selector);
      if (el) return { ref: el, before: item.before };
    } catch (e) {
      _debug("querySelector('" + item.selector + "') failed: " + (_errorMessage(e)));
    }
  }
  return { ref: null, before: false };
}

function makeSettingItem(
  hass: HomeAssistant | undefined,
  headlineKey: string,
  supportKey: string,
  headlineFallback: string,
  supportFallback: string,
): HTMLElement {
  const item = document.createElement("ha-md-list-item");
  item.style.cssText =
    "--md-list-item-leading-space:0;--md-list-item-trailing-space:0;--md-item-overflow:visible";
  const headline = document.createElement("span");
  headline.slot = "headline";
  headline.textContent = (hass && hass.localize(headlineKey)) || headlineFallback;
  item.appendChild(headline);
  const support = document.createElement("span");
  support.slot = "supporting-text";
  support.textContent = (hass && hass.localize(supportKey)) || supportFallback;
  item.appendChild(support);
  return item;
}

function makeSwitchSettingItem(
  hass: HomeAssistant | undefined,
  headlineKey: string,
  supportKey: string,
  headlineFallback: string,
  supportFallback: string,
  handler?: (ev: Event) => void,
): HTMLElement {
  const item = makeSettingItem(hass, headlineKey, supportKey, headlineFallback, supportFallback);
  const sw = document.createElement("ha-switch");
  sw.slot = "end";
  if (handler) sw.addEventListener("change", handler);
  item.appendChild(sw);
  return item;
}

let _pinTimer: ReturnType<typeof setTimeout> | null = null;

function _setRowsVisible(rows: HTMLElement[], visible: boolean): void {
  const display = visible ? "" : "none";
  for (let i = 0; i < rows.length; i++) {
    rows[i].style.display = display;
  }
}

function buildCard(): HTMLElement | null {
  try {
    const hass = getHass();

    ensureTranslationsLoaded(); // hass is reliably available here

    const brandIcon = document.createElement("voice-assistant-brand-icon") as VoiceAssistantBrandIcon;
    brandIcon.voiceAssistantId = ASSISTANT_ID;
    brandIcon.hass = hass;
    brandIcon.style.cssText =
      "height:28px;margin-right:16px;margin-inline-end:16px;margin-inline-start:initial";

    const card = document.createElement("ha-card");
    card.setAttribute("outlined", "");
    card.setAttribute("data-ga-manual-card", "1");

    const header = document.createElement("h1");
    header.className = "card-header";
    header.style.cssText = "display:flex;align-items:center;position:relative";
    header.appendChild(brandIcon);
    header.appendChild(document.createTextNode(ASSISTANT_NAME));
    card.appendChild(header);

    const headerActions = document.createElement("div");
    headerActions.style.cssText =
      "position:absolute;right:24px;inset-inline-end:24px;inset-inline-start:initial;top:50%;transform:translateY(-50%);display:flex;flex-direction:row;align-items:center";
    const helpBtn = document.createElement("ha-icon-button");
    helpBtn.setAttribute(
      "label",
      (hass?.localize("ui.panel.config.cloud.account.remote.link_learn_how_it_works")) ||
        "Learn how it works",
    );
    helpBtn.setAttribute(
      "href",
      "https://www.home-assistant.io/integrations/google_assistant/",
    );
    helpBtn.setAttribute("target", "_blank");
    helpBtn.setAttribute("rel", "noreferrer");
    helpBtn.style.cssText =
      "display:flex;align-items:center;margin-right:8px;margin-inline-end:8px;margin-inline-start:initial;direction:var(--direction);color:var(--secondary-text-color)";
    const helpIcon = document.createElement("ha-icon");
    helpIcon.setAttribute("icon", "mdi:help-circle-outline");
    helpIcon.style.display = "block";
    helpBtn.appendChild(helpIcon);
    headerActions.appendChild(helpBtn);

    const globalSwitch = document.createElement("ha-switch");
    headerActions.appendChild(globalSwitch);

    header.appendChild(headerActions);

    const body = document.createElement("div");
    body.className = "card-content";

    const desc = document.createElement("p");
    desc.textContent =
      (hass?.localize("ui.panel.config.cloud.account.google.info") || "")
        .replace(/\s*Cloud\b/g, "") ||
      "With the Google Assistant integration for Home Assistant, you'll be able to control all your Home Assistant devices via any Google Assistant-enabled device.";
    body.appendChild(desc);

    const yamlAlert = document.createElement("ha-alert");
    yamlAlert.setAttribute("alert-type", "info");
    yamlAlert.style.display = "none";
    yamlAlert.innerHTML = t("yaml_detected");
    _retranslate.push(() => {
      yamlAlert.innerHTML = t("yaml_detected");
    });
    body.appendChild(yamlAlert);

    const settingsRows: HTMLElement[] = [];
    let reportStateSwitch: HTMLElement | null = null;
    let pinInput: TogglableElement | null = null;

    function addSetting(el: HTMLElement) {
      settingsRows.push(el);
      body.appendChild(el);
    }

    const exposeItem = makeSwitchSettingItem(
      hass,
      "ui.panel.config.voice_assistants.expose.expose_new_entities",
      "ui.panel.config.voice_assistants.expose.expose_new_entities_info",
      "Expose new entities",
      "Should new entities be exposed? Exposes supported devices that are not classified as security devices.",
      onExposeToggle,
    );
    addSetting(exposeItem);

    const reportStateItem = makeSwitchSettingItem(
      hass,
      "ui.panel.config.cloud.account.google.enable_state_reporting",
      "ui.panel.config.cloud.account.google.info_state_reporting",
      "Enable state reporting",
      "If you enable state reporting, Home Assistant will send all state changes of exposed entities to Google. This speeds up voice commands and allows you to always see the latest states in the Google app.",
      onReportStateToggle,
    );
    reportStateSwitch = reportStateItem.querySelector("ha-switch");
    addSetting(reportStateItem);

    const securityItem = makeSettingItem(
      hass,
      "ui.panel.config.cloud.account.google.security_devices",
      "ui.panel.config.cloud.account.google.enter_pin_info",
      "Security devices",
      "Please enter a PIN to interact with security devices. Security devices are doors, garage doors, and locks. You will be asked to say/enter this PIN when interacting with security devices via Google Assistant.",
    );
    addSetting(securityItem);

    pinInput = document.createElement("ha-input") as unknown as TogglableElement;
    pinInput.setAttribute(
      "label",
      (hass?.localize("ui.panel.config.cloud.account.google.devices_pin")) || "Security devices PIN",
    );
    pinInput.placeholder =
      (hass?.localize("ui.panel.config.cloud.account.google.enter_pin_hint")) ||
      "Enter a PIN to use security devices";
    pinInput.style.cssText = "width:250px;margin-top:8px";
    pinInput.addEventListener("input", onPinChanged);
    addSetting(pinInput);

    card.appendChild(body);

    const actions = document.createElement("div");
    actions.className = "card-actions";
    actions.style.cssText = "display:flex";

    const exposeLink = document.createElement("a");
    exposeLink.href =
      "/config/voice-assistants/expose?assistants=" + ASSISTANT_ID + "&historyBack";
    exposeLink.style.textDecoration = "none";

    const exposeBtn = document.createElement("ha-button");
    exposeBtn.setAttribute("appearance", "plain");
    exposeBtn.textContent = "Exposed entities";
    exposeBtn.setAttribute("data-ga-count", "");
    exposeLink.appendChild(exposeBtn);
    actions.appendChild(exposeLink);

    card.appendChild(actions);

    settingsRows.push(actions);

    // Global toggle: calls enable/disable WS commands
    globalSwitch.addEventListener("change", () => {
      const cfg = (globalSwitch as TogglableElement).checked
        ? _TOGGLE_CONFIGS.enable
        : _TOGGLE_CONFIGS.disable;
      _toggleIntegration(cfg, card, globalSwitch, settingsRows);
    });

    // Hidden until the initial config state is fetched.
    _setRowsVisible(settingsRows, false);
    refreshCardState(card, globalSwitch, settingsRows, reportStateSwitch, pinInput, yamlAlert);

    return card;
  } catch (e) {
    _error("Failed to build card: " + (_errorMessage(e)));
    return null;
  }
}

// ---------------------------------------------------------------------------
// Enable/disable integration
// ---------------------------------------------------------------------------

interface ToggleConfig {
  action: "enable" | "disable";
  wsType: string;
  successKey: StringKey;
  failKey: StringKey;
  failHintKey: StringKey;
  showCardOnSuccess: boolean;
}

const _TOGGLE_CONFIGS: Record<string, ToggleConfig> = {
  enable: {
    action: "enable",
    wsType: WS_ENABLE,
    successKey: "enable_success",
    failKey: "enable_failed",
    failHintKey: "enable_fail_hint",
    showCardOnSuccess: true,
  },
  disable: {
    action: "disable",
    wsType: WS_DISABLE,
    successKey: "disable_success",
    failKey: "disable_failed",
    failHintKey: "disable_fail_hint",
    showCardOnSuccess: false,
  },
};

async function _toggleIntegration(
  config: ToggleConfig,
  card: HTMLElement,
  globalSwitch: HTMLElement,
  settingsRows: HTMLElement[],
): Promise<void> {
  const hass = getHass();
  if (!hass) {
    _warn("_toggleIntegration: Home Assistant not loaded");
    (globalSwitch as TogglableElement).checked = !config.showCardOnSuccess;
    return;
  }

  // Issue the enable/disable WS call against a freshly-resolved entry_id.
  const sendToggle = async (): Promise<void> => {
    const entryId = await getEntryId();
    _info(
      config.action.charAt(0).toUpperCase() + config.action.slice(1) +
        " Google Assistant for entry_id=" + entryId,
    );
    await hass.callWS({ type: config.wsType, entry_id: entryId });
  };

  try {
    try {
      await sendToggle();
    } catch (err: unknown) {
      if (!_isEntryGoneError(err)) throw err;
      // The integration was likely deleted and re-added; our cached entry_id is
      // stale. Drop it, re-resolve, and retry once before giving up.
      _warn("Cached entry_id was stale; re-resolving and retrying " + config.action);
      _invalidateEntryId();
      await sendToggle();
    }

    _info(t(config.successKey));
    _gaManualEnabled = config.showCardOnSuccess;
    _refreshExposePage();
    _setRowsVisible(settingsRows, config.showCardOnSuccess);
    if (config.showCardOnSuccess) refreshExposeToggle(card);
  } catch (err: unknown) {
    const wsErr = err as WSError;
    const failMsg = t(config.failKey);
    _error(failMsg + " " + _wsErrorMessage(err));
    (globalSwitch as TogglableElement).checked = !config.showCardOnSuccess;
    _showToast(
      failMsg + " " +
        (wsErr.message || wsErr.error || t("check_logs")) +
        "\n\n" + t(config.failHintKey),
      true,
    );
  }
}

// ---------------------------------------------------------------------------
// Card state refresh
// ---------------------------------------------------------------------------

async function refreshCardState(
  card: HTMLElement,
  globalSwitch: HTMLElement,
  settingsRows: HTMLElement[],
  reportStateSwitch: HTMLElement | null,
  pinInput: TogglableElement | null,
  yamlAlert: HTMLElement,
): Promise<void> {
  try {
    const entryId = await getEntryId();
    const hass = getHass();
    if (!hass) {
      _debug("refreshCardState: Home Assistant not loaded yet, will retry on next render");
      return;
    }

    try {
      const config = await hass.callWS<{
        enabled: boolean;
        yaml_suppressed: boolean;
        report_state: boolean;
        secure_devices_pin: string;
      }>({
        type: WS_GET_CONFIG,
        entry_id: entryId,
      });

      _debug(
        "refreshCardState received config: enabled=" +
          config.enabled +
          " report_state=" +
          config.report_state,
      );

      _gaManualEnabled = config.enabled;
      _refreshExposePage();

      (globalSwitch as TogglableElement).checked = config.enabled;

      if (yamlAlert) {
        yamlAlert.style.display = config.yaml_suppressed ? "" : "none";
      }

      _setRowsVisible(settingsRows, config.enabled);

      if (reportStateSwitch) {
        (reportStateSwitch as TogglableElement).checked = config.report_state;
        (reportStateSwitch as TogglableElement).disabled = !config.enabled;
      }

      if (pinInput) {
        pinInput.value = config.secure_devices_pin || "";
        pinInput.disabled = !config.enabled;
      }

      refreshExposeToggle(card);
    } catch (err: unknown) {
      _error("Failed to fetch card state: " + _wsErrorMessage(err));
    }
  } catch (err: unknown) {
    _error("refreshCardState: " + (err as Error).message);
  }
}

/**
 * Inject the card into a ha-config-voice-assistants-assistants element.
 * Idempotent — safe to call at any time (lifecycle hooks, DOM scans, observers).
 */
function injectCardInto(el: AssistantsPageElement): void {
  if (!el) return;

  try {
    const root = el.shadowRoot || (el as unknown as HTMLElement);
    const content = root.querySelector<HTMLElement>(".content");
    if (!content) {
      _debug("injectCardInto: no .content in shadowRoot of " + el.nodeName);
      return;
    }

    if (content.querySelector("[data-ga-manual-card]")) {
      _observerActive.delete(el);
      return;
    }

    if (content.children.length === 0) {
      if (!_observerActive.has(el)) {
        _observerActive.add(el);
        _debug("injectCardInto: .content is empty, waiting via MutationObserver");
        const obs = new MutationObserver(() => {
          if (content.children.length > 0) {
            obs.disconnect();
            _observerActive.delete(el);
            injectCardInto(el);
          }
        });
        obs.observe(content, { childList: true });
      }
      return;
    }

    _info("Injecting card into " + el.nodeName);

    const card = buildCard();
    if (!card) {
      _error("buildCard returned null, card injection aborted");
      return;
    }

    const point = findInsertionPoint(content);

    try {
      if (point.ref && point.before) {
        point.ref.insertAdjacentElement("beforebegin", card);
        _debug("Card inserted before '" + point.ref.nodeName.toLowerCase() + "'");
      } else if (point.ref) {
        point.ref.insertAdjacentElement("afterend", card);
        _debug("Card inserted after '" + point.ref.nodeName.toLowerCase() + "'");
      } else {
        content.appendChild(card);
        _debug("Card appended to .content (no insertion point match)");
      }
    } catch (e) {
      _error(
        "DOM insertion failed: " +
          (_errorMessage(e)) +
          ". Falling back to appendChild.",
      );
      try {
        content.appendChild(card);
      } catch (e2) {
        _error("Fallback appendChild also failed: " + (e2 instanceof Error ? e2.message : String(e2)));
      }
    }
  } catch (e) {
    _error("injectCardInto failed: " + (_errorMessage(e)));
  }
}

/**
 * Recursively search a DOM tree (including all shadow roots) for
 * ha-config-voice-assistants-assistants elements.
 */
function findAllAssistantsElements(root: Node | null): AssistantsPageElement[] {
  const results: AssistantsPageElement[] = [];
  if (!root) return results;
  if (root.nodeType !== 1 && root.nodeType !== 11) return results;

  if (root instanceof HTMLElement && root.nodeName === "HA-CONFIG-VOICE-ASSISTANTS-ASSISTANTS") {
    results.push(root as unknown as AssistantsPageElement);
  }

  const shadowRoot = (root as HTMLElement).shadowRoot;
  if (shadowRoot) {
    try {
      results.push(...findAllAssistantsElements(shadowRoot));
    } catch (e) {
      _debug(
        "Could not traverse shadowRoot of " +
          (root as HTMLElement).nodeName +
          ": " +
          (_errorMessage(e)),
      );
    }
  }

  try {
    const children = (root as HTMLElement).children || (root as HTMLElement).childNodes || [];
    for (let i = 0; i < children.length; i++) {
      try {
        results.push(...findAllAssistantsElements(children[i]));
      } catch {
        /* skip problem children */
      }
    }
  } catch {
    /* children access may fail on some nodes */
  }

  return results;
}

/**
 * Scan the entire DOM (including all shadow roots) for assistants page
 * elements and inject the card into each.
 */
function injectIntoAllAssistantsElements(): void {
  try {
    const elements = findAllAssistantsElements(document.documentElement);
    _debug("Found " + elements.length + " assistants page elements to inject into");
    for (let i = 0; i < elements.length; i++) {
      try {
        injectCardInto(elements[i]);
      } catch (e) {
        _error(
          "Error injecting card into element " +
            i +
            ": " +
            (_errorMessage(e)),
        );
      }
    }
  } catch (e) {
    _error("injectIntoAllAssistantsElements failed: " + (_errorMessage(e)));
  }
}

// ---------------------------------------------------------------------------
// WS-backed toggle handlers
// ---------------------------------------------------------------------------

function _refreshExposePage(): void {
  try {
    const el = findExposeElement(document.documentElement) as AssistantsPageElement | null;
    if (!el) return;
    if (el._fetchEntities) {
      el._fetchEntities();
    } else if (el.requestUpdate) {
      el.requestUpdate();
    }
  } catch (e) {
    _debug("_refreshExposePage: " + (_errorMessage(e)));
  }
}

function refreshExposeToggle(card: HTMLElement): void {
  const hass = getHass();
  if (!hass) return;
  // Scope to .card-content so we never select the global enable/disable
  // toggle, which lives in the header (.card-header) and would otherwise be
  // matched as the first ha-switch — clobbering it back to expose_new (false).
  const sw = card.querySelector<HTMLInputElement>(".card-content ha-switch");
  const btn = card.querySelector<HTMLElement>("[data-ga-count]");

  Promise.all([
    hass.callWS<{ expose_new: boolean }>({
      type: "homeassistant/expose_new_entities/get",
      assistant: ASSISTANT_ID,
    }),
    hass.callWS<{ exposed_entities: Record<string, Record<string, unknown>> }>({
      type: "homeassistant/expose_entity/list",
    }),
  ])
    .then((results) => {
      if (sw) sw.checked = results[0].expose_new;
      if (!btn) return;
      const exposedEntities = results[1].exposed_entities || {};
      let count = 0;
      try {
        // Mirror HA's own count (cloud-google-pref): only entities that still
        // exist in hass.states, so stale registry records don't inflate it.
        const states = hass.states || {};
        count = Object.entries(exposedEntities).filter(([entityId, s]) => {
          return s && s[ASSISTANT_ID] && entityId in states;
        }).length;
      } catch (e) {
        _debug("Error counting exposed entities: " + (_errorMessage(e)));
      }
      btn.textContent = hass.localize
        ? hass.localize("ui.panel.config.voice_assistants.assistants.pipeline.exposed_entities", {
            number: count,
          })
        : count + " exposed entities";
    })
    .catch((err: WSError) => {
      _error(
        "Failed to refresh expose toggle: " + (err.message || err.error || String(err)),
      );
    });
}

function onExposeToggle(e: Event): void {
  const hass = getHass();
  if (!hass) return;
  const checked = (e.target as TogglableElement).checked;
  hass
    .callWS({
      type: "homeassistant/expose_new_entities/set",
      assistant: ASSISTANT_ID,
      expose_new: checked,
    })
    .catch((err: WSError) => {
      _error(
        "Failed to set expose_new_entities: " + (err.message || err.error || String(err)),
      );
      (e.target as TogglableElement).checked = !checked;
    });
}

async function onReportStateToggle(e: Event): Promise<void> {
  const hass = getHass();
  if (!hass) return;
  const checked = (e.target as TogglableElement).checked;

  try {
    await _withEntryRetry((entryId) =>
      hass.callWS({
        type: WS_UPDATE_CONFIG,
        entry_id: entryId,
        data: { report_state: checked },
      }),
    );
  } catch (err: unknown) {
    const wsErr = err as WSError;
    _error(
      "Failed to update report_state: " +
        (wsErr.message || wsErr.error || String(err)),
    );
    (e.target as TogglableElement).checked = !checked;
    _showToast(
      t(checked ? "report_state_enable_failed" : "report_state_disable_failed"),
      true,
    );
  }
}

function onPinChanged(e: Event): void {
  const hass = getHass();
  if (!hass) return;
  const input = e.target as TogglableElement;
  const value = input.value;

  if (_pinTimer) clearTimeout(_pinTimer);
  _pinTimer = setTimeout(() => {
    _savePin(value, input);
  }, 500);
}

async function _restorePinValue(input: TogglableElement): Promise<void> {
  const hass = getHass();
  if (!hass) return;
  try {
    const entryId = await getEntryId();
    const config = await hass.callWS<{ secure_devices_pin: string }>({
      type: WS_GET_CONFIG,
      entry_id: entryId,
    });
    input.value = config.secure_devices_pin || "";
  } catch {
    /* best-effort revert */
  }
}

async function _savePin(value: string, input?: TogglableElement): Promise<void> {
  const hass = getHass();
  if (!hass) return;

  try {
    await _withEntryRetry((entryId) =>
      hass.callWS({
        type: WS_UPDATE_CONFIG,
        entry_id: entryId,
        data: { secure_devices_pin: value },
      }),
    );
  } catch (err: unknown) {
    const wsErr = err as WSError;
    _error(
      "Failed to update secure_devices_pin: " +
        (wsErr.message || wsErr.error || String(err)),
    );
    _showToast(
      (hass.localize("ui.panel.config.cloud.account.google.enter_pin_error") ||
        "Unable to store the PIN.") +
        " " +
        (wsErr.message || wsErr.error || ""),
      true,
    );
    if (input) _restorePinValue(input);
  }
}

// ---------------------------------------------------------------------------
// Init — apply all patches, inject cards, start observers
// ---------------------------------------------------------------------------

function init(): void {
  // No-op until hass is available; buildCard retries.
  ensureTranslationsLoaded();

  _banner(t("ready_banner", { name: ASSISTANT_NAME }));

  // Apply each patch independently — one failing does not block the rest
  try {
    patchVoiceAssistants();
  } catch (e) {
    _error("patchVoiceAssistants threw: " + (_errorMessage(e)));
  }
  try {
    patchSortKey();
  } catch (e) {
    _error("patchSortKey threw: " + (_errorMessage(e)));
  }
  try {
    patchCustomElements();
  } catch (e) {
    _error("patchCustomElements threw: " + (_errorMessage(e)));
  }

  try {
    injectIntoAllAssistantsElements();
  } catch (e) {
    _error("injectIntoAllAssistantsElements threw: " + (_errorMessage(e)));
  }

  // Watch for dynamically added assistants page elements. Mutations can arrive
  // in rapid bursts (Lit renders, navigation); rather than run the recursive
  // shadow-DOM search for each individual node synchronously, collect added
  // nodes and process them once per animation frame. This dedupes overlapping
  // subtrees and yields the main thread between bursts.
  try {
    const _pendingNodes = new Set<Node>();
    let _scanScheduled = false;

    const _scanPending = (): void => {
      _scanScheduled = false;
      const nodes = Array.from(_pendingNodes);
      _pendingNodes.clear();
      for (let i = 0; i < nodes.length; i++) {
        try {
          const elements = findAllAssistantsElements(nodes[i]);
          for (let k = 0; k < elements.length; k++) {
            try {
              injectCardInto(elements[k]);
            } catch (e) {
              _error(
                "Error injecting card into dynamically added element: " +
                  (_errorMessage(e)),
              );
            }
          }
        } catch (e) {
          _debug(
            "Error scanning dynamically added node: " +
              (_errorMessage(e)),
          );
        }
      }
    };

    const docObserver = new MutationObserver((mutations) => {
      for (let i = 0; i < mutations.length; i++) {
        const addedNodes = mutations[i].addedNodes;
        for (let j = 0; j < addedNodes.length; j++) {
          const node = addedNodes[j];
          if (node.nodeType === 1) _pendingNodes.add(node);
        }
      }
      if (_pendingNodes.size > 0 && !_scanScheduled) {
        _scanScheduled = true;
        requestAnimationFrame(_scanPending);
      }
    });
    const target: Node | null = document.body || document.documentElement;
    if (target) {
      docObserver.observe(target, {
        childList: true,
        subtree: true,
      });
      _debug(
        "MutationObserver active on " +
          (target === document.body ? "document.body" : "documentElement"),
      );
    } else {
      _warn("Cannot start MutationObserver: no document.body or documentElement");
    }
  } catch (e) {
    _error("Failed to start MutationObserver: " + (_errorMessage(e)));
  }

  // Expose page patch (async, runs when element is defined)
  try {
    patchExposePage();
  } catch (e) {
    _error("patchExposePage threw: " + (_errorMessage(e)));
  }

  _info("Init complete — all patches applied");
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
