/**
 * Google Assistant (Manual) - Frontend companion module.
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
  // Cached icon node returned from render(); a stable Node keeps the icon in
  // Lit's lifecycle so it survives element reuse (virtualized tables, .map()).
  __gaIconNode?: HTMLImageElement;
}

interface ExposeAssistantIcon extends HTMLElement, LitLifecycle {
  assistant: string;
  hass?: HomeAssistant;
  unsupported?: boolean;
  manual?: boolean;
  // Cached content node + the prop signature it was built for (see __gaIconNode).
  __gaExposeNode?: HTMLElement;
  __gaExposeSig?: string;
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
  // HA's per-assistant "unsupported" map (keyed by assistant id); HA's render
  // greys out the toggle and shows a notice for entries set true. We set our id
  // when the backend reports the entity isn't supported by Google Assistant.
  _unsupported?: Record<string, boolean>;
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
// Developer-facing brand slug for the console badge and log prefix. Distinct
// from ASSISTANT_NAME, which is the user-facing name shown in the HA UI.
const BRAND_SLUG = "hass-ga-manual-ui";
const SORT_TARGET = ["conversation", "cloud.alexa", "cloud.google_assistant"];

// Our brand icon is bundled with the integration and served at /<domain>/brand/
// (see frontend.py). Self-hosting avoids the brands CDN, which errors for this
// manual integration since it isn't a registered HA brand.
const BRAND_URL = `/${ASSISTANT_ID}/brand`;

const WS_GET_ENTRY_ID = `${ASSISTANT_ID}/get_entry_id`;
const WS_GET_CONFIG = `${ASSISTANT_ID}/get_config`;
const WS_UPDATE_CONFIG = `${ASSISTANT_ID}/update_config`;
const WS_ENABLE = `${ASSISTANT_ID}/enable`;
const WS_DISABLE = `${ASSISTANT_ID}/disable`;
const WS_GET_ENTITY = `${ASSISTANT_ID}/get_entity`;
const WS_UPDATE_ENTITY = `${ASSISTANT_ID}/update_entity`;
const WS_EXPORT_CONFIG = `${ASSISTANT_ID}/export_config`;
const WS_IMPORT_CONFIG = `${ASSISTANT_ID}/import_config`;

// Injected at build time via esbuild --define (see package.json). Compared to
// the server-reported version to detect a stale (cached) bundle; "" disables it.
declare const __BUILD_VERSION__: string;
const BUILD_VERSION: string =
  typeof __BUILD_VERSION__ !== "undefined" ? __BUILD_VERSION__ : "";

// ---------------------------------------------------------------------------
// Localization (see AGENTS.md "Frontend localization")
// ---------------------------------------------------------------------------
// Card strings live in locale/<lang>.json under "frontend" and are fetched over
// HTTP for the user's language at runtime; EN_STRINGS is the synchronous fallback.

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
  update_available: string;
  export_yaml: string;
  import_yaml: string;
  import_confirm_title: string;
  import_confirm_text: string;
  import_confirm_warning: string;
  import_success: string;
  import_failed: string;
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
  ready_banner: "{name} is ready - manage it under Settings → Voice assistants.",
  update_available:
    "A new version of Google Assistant (Manual) is available. " +
    "Refresh your browser (Ctrl+Shift+R, or Cmd+Shift+R on Mac) to load it.",
  export_yaml: "Export YAML",
  import_yaml: "Import YAML",
  import_confirm_title: "Import YAML configuration?",
  import_confirm_text:
    "This replaces all settings for Google Assistant with the contents of this file. " +
    "Aliases are added and never removed.",
  import_confirm_warning: "This cannot be undone.",
  import_success: "Configuration imported successfully.",
  import_failed: "Failed to import configuration.",
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

// Fetch the localized card strings once (memoized on the first call) from the
// integration's static locale endpoint; fails silently to EN_STRINGS.
function ensureTranslationsLoaded(): Promise<void> {
  if (_translationsPromise) return _translationsPromise;

  // Defer (without memoizing) until hass exists, so we load the user's language
  // rather than locking in "en". buildCard() re-calls this once hass is present.
  const hass = getHass();
  if (!hass) return Promise.resolve();

  const language = hass.locale?.language || hass.language || "en";

  // Try the exact language tag, then the base language; EN_STRINGS is the
  // synchronous fallback baked into the bundle if neither resolves.
  const candidates = [language];
  const base = language.split("-")[0];
  if (base && base !== language) candidates.push(base);

  _translationsPromise = (async () => {
    for (const lang of candidates) {
      try {
        const resp = await fetch(`/${ASSISTANT_ID}/locale/${lang}.json`);
        if (!resp.ok) continue;
        const data = (await resp.json()) as {
          frontend?: Record<string, string>;
        };
        const table = data.frontend;
        if (!table) continue;
        const loaded: Partial<LocaleTable> = {};
        for (const key of Object.keys(EN_STRINGS) as StringKey[]) {
          const val = table[key];
          if (typeof val === "string") loaded[key] = val;
        }
        _loadedStrings = loaded;
        break;
      } catch (e) {
        _debug("Failed to load locale '" + lang + "': " + _errorMessage(e));
      }
    }
    // Re-apply any build-time text now that runtime strings (or the fallback)
    // are settled.
    for (const fn of _retranslate) {
      try {
        fn();
      } catch (e) {
        _debug("retranslate callback failed: " + _errorMessage(e));
      }
    }
  })();
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
// assistant's display name - dialogs do voiceAssistants[id].name directly.
let _voiceAssistantsMap: Record<string, unknown> | null = null;

// ---------------------------------------------------------------------------
// Logging helpers. Three tiers, all visible without dev tools:
//   - _banner():        console + a one-time line in the HA logs.
//   - _warn()/_error(): console + forwarded to the HA logs.
//   - _debug()/_info(): verbose; only when the debug flag is set.
// Enable verbose: localStorage.setItem("gaManualDebug", "1") (or ?gaManualDebug), reload.
// ---------------------------------------------------------------------------

let _DEBUG = false;
try {
  _DEBUG =
    (typeof localStorage !== "undefined" &&
      !!localStorage.getItem("gaManualDebug")) ||
    (typeof location !== "undefined" &&
      /[?&#]gaManualDebug\b/.test(location.search + location.hash));
} catch {
  // localStorage / location may be unavailable
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
    // never let logging throw or recurse
  }
}

function _log(level: "debug" | "info" | "warn" | "error", message: string, data?: unknown): void {
  const isProblem = level === "warn" || level === "error";
  if (_DEBUG || isProblem) {
    const prefixed = "[" + BRAND_SLUG + "] " + message;
    try {
      if (data !== undefined) {
        console[level](prefixed, data);
      } else {
        console[level](prefixed);
      }
    } catch {
      // console might be unavailable
    }
  }
  if (isProblem) _forwardToHaLog(level, message);
}

function _debug(msg: string, data?: unknown): void { _log("debug", msg, data); }
function _info(msg: string, data?: unknown): void { _log("info", msg, data); }
function _warn(msg: string, data?: unknown): void { _log("warn", msg, data); }
function _error(msg: string, data?: unknown): void { _log("error", msg, data); }

// Always-visible load banner: a styled console badge (like other HA frontend
// plugins, e.g. paper-buttons-row) + a single readable info line in the HA logs.
let _bannerForwarded = false;
function _banner(message: string): void {
  try {
    // Two-tone pill: name on Google blue, version on dark. Consoles that ignore
    // %c styling still print the text legibly.
    if (BUILD_VERSION) {
      console.info(
        "%c " + BRAND_SLUG + " %c v" + BUILD_VERSION + " ",
        "background:#4285f4;color:#fff;font-weight:600;padding:2px 6px;border-radius:4px 0 0 4px;",
        "background:#202124;color:#8ab4f8;font-weight:600;padding:2px 6px;border-radius:0 4px 4px 0;",
      );
    } else {
      console.info(
        "%c " + BRAND_SLUG + " ",
        "background:#4285f4;color:#fff;font-weight:600;padding:2px 6px;border-radius:4px;",
      );
    }
  } catch {
    // console might be unavailable
  }
  // The readable sentence (with the "manage it under Settings…" hint) still
  // goes to the HA logs, where %c styling wouldn't render anyway.
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
      title: ASSISTANT_NAME + (isError ? " - Error" : " - Notice"),
      message,
      notification_id: "hass_ga_manual_ui_notification",
    });
  } catch (e) {
    _error("Failed to show toast: " + _errorMessage(e));
  }
}

// ---------------------------------------------------------------------------
// Export / import YAML config
// ---------------------------------------------------------------------------

// Download text as a file via a throwaway anchor (no dep). The <a> is appended
// to document.body to satisfy user-gesture rules and removed straight after.
function _downloadText(text: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/yaml" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Export: ask the backend for the standalone YAML + filename, then download it.
async function _onExportClick(): Promise<void> {
  const hass = getHass();
  if (!hass?.callWS) return;
  try {
    const res = await _withEntryRetry((entryId) =>
      hass.callWS<{ yaml: string; filename: string }>({
        type: WS_EXPORT_CONFIG,
        entry_id: entryId,
      }),
    );
    _downloadText(res.yaml, res.filename);
  } catch (e) {
    _error("Export failed: " + _errorMessage(e));
    _showToast(t("check_logs"), true);
  }
}

// Import: pick a file, confirm (import overwrites exposure + flags), then apply.
// The confirm fires after a file is chosen and before the WS call, so cancelling
// at either point leaves everything untouched.
function _onImportClick(): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".yaml,.yml";
  input.style.display = "none";
  document.body.appendChild(input);
  input.addEventListener("change", async () => {
    try {
      const file = input.files?.[0];
      if (!file) return;
      const yaml = await file.text();
      const confirmed = await _confirmDialog(
        t("import_confirm_title"),
        t("import_confirm_text"),
        t("import_confirm_warning"),
      );
      if (!confirmed) return;
      const hass = getHass();
      if (!hass?.callWS) return;
      await _withEntryRetry((entryId) =>
        hass.callWS({ type: WS_IMPORT_CONFIG, entry_id: entryId, yaml }),
      );
      _showToast(t("import_success"), false);
    } catch (e) {
      _error("Import failed: " + _errorMessage(e));
      _showToast(t("import_failed"), true);
    } finally {
      input.remove();
    }
  });
  input.click();
}

// Inject the ::backdrop scrim style once (can't be set inline). Uses HA's scrim
// token so the dimming matches HA's own dialogs.
let _confirmStyleInjected = false;
function _ensureConfirmStyle(): void {
  if (_confirmStyleInjected) return;
  _confirmStyleInjected = true;
  const style = document.createElement("style");
  style.textContent =
    "dialog[data-ga-confirm-dialog]::backdrop{" +
    "background:var(--mdc-dialog-scrim-color,rgba(0,0,0,0.32))}";
  document.head.appendChild(style);
}

// Confirmation modal built from the native <dialog> element (top-layer, focus
// trap, Escape, and ::backdrop scrim handled by the browser) wrapping a real HA
// ha-card surface and ha-button actions - both already loaded, since our card
// uses them on this page. One consistent dialog every time, with no dependency
// on HA's lazy-loaded dialog-box and no native window.confirm fallback. Resolves
// true on confirm; Escape, backdrop click, and Cancel resolve false.
function _confirmDialog(
  title: string,
  text: string,
  warning?: string,
): Promise<boolean> {
  const hass = getHass();
  _ensureConfirmStyle();
  return new Promise<boolean>((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.setAttribute("data-ga-confirm-dialog", "");
    dlg.style.cssText =
      "padding:0;border:none;background:transparent;overflow:visible;" +
      "max-width:min(90vw,400px);color:var(--primary-text-color,#212121)";

    const card = document.createElement("ha-card");
    card.style.cssText =
      "padding:var(--dialog-content-padding,var(--ha-space-6,24px));box-sizing:border-box";

    const heading = document.createElement("h2");
    heading.textContent = title;
    heading.style.cssText =
      "margin:0 0 var(--ha-space-3,12px);font-size:var(--ha-font-size-2xl,1.5rem);" +
      "font-weight:var(--ha-font-weight-normal,400);" +
      "line-height:var(--ha-line-height-condensed,1.2)";

    const body = document.createElement("p");
    body.textContent = text;
    body.style.cssText =
      "margin:0 0 var(--ha-space-6,24px);line-height:var(--ha-line-height-normal,1.5)";

    // Optional emphasized warning on its own line (HA medium weight).
    let warningEl: HTMLParagraphElement | null = null;
    if (warning) {
      body.style.marginBottom = "var(--ha-space-2,8px)";
      warningEl = document.createElement("p");
      warningEl.textContent = warning;
      warningEl.style.cssText =
        "margin:0 0 var(--ha-space-6,24px);" +
        "font-weight:var(--ha-font-weight-medium,500);" +
        "line-height:var(--ha-line-height-normal,1.5)";
    }

    const actions = document.createElement("div");
    actions.style.cssText =
      "display:flex;justify-content:flex-end;gap:var(--ha-space-2,8px);flex-wrap:wrap";

    let done = false;
    const finish = (result: boolean) => {
      if (done) return;
      done = true;
      try {
        dlg.close();
      } catch {
        // jsdom / browsers without showModal: nothing to close.
      }
      dlg.remove();
      resolve(result);
    };

    const cancelBtn = document.createElement("ha-button");
    cancelBtn.setAttribute("appearance", "plain");
    cancelBtn.setAttribute("data-ga-cancel", "");
    cancelBtn.textContent = hass?.localize("ui.dialogs.generic.cancel") || "Cancel";
    cancelBtn.addEventListener("click", () => finish(false));

    const confirmBtn = document.createElement("ha-button");
    confirmBtn.setAttribute("appearance", "accent");
    confirmBtn.setAttribute("variant", "danger");
    confirmBtn.setAttribute("data-ga-confirm", "");
    confirmBtn.textContent = hass?.localize("ui.common.yes") || "Yes";
    confirmBtn.addEventListener("click", () => finish(true));

    actions.append(cancelBtn, confirmBtn);
    card.append(heading, body);
    if (warningEl) card.appendChild(warningEl);
    card.appendChild(actions);
    dlg.appendChild(card);
    // Escape fires "cancel" on a modal dialog; backdrop click targets the dialog.
    dlg.addEventListener("cancel", (e) => {
      e.preventDefault();
      finish(false);
    });
    dlg.addEventListener("click", (e) => {
      if (e.target === dlg) finish(false);
    });

    document.body.appendChild(dlg);
    if (typeof dlg.showModal === "function") {
      dlg.showModal();
    } else {
      dlg.setAttribute("open", ""); // jsdom / very old browsers
    }
  });
}

let _updatePromptShown = false;

// After a HACS update + HA restart, the browser may serve a stale cached
// frontend.js (HA's service worker holds the prior app shell). On version
// mismatch, post a one-time persistent notification pointing at a hard refresh
// (a soft reload just re-serves the cached shell).
function _maybePromptReload(serverVersion?: string): void {
  if (_updatePromptShown) return;
  // Can't compare without both versions (older backend, or no --define).
  if (!serverVersion || !BUILD_VERSION || serverVersion === BUILD_VERSION) return;
  _updatePromptShown = true;
  _info(
    "Frontend bundle is stale (running " + BUILD_VERSION + ", server has " +
      serverVersion + "); prompting reload",
  );

  try {
    const hass = getHass();
    if (!hass?.callService) return;
    hass.callService("persistent_notification", "create", {
      title: ASSISTANT_NAME,
      message: t("update_available"),
      notification_id: "hass_ga_manual_ui_update",
    });
  } catch (e) {
    _error("Failed to post update notification: " + _errorMessage(e));
  }
}

// Page-independent stale-bundle check: refreshCardState only runs on the
// Assistants page, so without this the reload prompt is invisible everywhere
// else. Waits for hass, then compares the installed version to BUILD_VERSION.
async function _checkVersionForReloadPrompt(): Promise<void> {
  if (!BUILD_VERSION) return;
  for (let i = 0; i < 60 && !_updatePromptShown; i++) {
    const hass = getHass();
    if (hass?.callWS) {
      try {
        const config = await _withEntryRetry((entryId) =>
          hass.callWS<{ version?: string }>({
            type: WS_GET_CONFIG,
            entry_id: entryId,
          }),
        );
        _maybePromptReload(config.version);
      } catch (e) {
        _debug("version check failed: " + (_errorMessage(e)));
      }
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
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
    // hass/themes may be unavailable
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

/** Our bundled brand icon, served locally (theme-aware). */
function getBrandIconUrl(): string {
  const variant = _isDarkMode() ? "dark_icon" : "icon";
  return `${BRAND_URL}/${variant}.png`;
}

