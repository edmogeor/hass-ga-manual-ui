"use strict";
(() => {
  // frontend.ts
  var ASSISTANT_ID = "hass_ga_manual_ui";
  var ASSISTANT_NAME = "Google Assistant (Manual)";
  var SORT_TARGET = ["conversation", "cloud.alexa", "cloud.google_assistant"];
  var BRANDS_CDN = "https://brands.home-assistant.io";
  var BRAND_DOMAIN = "google_assistant";
  var WS_GET_ENTRY_ID = `${ASSISTANT_ID}/get_entry_id`;
  var WS_GET_CONFIG = `${ASSISTANT_ID}/get_config`;
  var WS_UPDATE_CONFIG = `${ASSISTANT_ID}/update_config`;
  var WS_ENABLE = `${ASSISTANT_ID}/enable`;
  var WS_DISABLE = `${ASSISTANT_ID}/disable`;
  var WS_GET_ENTITY = `${ASSISTANT_ID}/get_entity`;
  var WS_UPDATE_ENTITY = `${ASSISTANT_ID}/update_entity`;
  var BUILD_VERSION = true ? "0.1.3" : "";
  var EN_STRINGS = {
    yaml_detected: "The <code>google_assistant:</code> section was detected in your <code>configuration.yaml</code> and has been disabled. This integration now manages your Google Assistant configuration. You can safely remove the <code>google_assistant:</code> section from your YAML configuration.",
    enable_success: "Google Assistant enabled successfully",
    enable_failed: "Failed to enable Google Assistant.",
    enable_fail_hint: "Try reloading the integration from Settings \u2192 Devices & Services.",
    disable_success: "Google Assistant disabled successfully",
    disable_failed: "Failed to disable Google Assistant.",
    disable_fail_hint: "Try removing the integration from Settings \u2192 Devices & Services.",
    check_logs: "Check Home Assistant logs for details.",
    report_state_enable_failed: "Failed to enable state reporting. Try toggling the integration off and on, or check Home Assistant logs.",
    report_state_disable_failed: "Failed to disable state reporting. Try toggling the integration off and on, or check Home Assistant logs.",
    ready_banner: "{name} is ready \u2014 manage it under Settings \u2192 Voice assistants.",
    update_available: "A new version of Google Assistant (Manual) is available. Refresh your browser (Ctrl+Shift+R, or Cmd+Shift+R on Mac) to load it."
  };
  var _loadedStrings = {};
  var _translationsPromise = null;
  var _retranslate = [];
  function t(key, args) {
    let str = _loadedStrings[key] ?? EN_STRINGS[key];
    if (args) {
      for (const name of Object.keys(args)) {
        str = str.split("{" + name + "}").join(String(args[name]));
      }
    }
    return str;
  }
  function ensureTranslationsLoaded() {
    if (_translationsPromise) return _translationsPromise;
    const hass = getHass();
    if (!hass?.callWS) return Promise.resolve();
    const language = hass.locale?.language || hass.language || "en";
    const prefix = `component.${ASSISTANT_ID}.frontend.`;
    _translationsPromise = hass.callWS({
      type: "frontend/get_translations",
      language,
      category: "frontend",
      integration: ASSISTANT_ID
    }).then(({ resources }) => {
      const loaded = {};
      for (const key of Object.keys(EN_STRINGS)) {
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
    }).catch((e) => {
      _debug("Failed to load frontend translations: " + _errorMessage(e));
    });
    return _translationsPromise;
  }
  function _errorMessage(e) {
    if (e instanceof Error) return e.message;
    return String(e);
  }
  function _wsErrorMessage(err) {
    const wsErr = err;
    return wsErr.message || wsErr.error || wsErr.code || String(err);
  }
  var _entryId = null;
  var _entryIdPromise = null;
  var _gaManualEnabled = true;
  var _voiceAssistantsMap = null;
  var _DEBUG = false;
  try {
    _DEBUG = typeof localStorage !== "undefined" && !!localStorage.getItem("gaManualDebug") || typeof location !== "undefined" && /[?&#]gaManualDebug\b/.test(location.search + location.hash);
  } catch {
  }
  function _forwardToHaLog(level, message) {
    try {
      const hass = getHass();
      if (!hass || !hass.callService) return;
      hass.callService("system_log", "write", {
        message,
        level: level === "warn" ? "warning" : level,
        logger: "hass_ga_manual_ui.frontend"
      });
    } catch {
    }
  }
  function _log(level, message, data) {
    const isProblem = level === "warn" || level === "error";
    if (_DEBUG || isProblem) {
      const prefixed = "[GA Manual] " + message;
      try {
        if (data !== void 0) {
          console[level](prefixed, data);
        } else {
          console[level](prefixed);
        }
      } catch {
      }
    }
    if (isProblem) _forwardToHaLog(level, message);
  }
  function _debug(msg, data) {
    _log("debug", msg, data);
  }
  function _info(msg, data) {
    _log("info", msg, data);
  }
  function _warn(msg, data) {
    _log("warn", msg, data);
  }
  function _error(msg, data) {
    _log("error", msg, data);
  }
  var _bannerForwarded = false;
  function _banner(message) {
    try {
      console.info(message);
    } catch {
    }
    if (!_bannerForwarded) {
      _bannerForwarded = true;
      _forwardToHaLog("info", message);
    }
  }
  function _showToast(message, isError) {
    try {
      const hass = getHass();
      if (!hass || !hass.callService) return;
      hass.callService("persistent_notification", "create", {
        title: ASSISTANT_NAME + (isError ? " \u2014 Error" : " \u2014 Notice"),
        message,
        notification_id: "hass_ga_manual_ui_notification"
      });
    } catch (e) {
      _error("Failed to show toast: " + _errorMessage(e));
    }
  }
  var _updatePromptShown = false;
  function _maybePromptReload(serverVersion) {
    if (_updatePromptShown) return;
    if (!serverVersion || !BUILD_VERSION || serverVersion === BUILD_VERSION) return;
    _updatePromptShown = true;
    _info(
      "Frontend bundle is stale (running " + BUILD_VERSION + ", server has " + serverVersion + "); prompting reload"
    );
    const message = t("update_available");
    try {
      const ha = document.querySelector("home-assistant");
      if (ha) {
        const reloadLabel = getHass()?.localize?.("ui.common.refresh") || "Reload";
        ha.dispatchEvent(
          new CustomEvent("hass-notification", {
            bubbles: true,
            composed: true,
            detail: {
              message,
              duration: 0,
              action: { text: reloadLabel, action: () => location.reload() }
            }
          })
        );
        return;
      }
    } catch (e) {
      _debug("hass-notification toast failed, falling back: " + _errorMessage(e));
    }
    _showToast(message, false);
  }
  function _isDarkMode() {
    try {
      const dm = getHass()?.themes?.darkMode;
      if (typeof dm === "boolean") return dm;
    } catch {
    }
    try {
      return typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches;
    } catch {
      return false;
    }
  }
  function getBrandIconUrl() {
    const variant = _isDarkMode() ? "dark_icon" : "icon";
    return `${BRANDS_CDN}/${BRAND_DOMAIN}/${variant}.png`;
  }
  function getHass() {
    const homeAssistant = document.querySelector("home-assistant");
    return homeAssistant?.hass;
  }
  function getEntryId() {
    if (_entryId) return Promise.resolve(_entryId);
    if (_entryIdPromise) return _entryIdPromise;
    _entryIdPromise = _fetchEntryId().then(
      (id) => {
        _entryId = id;
        _entryIdPromise = null;
        _debug("Resolved entry_id=" + id);
        return id;
      },
      (err) => {
        _entryIdPromise = null;
        throw err;
      }
    );
    return _entryIdPromise;
  }
  var _primeStarted = false;
  function _primeVoiceAssistantsMap() {
    if (_voiceAssistantsMap) return;
    const PROBE = "ha-filter-voice-assistants";
    const cls = customElements.get(PROBE);
    if (!cls) {
      if (!_primeStarted) {
        _primeStarted = true;
        customElements.whenDefined(PROBE).then(() => _primeVoiceAssistantsMap()).catch(() => void 0);
      }
      return;
    }
    try {
      const probe = new cls();
      probe.requestUpdate = () => void 0;
      probe.firstUpdated?.(/* @__PURE__ */ new Map());
      if (_voiceAssistantsMap) {
        _info("Primed voiceAssistants map proactively (expose page)");
        _refreshExposePage();
      }
    } catch (e) {
      _debug("Could not prime voiceAssistants map: " + _errorMessage(e));
    }
  }
  function _invalidateEntryId() {
    _entryId = null;
    _entryIdPromise = null;
  }
  async function _withEntryRetry(fn) {
    try {
      return await fn(await getEntryId());
    } catch (err) {
      if (!_isEntryGoneError(err)) throw err;
      _warn("Cached entry_id was stale; re-resolving and retrying");
      _invalidateEntryId();
      return await fn(await getEntryId());
    }
  }
  function _isEntryGoneError(err) {
    const wsErr = err;
    if (wsErr && wsErr.code === "not_found") return true;
    const msg = (wsErr && wsErr.message || "").toLowerCase();
    return msg.includes("config entry not found") || msg.includes("not_found");
  }
  async function _fetchEntryId() {
    const hass = getHass();
    if (!hass) {
      const err = new Error(
        "Home Assistant not yet loaded. The Google Assistant (Manual) card will retry when the page finishes loading."
      );
      _warn(err.message);
      throw err;
    }
    _debug("Fetching entry_id via WS");
    try {
      const result = await hass.callWS({
        type: WS_GET_ENTRY_ID
      });
      if (!result || !result.entry_id) {
        throw new Error(
          "Server returned no entry_id. The integration must be added via Settings \u2192 Devices & Services \u2192 Add Integration first."
        );
      }
      return result.entry_id;
    } catch (err) {
      _error(
        "Failed to get entry_id from server: " + _wsErrorMessage(err) + ". Add the integration via Settings \u2192 Devices & Services \u2192 Add Integration \u2192 Google Assistant (Manual)."
      );
      throw err;
    }
  }
  function patchVoiceAssistants() {
    try {
      const origKeys = Object.keys;
      Object.keys = function(obj) {
        try {
          if (obj && typeof obj === "object" && !Array.isArray(obj) && "conversation" in obj && "cloud.alexa" in obj && "cloud.google_assistant" in obj) {
            const record = obj;
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
  function patchSortKey() {
    try {
      const origForEach = Array.prototype.forEach;
      Array.prototype.forEach = function(callback, thisArg) {
        try {
          if (this.length === SORT_TARGET.length && SORT_TARGET.every((v, i) => this[i] === v) && !this.includes(ASSISTANT_ID)) {
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
  function findExposeElement(root) {
    if (!root) return null;
    if (root.nodeType !== 1 && root.nodeType !== 11) return null;
    if (root instanceof HTMLElement && root.nodeName === "HA-CONFIG-VOICE-ASSISTANTS-EXPOSE") {
      return root;
    }
    const shadowRoot = root.shadowRoot;
    if (shadowRoot) {
      const found = findExposeElement(shadowRoot);
      if (found) return found;
    }
    const children = root.children || [];
    for (let i = 0; i < children.length; i++) {
      const found = findExposeElement(children[i]);
      if (found) return found;
    }
    return null;
  }
  async function patchExposePage() {
    try {
      await customElements.whenDefined("ha-config-voice-assistants-expose");
      const cls = customElements.get("ha-config-voice-assistants-expose");
      if (!cls) {
        _warn(
          "ha-config-voice-assistants-expose element not found. The expose page may not have been loaded yet. The patch will be attempted when the element first renders."
        );
        return;
      }
      const desc = Object.getOwnPropertyDescriptor(cls.prototype, "_availableAssistants");
      if (!desc || !desc.get) {
        _warn(
          "_availableAssistants getter not found on expose element. HA may have renamed this property \u2014 exposure dropdown may not include " + ASSISTANT_ID + "."
        );
        return;
      }
      const orig = desc.get;
      let _safeExposeContext = false;
      Object.defineProperty(cls.prototype, "_availableAssistants", {
        get: function() {
          try {
            const result = orig.call(this);
            if (!Array.isArray(result)) return result;
            if (!_gaManualEnabled) {
              return result.filter((id) => id !== ASSISTANT_ID);
            }
            _primeVoiceAssistantsMap();
            const withUs = result.includes(ASSISTANT_ID) ? result : result.concat(ASSISTANT_ID);
            if (_safeExposeContext && !_voiceAssistantsMap) {
              return withUs.filter((id) => id !== ASSISTANT_ID);
            }
            return withUs;
          } catch (e) {
            _error("Error in _availableAssistants getter: " + _errorMessage(e));
            return orig.call(this);
          }
        }
      });
      _debug("Patch 3/4 applied: expose page (_availableAssistants getter)");
      const _wrapSafe = (name) => {
        const proto = cls.prototype;
        const origFn = proto[name];
        if (typeof origFn !== "function") {
          _debug("Expose page method not found (may have been renamed): " + name);
          return;
        }
        proto[name] = function(...args) {
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
      _debug("Patched expose page dialog methods (_addEntry / _unexposeSelected / _exposeSelected)");
      _primeVoiceAssistantsMap();
      const el = document.querySelector("ha-config-voice-assistants-expose") || findExposeElement(document.documentElement);
      if (el) {
        try {
          el.requestUpdate?.();
        } catch (e) {
          _debug("requestUpdate failed: " + _errorMessage(e));
        }
      }
    } catch (e) {
      _error("Failed to apply patch 3/4 (expose page): " + _errorMessage(e));
    }
  }
  function _patchAssistantsPageProto(proto) {
    try {
      const origConnected = proto.connectedCallback;
      const origFirstUpdated = proto.firstUpdated;
      const origUpdated = proto.updated;
      proto.connectedCallback = function() {
        try {
          if (origConnected) origConnected.call(this);
        } catch (e) {
          _error("Error in original connectedCallback: " + _errorMessage(e));
        }
        requestAnimationFrame(() => {
          try {
            injectCardInto(this);
          } catch (e) {
            _error("Error injecting card in connectedCallback: " + _errorMessage(e));
          }
        });
      };
      proto.firstUpdated = function(changedProps) {
        try {
          origFirstUpdated.call(this, changedProps);
        } catch (e) {
          _error("Error in original firstUpdated: " + _errorMessage(e));
        }
        try {
          injectCardInto(this);
        } catch (e) {
          _error("Error injecting card in firstUpdated: " + _errorMessage(e));
        }
      };
      proto.updated = function(changedProps) {
        try {
          origUpdated.call(this, changedProps);
        } catch (e) {
          _error("Error in original updated: " + _errorMessage(e));
        }
        try {
          injectCardInto(this);
        } catch (e) {
          _error("Error injecting card in updated: " + _errorMessage(e));
        }
      };
    } catch (e) {
      _error("Failed to patch assistants page proto: " + _errorMessage(e));
    }
  }
  function _renderManualBrandIcon() {
    try {
      const root = this.shadowRoot || this;
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
      _error("Error rendering manual brand icon: " + _errorMessage(e));
    }
  }
  function _patchBrandIconProto(proto) {
    try {
      const origRender = proto.render;
      const origFirstUpdated = proto.firstUpdated;
      const origUpdated = proto.updated;
      proto.render = function() {
        if (this.voiceAssistantId === ASSISTANT_ID) return null;
        return origRender.call(this);
      };
      proto.firstUpdated = function(changedProps) {
        if (this.voiceAssistantId === ASSISTANT_ID) {
          _renderManualBrandIcon.call(this);
        } else {
          origFirstUpdated.call(this, changedProps);
        }
      };
      proto.updated = function(changedProps) {
        if (this.voiceAssistantId === ASSISTANT_ID) {
          _renderManualBrandIcon.call(this);
        } else {
          origUpdated.call(this, changedProps);
        }
      };
    } catch (e) {
      _error("Failed to patch brand icon proto: " + _errorMessage(e));
    }
  }
  function _renderManualExposeIcon() {
    try {
      const root = this.shadowRoot || this;
      if (root.querySelector("[data-ga-manual]")) return;
      root.innerHTML = "";
      const containerId = (this.id || "ga") + "-" + ASSISTANT_ID;
      const container = document.createElement("div");
      container.className = "container";
      container.id = containerId;
      container.dataset.gaManual = "1";
      const icon = document.createElement("voice-assistant-brand-icon");
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
            localize ? localize("ui.panel.config.voice_assistants.expose.not_supported") : ""
          )
        );
        if (this.manual) tooltip.appendChild(document.createElement("br"));
      }
      if (this.manual) {
        tooltip.appendChild(
          document.createTextNode(
            localize ? localize("ui.panel.config.voice_assistants.expose.manually_configured") : ""
          )
        );
      }
      root.appendChild(tooltip);
    } catch (e) {
      _error("Error rendering manual expose icon: " + _errorMessage(e));
    }
  }
  function _patchExposeAssistantIconProto(proto) {
    try {
      const origRender = proto.render;
      const origFirstUpdated = proto.firstUpdated;
      const origUpdated = proto.updated;
      proto.render = function() {
        if (this.assistant === ASSISTANT_ID) return null;
        return origRender.call(this);
      };
      proto.firstUpdated = function(changedProps) {
        if (this.assistant === ASSISTANT_ID) {
          _renderManualExposeIcon.call(this);
        } else {
          origFirstUpdated.call(this, changedProps);
        }
      };
      proto.updated = function(changedProps) {
        if (this.assistant === ASSISTANT_ID) {
          _renderManualExposeIcon.call(this);
        } else {
          origUpdated.call(this, changedProps);
        }
      };
    } catch (e) {
      _error("Failed to patch expose assistant icon proto: " + _errorMessage(e));
    }
  }
  function _maybeFetchEntity2fa(el) {
    const entityId = el.entityId;
    if (!entityId) return;
    if (el.__gaEntityId === entityId) return;
    el.__gaEntityId = entityId;
    el.__gaInfo = void 0;
    const hass = el.hass || getHass();
    if (!hass) return;
    hass.callWS({ type: WS_GET_ENTITY, entity_id: entityId }).then((info) => {
      if (el.__gaEntityId !== entityId) return;
      el.__gaInfo = info;
      _injectAskPin(el);
    }).catch(() => {
      if (el.__gaEntityId !== entityId) return;
      el.__gaInfo = null;
      _injectAskPin(el);
    });
  }
  function _findOurAssistantRow(root) {
    const items = root.querySelectorAll("ha-md-list-item");
    for (let i = 0; i < items.length; i++) {
      const icon = items[i].querySelector(
        "voice-assistant-brand-icon"
      );
      if (icon && icon.voiceAssistantId === ASSISTANT_ID) return items[i];
    }
    return null;
  }
  function _onAskPinChanged(el, cb) {
    const hass = el.hass || getHass();
    const entityId = el.entityId;
    if (!hass || !entityId) return;
    const checked = cb.checked;
    hass.callWS({ type: WS_UPDATE_ENTITY, entity_id: entityId, disable_2fa: !checked }).then(() => {
      if (el.__gaInfo) el.__gaInfo.disable_2fa = !checked;
    }).catch((err) => {
      _error("Failed to update disable_2fa: " + _wsErrorMessage(err));
      cb.checked = !checked;
    });
  }
  function _injectAskPin(el) {
    try {
      const root = el.shadowRoot;
      if (!root) return;
      const row = _findOurAssistantRow(root);
      if (!row) return;
      const info = el.__gaInfo;
      const existingAll = row.querySelectorAll("[data-ga-2fa]");
      if (!info || !info.might_2fa) {
        existingAll.forEach((el2) => el2.remove());
        return;
      }
      if (existingAll.length > 0) {
        for (let i = 1; i < existingAll.length; i++) existingAll[i].remove();
        existingAll[0].checked = !info.disable_2fa;
        return;
      }
      const hass = el.hass || getHass();
      const cb = document.createElement("ha-checkbox");
      cb.setAttribute("slot", "supporting-text");
      cb.setAttribute("data-ga-2fa", "1");
      cb.checked = !info.disable_2fa;
      cb.textContent = hass && hass.localize("ui.dialogs.voice-settings.ask_pin") || "Ask for PIN";
      cb.addEventListener("change", () => _onAskPinChanged(el, cb));
      row.appendChild(cb);
    } catch (e) {
      _error("Error injecting ask_pin checkbox: " + _errorMessage(e));
    }
  }
  function _patchEntityVoiceSettingsProto(proto) {
    try {
      const origFirstUpdated = proto.firstUpdated;
      const origUpdated = proto.updated;
      proto.firstUpdated = function(changedProps) {
        try {
          origFirstUpdated?.call(this, changedProps);
        } catch (e) {
          _error("Error in original firstUpdated (entity-voice-settings): " + _errorMessage(e));
        }
        _maybeFetchEntity2fa(this);
        _injectAskPin(this);
      };
      proto.updated = function(changedProps) {
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
  var PATCHERS = {
    "ha-config-voice-assistants-assistants": _patchAssistantsPageProto,
    "voice-assistant-brand-icon": _patchBrandIconProto,
    "voice-assistants-expose-assistant-icon": _patchExposeAssistantIconProto,
    "entity-voice-settings": _patchEntityVoiceSettingsProto
  };
  function patchCustomElements() {
    try {
      const origDefine = customElements.define;
      customElements.define = function(name, constructor, options) {
        try {
          const patcher = PATCHERS[name];
          if (patcher) patcher(constructor.prototype);
        } catch (e) {
          _error(
            "Error in customElements.define interceptor for '" + name + "': " + _errorMessage(e)
          );
        }
        return origDefine.call(this, name, constructor, options);
      };
      for (const name in PATCHERS) {
        try {
          const cls = customElements.get(name);
          if (cls) PATCHERS[name](cls.prototype);
        } catch (e) {
          _error(
            "Error patching already-defined element '" + name + "': " + _errorMessage(e)
          );
        }
      }
      _debug("Patch 4/4 applied: custom elements (" + Object.keys(PATCHERS).join(", ") + ")");
    } catch (e) {
      _error("Failed to apply patch 4/4 (custom elements): " + _errorMessage(e));
    }
  }
  var _observerActive = /* @__PURE__ */ new WeakSet();
  var INSERTION_LOOKUP = [
    { selector: "assist-pref", before: false },
    { selector: "assist-current-device-pref", before: false },
    { selector: "cloud-discover", before: true },
    { selector: "cloud-google-pref", before: true }
  ];
  function findInsertionPoint(content) {
    for (let i = 0; i < INSERTION_LOOKUP.length; i++) {
      const item = INSERTION_LOOKUP[i];
      try {
        const el = content.querySelector(item.selector);
        if (el) return { ref: el, before: item.before };
      } catch (e) {
        _debug("querySelector('" + item.selector + "') failed: " + _errorMessage(e));
      }
    }
    return { ref: null, before: false };
  }
  function makeSettingItem(hass, headlineKey, supportKey, headlineFallback, supportFallback) {
    const item = document.createElement("ha-md-list-item");
    item.style.cssText = "--md-list-item-leading-space:0;--md-list-item-trailing-space:0;--md-item-overflow:visible";
    const headline = document.createElement("span");
    headline.slot = "headline";
    headline.textContent = hass && hass.localize(headlineKey) || headlineFallback;
    item.appendChild(headline);
    const support = document.createElement("span");
    support.slot = "supporting-text";
    support.textContent = hass && hass.localize(supportKey) || supportFallback;
    item.appendChild(support);
    return item;
  }
  function makeSwitchSettingItem(hass, headlineKey, supportKey, headlineFallback, supportFallback, handler) {
    const item = makeSettingItem(hass, headlineKey, supportKey, headlineFallback, supportFallback);
    const sw = document.createElement("ha-switch");
    sw.slot = "end";
    if (handler) sw.addEventListener("change", handler);
    item.appendChild(sw);
    return item;
  }
  var _pinTimer = null;
  function _setRowsVisible(rows, visible) {
    const display = visible ? "" : "none";
    for (let i = 0; i < rows.length; i++) {
      rows[i].style.display = display;
    }
  }
  function buildCard() {
    try {
      let addSetting2 = function(el) {
        settingsRows.push(el);
        body.appendChild(el);
      };
      var addSetting = addSetting2;
      const hass = getHass();
      ensureTranslationsLoaded();
      const brandIcon = document.createElement("voice-assistant-brand-icon");
      brandIcon.voiceAssistantId = ASSISTANT_ID;
      brandIcon.hass = hass;
      brandIcon.style.cssText = "height:28px;margin-right:16px;margin-inline-end:16px;margin-inline-start:initial";
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
      headerActions.style.cssText = "flex-shrink:0;margin-left:16px;margin-inline-start:16px;margin-inline-end:initial;display:flex;flex-direction:row;align-items:center";
      const helpBtn = document.createElement("ha-icon-button");
      helpBtn.setAttribute(
        "label",
        hass?.localize("ui.panel.config.cloud.account.remote.link_learn_how_it_works") || "Learn how it works"
      );
      helpBtn.setAttribute(
        "href",
        "https://www.home-assistant.io/integrations/google_assistant/"
      );
      helpBtn.setAttribute("target", "_blank");
      helpBtn.setAttribute("rel", "noreferrer");
      helpBtn.style.cssText = "display:flex;align-items:center;margin-right:8px;margin-inline-end:8px;margin-inline-start:initial;direction:var(--direction);color:var(--secondary-text-color)";
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
      desc.textContent = (hass?.localize("ui.panel.config.cloud.account.google.info") || "").replace(/\s*Cloud\b/g, "") || "With the Google Assistant integration for Home Assistant, you'll be able to control all your Home Assistant devices via any Google Assistant-enabled device.";
      body.appendChild(desc);
      const yamlAlert = document.createElement("ha-alert");
      yamlAlert.setAttribute("alert-type", "info");
      yamlAlert.style.display = "none";
      yamlAlert.innerHTML = t("yaml_detected");
      _retranslate.push(() => {
        yamlAlert.innerHTML = t("yaml_detected");
      });
      body.appendChild(yamlAlert);
      const settingsRows = [];
      let reportStateSwitch = null;
      let pinInput = null;
      const exposeItem = makeSwitchSettingItem(
        hass,
        "ui.panel.config.voice_assistants.expose.expose_new_entities",
        "ui.panel.config.voice_assistants.expose.expose_new_entities_info",
        "Expose new entities",
        "Should new entities be exposed? Exposes supported devices that are not classified as security devices.",
        onExposeToggle
      );
      addSetting2(exposeItem);
      const reportStateItem = makeSwitchSettingItem(
        hass,
        "ui.panel.config.cloud.account.google.enable_state_reporting",
        "ui.panel.config.cloud.account.google.info_state_reporting",
        "Enable state reporting",
        "If you enable state reporting, Home Assistant will send all state changes of exposed entities to Google. This speeds up voice commands and allows you to always see the latest states in the Google app.",
        onReportStateToggle
      );
      reportStateSwitch = reportStateItem.querySelector("ha-switch");
      addSetting2(reportStateItem);
      const securityItem = makeSettingItem(
        hass,
        "ui.panel.config.cloud.account.google.security_devices",
        "ui.panel.config.cloud.account.google.enter_pin_info",
        "Security devices",
        "Please enter a PIN to interact with security devices. Security devices are doors, garage doors, and locks. You will be asked to say/enter this PIN when interacting with security devices via Google Assistant."
      );
      addSetting2(securityItem);
      pinInput = document.createElement("ha-input");
      pinInput.setAttribute(
        "label",
        hass?.localize("ui.panel.config.cloud.account.google.devices_pin") || "Security devices PIN"
      );
      pinInput.placeholder = hass?.localize("ui.panel.config.cloud.account.google.enter_pin_hint") || "Enter a PIN to use security devices";
      pinInput.style.cssText = "width:250px;margin-top:8px";
      pinInput.addEventListener("input", onPinChanged);
      addSetting2(pinInput);
      card.appendChild(body);
      const actions = document.createElement("div");
      actions.className = "card-actions";
      actions.style.cssText = "display:flex";
      const exposeLink = document.createElement("a");
      exposeLink.href = "/config/voice-assistants/expose?assistants=" + ASSISTANT_ID + "&historyBack";
      exposeLink.style.textDecoration = "none";
      const exposeBtn = document.createElement("ha-button");
      exposeBtn.setAttribute("appearance", "plain");
      exposeBtn.textContent = "Exposed entities";
      exposeBtn.setAttribute("data-ga-count", "");
      exposeLink.appendChild(exposeBtn);
      actions.appendChild(exposeLink);
      card.appendChild(actions);
      settingsRows.push(actions);
      globalSwitch.addEventListener("change", () => {
        const cfg = globalSwitch.checked ? _TOGGLE_CONFIGS.enable : _TOGGLE_CONFIGS.disable;
        _toggleIntegration(cfg, card, globalSwitch, settingsRows);
      });
      _setRowsVisible(settingsRows, false);
      refreshCardState(card, globalSwitch, settingsRows, reportStateSwitch, pinInput, yamlAlert);
      return card;
    } catch (e) {
      _error("Failed to build card: " + _errorMessage(e));
      return null;
    }
  }
  var _TOGGLE_CONFIGS = {
    enable: {
      action: "enable",
      wsType: WS_ENABLE,
      successKey: "enable_success",
      failKey: "enable_failed",
      failHintKey: "enable_fail_hint",
      showCardOnSuccess: true
    },
    disable: {
      action: "disable",
      wsType: WS_DISABLE,
      successKey: "disable_success",
      failKey: "disable_failed",
      failHintKey: "disable_fail_hint",
      showCardOnSuccess: false
    }
  };
  async function _toggleIntegration(config, card, globalSwitch, settingsRows) {
    const hass = getHass();
    if (!hass) {
      _warn("_toggleIntegration: Home Assistant not loaded");
      globalSwitch.checked = !config.showCardOnSuccess;
      return;
    }
    try {
      await _withEntryRetry(async (entryId) => {
        _info(
          config.action.charAt(0).toUpperCase() + config.action.slice(1) + " Google Assistant for entry_id=" + entryId
        );
        await hass.callWS({ type: config.wsType, entry_id: entryId });
      });
      _info(t(config.successKey));
      _gaManualEnabled = config.showCardOnSuccess;
      _refreshExposePage();
      _setRowsVisible(settingsRows, config.showCardOnSuccess);
      if (config.showCardOnSuccess) refreshExposeToggle(card);
    } catch (err) {
      const wsErr = err;
      const failMsg = t(config.failKey);
      _error(failMsg + " " + _wsErrorMessage(err));
      globalSwitch.checked = !config.showCardOnSuccess;
      _showToast(
        failMsg + " " + (wsErr.message || wsErr.error || t("check_logs")) + "\n\n" + t(config.failHintKey),
        true
      );
    }
  }
  async function refreshCardState(card, globalSwitch, settingsRows, reportStateSwitch, pinInput, yamlAlert) {
    const hass = getHass();
    if (!hass) {
      _debug("refreshCardState: Home Assistant not loaded yet, will retry on next render");
      return;
    }
    try {
      const config = await _withEntryRetry(
        (entryId) => hass.callWS({
          type: WS_GET_CONFIG,
          entry_id: entryId
        })
      );
      _debug(
        "refreshCardState received config: enabled=" + config.enabled + " report_state=" + config.report_state
      );
      _maybePromptReload(config.version);
      _gaManualEnabled = config.enabled;
      _refreshExposePage();
      globalSwitch.checked = config.enabled;
      if (yamlAlert) {
        yamlAlert.style.display = config.yaml_suppressed ? "" : "none";
      }
      _setRowsVisible(settingsRows, config.enabled);
      if (reportStateSwitch) {
        reportStateSwitch.checked = config.report_state;
        reportStateSwitch.disabled = !config.enabled;
      }
      if (pinInput) {
        pinInput.value = config.secure_devices_pin || "";
        pinInput.disabled = !config.enabled;
      }
      refreshExposeToggle(card);
    } catch (err) {
      _error("Failed to fetch card state: " + _wsErrorMessage(err));
    }
  }
  function injectCardInto(el) {
    if (!el) return;
    try {
      const root = el.shadowRoot || el;
      const content = root.querySelector(".content");
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
          "DOM insertion failed: " + _errorMessage(e) + ". Falling back to appendChild."
        );
        try {
          content.appendChild(card);
        } catch (e2) {
          _error("Fallback appendChild also failed: " + (e2 instanceof Error ? e2.message : String(e2)));
        }
      }
    } catch (e) {
      _error("injectCardInto failed: " + _errorMessage(e));
    }
  }
  function findAllAssistantsElements(root) {
    const results = [];
    if (!root) return results;
    if (root.nodeType !== 1 && root.nodeType !== 11) return results;
    if (root instanceof HTMLElement && root.nodeName === "HA-CONFIG-VOICE-ASSISTANTS-ASSISTANTS") {
      results.push(root);
    }
    const el = root;
    const shadowRoot = el.shadowRoot;
    if (shadowRoot) {
      try {
        results.push(...findAllAssistantsElements(shadowRoot));
      } catch (e) {
        _debug(
          "Could not traverse shadowRoot of " + el.nodeName + ": " + _errorMessage(e)
        );
      }
    }
    try {
      const children = el.children || el.childNodes || [];
      for (let i = 0; i < children.length; i++) {
        try {
          results.push(...findAllAssistantsElements(children[i]));
        } catch {
        }
      }
    } catch {
    }
    return results;
  }
  function injectIntoAllAssistantsElements() {
    try {
      const elements = findAllAssistantsElements(document.documentElement);
      _debug("Found " + elements.length + " assistants page elements to inject into");
      for (let i = 0; i < elements.length; i++) {
        try {
          injectCardInto(elements[i]);
        } catch (e) {
          _error(
            "Error injecting card into element " + i + ": " + _errorMessage(e)
          );
        }
      }
    } catch (e) {
      _error("injectIntoAllAssistantsElements failed: " + _errorMessage(e));
    }
  }
  function _refreshExposePage() {
    try {
      const el = findExposeElement(document.documentElement);
      if (!el) return;
      if (el._fetchEntities) {
        el._fetchEntities();
      } else if (el.requestUpdate) {
        el.requestUpdate();
      }
    } catch (e) {
      _debug("_refreshExposePage: " + _errorMessage(e));
    }
  }
  function refreshExposeToggle(card) {
    const hass = getHass();
    if (!hass) return;
    const sw = card.querySelector(".card-content ha-switch");
    const btn = card.querySelector("[data-ga-count]");
    Promise.all([
      hass.callWS({
        type: "homeassistant/expose_new_entities/get",
        assistant: ASSISTANT_ID
      }),
      hass.callWS({
        type: "homeassistant/expose_entity/list"
      })
    ]).then((results) => {
      if (sw) sw.checked = results[0].expose_new;
      if (!btn) return;
      const exposedEntities = results[1].exposed_entities || {};
      let count = 0;
      try {
        const states = hass.states || {};
        count = Object.entries(exposedEntities).filter(([entityId, s]) => {
          return s && s[ASSISTANT_ID] && entityId in states;
        }).length;
      } catch (e) {
        _debug("Error counting exposed entities: " + _errorMessage(e));
      }
      btn.textContent = hass.localize ? hass.localize("ui.panel.config.voice_assistants.assistants.pipeline.exposed_entities", {
        number: count
      }) : count + " exposed entities";
    }).catch((err) => {
      _error("Failed to refresh expose toggle: " + _wsErrorMessage(err));
    });
  }
  function onExposeToggle(e) {
    const hass = getHass();
    if (!hass) return;
    const target = e.target;
    const checked = target.checked;
    hass.callWS({
      type: "homeassistant/expose_new_entities/set",
      assistant: ASSISTANT_ID,
      expose_new: checked
    }).catch((err) => {
      _error("Failed to set expose_new_entities: " + _wsErrorMessage(err));
      target.checked = !checked;
    });
  }
  async function onReportStateToggle(e) {
    const hass = getHass();
    if (!hass) return;
    const target = e.target;
    const checked = target.checked;
    try {
      await _withEntryRetry(
        (entryId) => hass.callWS({
          type: WS_UPDATE_CONFIG,
          entry_id: entryId,
          data: { report_state: checked }
        })
      );
    } catch (err) {
      _error("Failed to update report_state: " + _wsErrorMessage(err));
      target.checked = !checked;
      _showToast(
        t(checked ? "report_state_enable_failed" : "report_state_disable_failed"),
        true
      );
    }
  }
  function onPinChanged(e) {
    const hass = getHass();
    if (!hass) return;
    const input = e.target;
    const value = input.value;
    if (_pinTimer) clearTimeout(_pinTimer);
    _pinTimer = setTimeout(() => {
      _savePin(value, input);
    }, 500);
  }
  async function _restorePinValue(input) {
    const hass = getHass();
    if (!hass) return;
    try {
      const config = await _withEntryRetry(
        (entryId) => hass.callWS({
          type: WS_GET_CONFIG,
          entry_id: entryId
        })
      );
      input.value = config.secure_devices_pin || "";
    } catch {
    }
  }
  async function _savePin(value, input) {
    const hass = getHass();
    if (!hass) return;
    try {
      await _withEntryRetry(
        (entryId) => hass.callWS({
          type: WS_UPDATE_CONFIG,
          entry_id: entryId,
          data: { secure_devices_pin: value }
        })
      );
    } catch (err) {
      const wsErr = err;
      _error(
        "Failed to update secure_devices_pin: " + (wsErr.message || wsErr.error || String(err))
      );
      _showToast(
        (hass.localize("ui.panel.config.cloud.account.google.enter_pin_error") || "Unable to store the PIN.") + " " + (wsErr.message || wsErr.error || ""),
        true
      );
      if (input) _restorePinValue(input);
    }
  }
  function init() {
    ensureTranslationsLoaded();
    _banner(t("ready_banner", { name: ASSISTANT_NAME }));
    try {
      patchVoiceAssistants();
    } catch (e) {
      _error("patchVoiceAssistants threw: " + _errorMessage(e));
    }
    try {
      patchSortKey();
    } catch (e) {
      _error("patchSortKey threw: " + _errorMessage(e));
    }
    try {
      patchCustomElements();
    } catch (e) {
      _error("patchCustomElements threw: " + _errorMessage(e));
    }
    try {
      injectIntoAllAssistantsElements();
    } catch (e) {
      _error("injectIntoAllAssistantsElements threw: " + _errorMessage(e));
    }
    try {
      const _pendingNodes = /* @__PURE__ */ new Set();
      let _scanScheduled = false;
      const _scanPending = () => {
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
                  "Error injecting card into dynamically added element: " + _errorMessage(e)
                );
              }
            }
          } catch (e) {
            _debug(
              "Error scanning dynamically added node: " + _errorMessage(e)
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
      const target = document.body || document.documentElement;
      if (target) {
        docObserver.observe(target, {
          childList: true,
          subtree: true
        });
        _debug(
          "MutationObserver active on " + (target === document.body ? "document.body" : "documentElement")
        );
      } else {
        _warn("Cannot start MutationObserver: no document.body or documentElement");
      }
    } catch (e) {
      _error("Failed to start MutationObserver: " + _errorMessage(e));
    }
    try {
      patchExposePage();
    } catch (e) {
      _error("patchExposePage threw: " + _errorMessage(e));
    }
    _info("Init complete \u2014 all patches applied");
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