/** Build our brand icon as a plain <img>, matching HA's .logo sizing (24px). */
function _buildManualIconImg(): HTMLImageElement {
  const img = document.createElement("img");
  img.dataset.gaManual = "1";
  img.alt = ASSISTANT_NAME;
  img.src = getBrandIconUrl();
  img.style.height = "24px";
  img.style.verticalAlign = "middle";
  img.onerror = () => _warn("Brand icon failed to load from " + getBrandIconUrl());
  return img;
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

let _primeStarted = false;

// Prime the voiceAssistants map so the expose page advertises us on first
// visit. Capture is normally passive (only on Object.keys), which the expose
// page never triggers. We trip it via a throwaway ha-filter-voice-assistants
// whose firstUpdated() runs Object.keys - requestUpdate is stubbed so it never
// renders.
function _primeVoiceAssistantsMap(): void {
  if (_voiceAssistantsMap) return;
  const PROBE = "ha-filter-voice-assistants";
  const cls = customElements.get(PROBE);
  if (!cls) {
    // Not loaded yet - retry once it is (e.g. when the filter pane first opens).
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

// Forget the cached entry_id so the next getEntryId() re-resolves it.
function _invalidateEntryId(): void {
  _entryId = null;
  _entryIdPromise = null;
}

// Run a WS call against the resolved entry_id; on a "config entry not found"
// error (e.g. the integration was deleted and re-added), drop the cached id,
// re-resolve, and retry once.
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

// True when a WS error indicates the entry_id no longer exists (e.g. after the
// integration was deleted and re-added while a stale id was cached).
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
          // booleans. Only capture/inject the former - matching expose settings
          // would pollute them and break the self-uninstall below.
          const conv = record.conversation;
          if (conv && typeof conv === "object" && "domain" in conv) {
            _voiceAssistantsMap = record;
            if (!(ASSISTANT_ID in record)) {
              record[ASSISTANT_ID] = { domain: "google_assistant", name: ASSISTANT_NAME };
              _info("Injected " + ASSISTANT_ID + " into voiceAssistants map");
            }
            _refreshExposePage();
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
          !this.includes(ASSISTANT_ID) &&
          // Wait for the map: HA renders a brand icon per id here and reads
          // voiceAssistants[id].name unguarded, so adding us first would throw.
          _voiceAssistantsMap !== null &&
          ASSISTANT_ID in _voiceAssistantsMap
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

// Advertise our id via the expose page's `_availableAssistants` getter, and wrap
// the dialog methods that need a guarded context. Must land before the page's
// first render: getAvailableAssistants() is memoizeOne, so a column built once
// without our id stays cached and our icon column never appears. Hence PATCHERS
// (synchronous define interceptor), not the async whenDefined path.
function _patchExposePageProto(proto: AssistantsPageElement): void {
  try {
    const protoRec = proto as unknown as Record<string, unknown> & {
      __gaExposePatched?: boolean;
    };
    if (protoRec.__gaExposePatched) return;

    const desc = Object.getOwnPropertyDescriptor(proto, "_availableAssistants");
    if (!desc || !desc.get) {
      _warn(
        "_availableAssistants getter not found on expose element. " +
          "HA may have renamed this property - exposure dropdown/table may not " +
          "include " + ASSISTANT_ID + ".",
      );
      return;
    }
    protoRec.__gaExposePatched = true;

    const orig = desc.get;
    let _safeExposeContext = false;

    Object.defineProperty(proto, "_availableAssistants", {
      configurable: true,
      get: function () {
        try {
          const result = orig.call(this) as string[];
          if (!Array.isArray(result)) return result;
          if (!_gaManualEnabled) {
            return result.filter((id) => id !== ASSISTANT_ID);
          }
          _primeVoiceAssistantsMap();
          const withUs = result.includes(ASSISTANT_ID)
            ? result
            : result.concat(ASSISTANT_ID);
          if (_safeExposeContext && !_voiceAssistantsMap) {
            return withUs.filter((id) => id !== ASSISTANT_ID);
          }
          return withUs;
        } catch (e) {
          _error("Error in _availableAssistants getter: " + (_errorMessage(e)));
          return orig.call(this);
        }
      },
    });

    const _wrapSafe = (name: string) => {
      const origFn = protoRec[name] as
        | ((this: unknown, ...args: unknown[]) => unknown)
        | undefined;
      if (typeof origFn !== "function") {
        _debug("Expose page method not found (may have been renamed): " + name);
        return;
      }
      protoRec[name] = function (this: unknown, ...args: unknown[]) {
        _safeExposeContext = true;
        try {
          return origFn.apply(this, args);
        } finally {
          _safeExposeContext = false;
        }
      };
    };
    _wrapSafe("_addEntry");
    _wrapSafe("_unexposeSelected");
    _wrapSafe("_exposeSelected");

    _debug("Patched expose page proto (_availableAssistants getter + dialog methods)");
  } catch (e) {
    _error("Failed to patch expose page proto: " + (_errorMessage(e)));
  }
}

// Heal an expose page already rendered before the PATCHERS proto patch landed
// (cached chunk that won the load race): force a re-render so the memoized
// column rebuilds with our id.
async function patchExposePage(): Promise<void> {
  try {
    await customElements.whenDefined("ha-config-voice-assistants-expose");
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

    try {
      _refreshOurIconElements(document.body || document.documentElement);
    } catch (e) {
      _debug("_refreshOurIconElements after expose heal failed: " + (_errorMessage(e)));
    }
  } catch (e) {
    _error("Failed to heal expose page: " + (_errorMessage(e)));
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

// Cache our brand icon node per element, refreshing its themed src on reuse.
function _manualBrandIconNode(el: VoiceAssistantBrandIcon): HTMLImageElement {
  let img = el.__gaIconNode;
  if (!img) {
    img = _buildManualIconImg();
    el.__gaIconNode = img;
  } else {
    img.src = getBrandIconUrl();
  }
  return img;
}

function _patchBrandIconProto(proto: VoiceAssistantBrandIcon): void {
  try {
    const origRender = proto.render;
    proto.render = function (this: VoiceAssistantBrandIcon) {
      // Our assistant always renders our self-hosted icon, never the brands CDN.
      if (this.voiceAssistantId === ASSISTANT_ID) {
        return _manualBrandIconNode(this);
      }
      try {
        return origRender!.call(this);
      } catch (e) {
        // HA's render reads voiceAssistants[id].name unguarded; on a missing
        // map entry it throws - fall back to our icon instead of an empty cell.
        _debug("brand-icon render fell back to local icon: " + _errorMessage(e));
        return _manualBrandIconNode(this);
      }
    };
  } catch (e) {
    _error("Failed to patch brand icon proto: " + (_errorMessage(e)));
  }
}

// Cache our expose-tab icon node (icon + tooltip) per element, rebuilding only
// when the props it depends on change (manual/unsupported/language).
function _manualExposeIconNode(el: ExposeAssistantIcon): HTMLElement {
  const localize = el.hass?.localize;
  const lang = el.hass?.locale?.language || el.hass?.language || "";
  const sig =
    (el.manual ? "m" : "") + "|" + (el.unsupported ? "u" : "") + "|" + lang;
  if (el.__gaExposeNode && el.__gaExposeSig === sig) return el.__gaExposeNode;

  const wrapper = document.createElement("div");
  wrapper.dataset.gaManual = "1";

  const containerId = ((el as unknown as HTMLElement).id || "ga") + "-" + ASSISTANT_ID;
  const container = document.createElement("div");
  container.className = "container";
  container.id = containerId;

  const icon = _buildManualIconImg();
  if (el.manual) icon.style.filter = "grayscale(100%)";
  container.appendChild(icon);

  if (el.unsupported) {
    const alertIcon = document.createElement("ha-icon");
    alertIcon.setAttribute("icon", "mdi:alert-circle");
    alertIcon.classList.add("unsupported");
    container.appendChild(alertIcon);
  }
  wrapper.appendChild(container);

  const tooltip = document.createElement("ha-tooltip");
  tooltip.setAttribute("for", containerId);
  tooltip.setAttribute("placement", "left");
  if (!el.unsupported && !el.manual) tooltip.setAttribute("disabled", "");

  if (el.unsupported) {
    tooltip.appendChild(
      document.createTextNode(
        localize
          ? localize("ui.panel.config.voice_assistants.expose.not_supported")
          : "",
      ),
    );
    if (el.manual) tooltip.appendChild(document.createElement("br"));
  }
  if (el.manual) {
    tooltip.appendChild(
      document.createTextNode(
        localize
          ? localize("ui.panel.config.voice_assistants.expose.manually_configured")
          : "",
      ),
    );
  }
  wrapper.appendChild(tooltip);

  el.__gaExposeNode = wrapper;
  el.__gaExposeSig = sig;
  return wrapper;
}

function _patchExposeAssistantIconProto(proto: ExposeAssistantIcon): void {
  try {
    const origRender = proto.render;
    proto.render = function (this: ExposeAssistantIcon) {
      if (this.assistant === ASSISTANT_ID) {
        return _manualExposeIconNode(this);
      }
      return origRender!.call(this);
    };
  } catch (e) {
    _error("Failed to patch expose assistant icon proto: " + (_errorMessage(e)));
  }
}

// Force re-render on stale icon elements whose instance rendered before
// our prototype patch was installed.
function _refreshOurIconElements(root: Node): void {
  if (root.nodeType !== 1 && root.nodeType !== 11) return;

  const el = root as HTMLElement;

  try {
    if (el.nodeName === "VOICE-ASSISTANT-BRAND-ICON") {
      const icon = el as unknown as VoiceAssistantBrandIcon;
      if (icon.voiceAssistantId === ASSISTANT_ID) {
        icon.requestUpdate?.();
      }
    } else if (el.nodeName === "VOICE-ASSISTANTS-EXPOSE-ASSISTANT-ICON") {
      const icon = el as unknown as ExposeAssistantIcon;
      if (icon.assistant === ASSISTANT_ID) {
        icon.requestUpdate?.();
      }
    }
  } catch {
    // best-effort
  }

  if (el.shadowRoot) {
    try {
      _refreshOurIconElements(el.shadowRoot);
    } catch {
      // skip broken shadow roots
    }
  }

  const children = el.children || el.childNodes || [];
  for (let i = 0; i < children.length; i++) {
    try {
      _refreshOurIconElements(children[i]);
    } catch {
      // skip problem children
    }
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
  _setOurUnsupported(el, false); // assume supported until told otherwise
  const hass = el.hass || getHass();
  if (!hass) return;
  hass
    .callWS<GaEntityInfo>({ type: WS_GET_ENTITY, entity_id: entityId })
    .then((info) => {
      if (el.__gaEntityId !== entityId) return; // entity changed meanwhile
      el.__gaInfo = info;
      _injectAskPin(el);
    })
    .catch((err: unknown) => {
      if (el.__gaEntityId !== entityId) return;
      // Retry recoverable failures (clear the marker); cache terminal ones as
      // null so unsupported entities don't re-fetch on every render.
      if (_is2faFetchRecoverable(err)) {
        el.__gaEntityId = undefined;
        return;
      }
      el.__gaInfo = null; // not supported / unknown - no checkbox
      if (_isNotSupported(err)) _setOurUnsupported(el, true);
      _injectAskPin(el);
    });
}

// Mark (or clear) our assistant in HA's `_unsupported` map so its render greys
// out our toggle and shows the "not supported" notice, matching cloud Google
// Assistant behaviour. Re-renders only when the flag changes.
function _setOurUnsupported(el: EntityVoiceSettingsElement, unsupported: boolean): void {
  const map = el._unsupported;
  if (!map) return;
  if (!!map[ASSISTANT_ID] === unsupported) return;
  if (unsupported) map[ASSISTANT_ID] = true;
  else delete map[ASSISTANT_ID];
  el.requestUpdate?.();
}

// True when a WS error matches the given code, or its message contains `substr`.
function _wsErrMatches(err: unknown, code: string, substr: string): boolean {
  const wsErr = err as WSError;
  if (wsErr && wsErr.code === code) return true;
  const msg = ((wsErr && (wsErr.message || wsErr.error)) || "").toLowerCase();
  return msg.includes(substr);
}

// Whether a get_entity failure means Google Assistant can't handle the entity.
function _isNotSupported(err: unknown): boolean {
  return _wsErrMatches(err, "not_supported", "not supported");
}

// Whether a failed get_entity 2FA fetch is worth retrying. Recoverable: the
// assistant was briefly disabled ("not enabled") or an internal server error.
// Not recoverable: the entity isn't supported by Google or no longer exists.
function _is2faFetchRecoverable(err: unknown): boolean {
  return _wsErrMatches(err, "internal_error", "not enabled");
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
      _error("Failed to update disable_2fa: " + _wsErrorMessage(err));
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

// Make the master "Expose" toggle and per-assistant rows account for us.
//
// render() builds `uiAssistants` (basis for `anyExposed`, which drives the
// master checked state) via `uiAssistants.splice(showAssistants.indexOf(<cloud
// id>), 1)` - run *after* that id left showAssistants, so indexOf is -1 and
// splice(-1, 1) drops the LAST entry (our injected id) instead.
//
// Fix: for the duration of render, return our id from Object.keys ahead of the
// cloud assistants, so HA's tail-dropping splice removes cloud ids and never
// reaches ours.
function _patchVoiceSettingsRender(proto: EntityVoiceSettingsElement): void {
  const origRender = proto.render;
  if (typeof origRender !== "function") {
    _debug("entity-voice-settings.render not found (HA may have renamed it)");
    return;
  }
  proto.render = function (this: EntityVoiceSettingsElement) {
    const origKeys = Object.keys;
    Object.keys = function (obj: object): string[] {
      const keys = origKeys(obj);
      // Match only the voiceAssistants map: { domain, name } descriptors that
      // include our id - never the per-entity expose settings (booleans).
      const conv = (obj as Record<string, unknown>).conversation;
      if (
        _gaManualEnabled &&
        conv &&
        typeof conv === "object" &&
        "domain" in conv &&
        keys.includes(ASSISTANT_ID)
      ) {
        return [
          ...keys.filter((k) => !k.startsWith("cloud.")),
          ...keys.filter((k) => k.startsWith("cloud.")),
        ];
      }
      return keys;
    };
    try {
      return origRender.call(this);
    } finally {
      Object.keys = origKeys;
    }
  };
}

// Settle expose writes before HA refetches the entity.
//
// HA's _toggleAll / _toggleAssistant fire exposeEntities() WS writes without
// awaiting, then immediately refetch the entry to refresh toggles - a race that
// leaves stale toggles until the dialog reopens. Pre-await an identical write so
// the refetch sees the new state; the original re-issues the idempotent write.
//
// The original re-reads ev.target when it runs, but after our await the reactive
// props are reset by the intervening re-render. Snapshot them synchronously and
// hand the original a synthetic event carrying the snapshot.
function _patchToggleRefresh(
  proto: EntityVoiceSettingsElement,
  method: "_toggleAll" | "_toggleAssistant",
): void {
  const protoRec = proto as unknown as Record<string, unknown>;
  const orig = protoRec[method] as
    | ((this: EntityVoiceSettingsElement, ev: Event) => unknown)
    | undefined;
  if (typeof orig !== "function") {
    _debug("entity-voice-settings." + method + " not found (HA may have renamed it)");
    return;
  }
  if ((orig as { __gaWrapped?: boolean }).__gaWrapped) return; // already patched

  const wrapped = async function (this: EntityVoiceSettingsElement, ev: Event) {
    const t = ev.target as {
      checked?: boolean;
      assistants?: string[];
      assistant?: string;
    } | null;
    const snapshot = {
      checked: t?.checked,
      assistants: t?.assistants ? [...t.assistants] : t?.assistants,
      assistant: t?.assistant,
    };
    try {
      const hass = this.hass || getHass();
      const entityId = this.entityId;
      if (hass && entityId) {
        const expose = !!snapshot.checked;
        const assistants =
          method === "_toggleAll"
            ? expose
              ? (snapshot.assistants || []).filter((k) => !this._unsupported?.[k])
              : snapshot.assistants || []
            : snapshot.assistant != null
              ? [snapshot.assistant]
              : [];
        if (assistants.length) {
          await hass.callWS({
            type: "homeassistant/expose_entity",
            assistants,
            entity_ids: [entityId],
            should_expose: expose,
          });
        }
      }
    } catch (e) {
      _debug("Pre-await expose write failed (" + method + "): " + _errorMessage(e));
    }
    return orig.call(this, { target: snapshot } as unknown as Event);
  };
  (wrapped as { __gaWrapped?: boolean }).__gaWrapped = true;
  protoRec[method] = wrapped;
}

function _patchEntityVoiceSettingsProto(proto: EntityVoiceSettingsElement): void {
  try {
    _patchVoiceSettingsRender(proto);
    _patchToggleRefresh(proto, "_toggleAll");
    _patchToggleRefresh(proto, "_toggleAssistant");
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

// Refresh the expose-tab dialog's toggles after a change. dialog-voice-settings
// (stock HA) hands entity-voice-settings a static `exposed` snapshot and never
// updates it, so we recompute from the entity on entity-entry-updated.
function _patchVoiceSettingsDialogProto(proto: HTMLElement & LitLifecycle): void {
  const protoRec = proto as unknown as Record<string, unknown>;
  const orig = protoRec._entityEntryUpdated as
    | ((this: unknown, ev: CustomEvent) => void)
    | undefined;
  if (typeof orig !== "function") {
    _debug("dialog-voice-settings._entityEntryUpdated not found (HA may have renamed it)");
    return;
  }
  if ((orig as { __gaWrapped?: boolean }).__gaWrapped) return;

  const wrapped = function (this: Record<string, unknown>, ev: CustomEvent) {
    orig.call(this, ev);
    try {
      const params = this._params as
        | { exposed?: Record<string, unknown> }
        | undefined;
      const entry = ev.detail as
        | { options?: Record<string, { should_expose?: boolean } | undefined> }
        | undefined;
      if (params && entry) {
        const keys = _voiceAssistantsMap
          ? Object.keys(_voiceAssistantsMap)
          : Object.keys(entry.options || {});
        const exposed: Record<string, boolean | undefined> = {};
        for (const key of keys) {
          exposed[key] = entry.options?.[key]?.should_expose;
        }
        this._params = { ...params, exposed };
      }
    } catch (e) {
      _debug("Failed to refresh dialog exposed: " + _errorMessage(e));
    }
  };
  (wrapped as { __gaWrapped?: boolean }).__gaWrapped = true;
  protoRec._entityEntryUpdated = wrapped;
}

type ProtoPatcher = (proto: HTMLElement & LitLifecycle) => void;

const PATCHERS: Record<string, ProtoPatcher> = {
  "ha-config-voice-assistants-assistants": _patchAssistantsPageProto as ProtoPatcher,
  "ha-config-voice-assistants-expose": _patchExposePageProto as ProtoPatcher,
  "voice-assistant-brand-icon": _patchBrandIconProto as ProtoPatcher,
  "voice-assistants-expose-assistant-icon": _patchExposeAssistantIconProto as ProtoPatcher,
  "entity-voice-settings": _patchEntityVoiceSettingsProto as ProtoPatcher,
  "dialog-voice-settings": _patchVoiceSettingsDialogProto as ProtoPatcher,
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
// injectCardInto is idempotent - safe at any lifecycle stage.
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

// Build the GA Manual settings card: header with brand icon + enable switch,
// settings rows for expose-new, report-state, and secure-devices PIN.
function buildCard(): HTMLElement | null {
  try {
    const hass = getHass();

    ensureTranslationsLoaded(); // hass is reliably available here

    const brandIcon = _buildManualIconImg();
    brandIcon.style.height = "28px";
    brandIcon.style.marginRight = "16px";
    brandIcon.style.marginInlineEnd = "16px";
    brandIcon.style.marginInlineStart = "initial";

    const card = document.createElement("ha-card");
    card.setAttribute("outlined", "");
    card.setAttribute("data-ga-manual-card", "1");

    const header = document.createElement("h1");
    header.className = "card-header";
    header.style.cssText = "display:flex;align-items:center;line-height:normal";
    header.appendChild(brandIcon);
    const titleText = document.createElement("span");
    titleText.textContent = ASSISTANT_NAME;
    titleText.style.cssText = "flex:1;min-width:0;overflow-wrap:anywhere";
    header.appendChild(titleText);
    card.appendChild(header);

    const headerActions = document.createElement("div");
    headerActions.style.cssText =
      "flex-shrink:0;margin-left:16px;margin-inline-start:16px;margin-inline-end:initial;display:flex;flex-direction:row;align-items:center";
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

    const exportBtn = document.createElement("ha-button");
    exportBtn.setAttribute("appearance", "plain");
    exportBtn.textContent = t("export_yaml");
    exportBtn.addEventListener("click", () => void _onExportClick());
    _retranslate.push(() => {
      exportBtn.textContent = t("export_yaml");
    });
    actions.appendChild(exportBtn);

    const importBtn = document.createElement("ha-button");
    importBtn.setAttribute("appearance", "plain");
    importBtn.textContent = t("import_yaml");
    importBtn.addEventListener("click", () => void _onImportClick());
    _retranslate.push(() => {
      importBtn.textContent = t("import_yaml");
    });
    actions.appendChild(importBtn);

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

  try {
    await _withEntryRetry(async (entryId) => {
      _info(
        config.action.charAt(0).toUpperCase() + config.action.slice(1) +
          " Google Assistant for entry_id=" + entryId,
      );
      await hass.callWS({ type: config.wsType, entry_id: entryId });
    });

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
  const hass = getHass();
  if (!hass) {
    _debug("refreshCardState: Home Assistant not loaded yet, will retry on next render");
    return;
  }

  try {
    const config = await _withEntryRetry((entryId) =>
      hass.callWS<{
        enabled: boolean;
        yaml_suppressed: boolean;
        report_state: boolean;
        secure_devices_pin: string;
        version?: string;
      }>({
        type: WS_GET_CONFIG,
        entry_id: entryId,
      }),
    );

    _debug(
      "refreshCardState received config: enabled=" +
        config.enabled +
        " report_state=" +
        config.report_state,
    );

    _maybePromptReload(config.version);

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
}

// Inject the card into a ha-config-voice-assistants-assistants element.
// Idempotent - safe to call at any time (lifecycle hooks, DOM scans, observers).
function injectCardInto(el: AssistantsPageElement): void {
  if (!el) return;

  try {
    const root = el.shadowRoot || (el as unknown as HTMLElement);
    const content = root.querySelector<HTMLElement>(".content");
    if (!content) {
      // Page shows <hass-loading-screen> (no .content) until hass is set; wait
      // for it rather than bailing, or a mid-load scan would never inject.
      if (!_observerActive.has(el)) {
        _observerActive.add(el);
        _debug("injectCardInto: no .content yet, waiting for render of " + el.nodeName);
        const obs = new MutationObserver(() => {
          if (root.querySelector(".content")) {
            obs.disconnect();
            _observerActive.delete(el);
            injectCardInto(el);
          }
        });
        obs.observe(root, { childList: true, subtree: true });
      }
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

// Recursively search a DOM tree (including all shadow roots) for
// ha-config-voice-assistants-assistants elements.
function findAllAssistantsElements(root: Node | null): AssistantsPageElement[] {
  const results: AssistantsPageElement[] = [];
  if (!root) return results;
  if (root.nodeType !== 1 && root.nodeType !== 11) return results;

  if (root instanceof HTMLElement && root.nodeName === "HA-CONFIG-VOICE-ASSISTANTS-ASSISTANTS") {
    results.push(root as unknown as AssistantsPageElement);
  }

  const el = root as HTMLElement;
  const shadowRoot = el.shadowRoot;
  if (shadowRoot) {
    try {
      results.push(...findAllAssistantsElements(shadowRoot));
    } catch (e) {
      _debug(
        "Could not traverse shadowRoot of " +
          el.nodeName +
          ": " +
          (_errorMessage(e)),
      );
    }
  }

  try {
    const children = el.children || el.childNodes || [];
    for (let i = 0; i < children.length; i++) {
      try {
        results.push(...findAllAssistantsElements(children[i]));
      } catch {
        // skip problem children
      }
    }
  } catch {
    // children access may fail on some nodes
  }

  return results;
}

// Scan the entire DOM (including all shadow roots) for assistants page
// elements and inject the card into each.
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
  // matched as the first ha-switch - clobbering it back to expose_new (false).
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
      _error("Failed to refresh expose toggle: " + _wsErrorMessage(err));
    });
}

function onExposeToggle(e: Event): void {
  const hass = getHass();
  if (!hass) return;
  const target = e.target as TogglableElement;
  const checked = target.checked;
  hass
    .callWS({
      type: "homeassistant/expose_new_entities/set",
      assistant: ASSISTANT_ID,
      expose_new: checked,
    })
    .catch((err: WSError) => {
      _error("Failed to set expose_new_entities: " + _wsErrorMessage(err));
      target.checked = !checked;
    });
}

async function onReportStateToggle(e: Event): Promise<void> {
  const hass = getHass();
  if (!hass) return;
  const target = e.target as TogglableElement;
  const checked = target.checked;

  try {
    await _withEntryRetry((entryId) =>
      hass.callWS({
        type: WS_UPDATE_CONFIG,
        entry_id: entryId,
        data: { report_state: checked },
      }),
    );
  } catch (err: unknown) {
    _error("Failed to update report_state: " + _wsErrorMessage(err));
    target.checked = !checked;
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
    const config = await _withEntryRetry((entryId) =>
      hass.callWS<{ secure_devices_pin: string }>({
        type: WS_GET_CONFIG,
        entry_id: entryId,
      }),
    );
    input.value = config.secure_devices_pin || "";
  } catch {
    // best-effort revert
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
// SPA navigation - route changes swap panels inside shadow DOM, invisible to
// the document MutationObserver, so re-scan on HA's nav events. The destination
// mounts async, so retry briefly; the scan is idempotent.
// ---------------------------------------------------------------------------

const _NAV_SCAN_RETRIES = 6;
const _NAV_SCAN_INTERVAL_MS = 200;

function _scanAfterNavigation(): void {
  let tries = 0;
  const tick = (): void => {
    try {
      injectIntoAllAssistantsElements();
      _primeVoiceAssistantsMap();
      _refreshOurIconElements(document.body || document.documentElement);
    } catch (e) {
      _debug("post-navigation scan failed: " + (_errorMessage(e)));
    }
    if (++tries < _NAV_SCAN_RETRIES) {
      setTimeout(tick, _NAV_SCAN_INTERVAL_MS);
    }
  };
  tick();
}

// ---------------------------------------------------------------------------
// Init - DOM-dependent setup: inject cards, start observers, nav listeners.
// ---------------------------------------------------------------------------

function init(): void {
  // Fallback for elements defined AND rendered before our module evaluated
  // (a cached panel chunk that won the load race); patched instances already
  // render our icon directly.
  try {
    _refreshOurIconElements(document.body || document.documentElement);
  } catch (e) {
    _error("_refreshOurIconElements threw: " + (_errorMessage(e)));
  }

  // No-op until hass is available; buildCard retries.
  ensureTranslationsLoaded();

  _banner(t("ready_banner", { name: ASSISTANT_NAME }));

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

  // Re-inject after SPA navigation (see _scanAfterNavigation).
  try {
    window.addEventListener("location-changed", _scanAfterNavigation);
    window.addEventListener("popstate", _scanAfterNavigation);
    _debug("Navigation listeners active (location-changed, popstate)");
  } catch (e) {
    _error("Failed to add navigation listeners: " + (_errorMessage(e)));
  }

  // Flag a stale bundle regardless of which page is open.
  try {
    _checkVersionForReloadPrompt();
  } catch (e) {
    _error("_checkVersionForReloadPrompt threw: " + (_errorMessage(e)));
  }

  _info("Init complete - DOM-dependent setup applied");
}

// ---------------------------------------------------------------------------
// Prototype / interceptor patches
//
// Rewrite global hooks and custom-element prototypes (no DOM body needed).
// Must run at module-eval time, not DOMContentLoaded: if HA's lazy voice-
// assistants chunk defines its elements first, an icon can render once with
// HA's stock render() before our override lands, leaving a blank icon cell.
// ---------------------------------------------------------------------------

let _prototypePatchesInstalled = false;
function installPrototypePatches(): void {
  if (_prototypePatchesInstalled) return;
  _prototypePatchesInstalled = true;

  // Apply each patch independently - one failing does not block the rest.
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
  // Async; self-defers via customElements.whenDefined until the element exists.
  try {
    patchExposePage();
  } catch (e) {
    _error("patchExposePage threw: " + (_errorMessage(e)));
  }
}

installPrototypePatches();

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
