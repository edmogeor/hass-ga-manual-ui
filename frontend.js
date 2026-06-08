/**
 * Google Assistant (Manual) — Frontend companion module.
 * Patches the HA frontend at runtime so the integration appears in the
 * voice assistants UI alongside the built-in cloud assistants.
 */

const ASSISTANT_ID = "google_assistant_manual";
const ASSISTANT_NAME = "Google Assistant (Manual)";
const SORT_TARGET = ["conversation", "cloud.alexa", "cloud.google_assistant"];
const ASSET_URL = "/google_assistant_manual/assets";

let _entryId = null;
let _entryIdPromise = null;
var _gaManualEnabled = true;

// ---------------------------------------------------------------------------
// Logging helpers
// ---------------------------------------------------------------------------

function _log(level, message, data) {
  try {
    if (data !== undefined) {
      console[level]("[GA Manual] " + message, data);
    } else {
      console[level]("[GA Manual] " + message);
    }
  } catch (_) {
    /* console might be unavailable */
  }
}

function _debug(msg, data) { _log("debug", msg, data); }
function _info(msg, data) { _log("info", msg, data); }
function _warn(msg, data) { _log("warn", msg, data); }
function _error(msg, data) { _log("error", msg, data); }

// ---------------------------------------------------------------------------
// User-facing toast notifications (HA-style)
// ---------------------------------------------------------------------------

function _showToast(message, isError) {
  try {
    var hass = getHass();
    if (!hass || !hass.callService) return;
    hass.callService("persistent_notification", "create", {
      title: ASSISTANT_NAME + (isError ? " — Error" : " — Notice"),
      message: message,
      notification_id: "google_assistant_manual_notification",
    });
  } catch (e) {
    _error("Failed to show toast: " + e.message);
  }
}

// ---------------------------------------------------------------------------
// Entry ID resolution
// ---------------------------------------------------------------------------

function getBrandIconUrl() {
  return ASSET_URL + "/icon.png";
}

function getHass() {
  var homeAssistant = document.querySelector("home-assistant");
  return homeAssistant && homeAssistant.hass;
}

function getEntryId() {
  if (_entryId) return Promise.resolve(_entryId);
  if (_entryIdPromise) return _entryIdPromise;
  _entryIdPromise = _fetchEntryId().then(
    function (id) {
      _entryId = id;
      _entryIdPromise = null;
      _debug("Resolved entry_id=" + id);
      return id;
    },
    function (err) {
      _entryIdPromise = null;
      throw err;
    }
  );
  return _entryIdPromise;
}

function _fetchEntryId() {
  var hass = getHass();
  if (!hass) {
    var err = new Error(
      "Home Assistant not yet loaded. The Google Assistant (Manual) card " +
      "will retry when the page finishes loading."
    );
    _warn(err.message);
    return Promise.reject(err);
  }

  _debug("Fetching entry_id via WS");
  return hass.callWS({
    type: "google_assistant_manual/get_entry_id",
  }).then(
    function (result) {
      if (!result || !result.entry_id) {
        throw new Error(
          "Server returned no entry_id. The integration must be added via " +
          "Settings → Devices & Services → Add Integration first."
        );
      }
      return result.entry_id;
    },
    function (err) {
      _error(
        "Failed to get entry_id from server: " +
        (err.message || err.error || err.code || String(err)) + ". " +
        "Add the integration via Settings → Devices & Services → " +
        "Add Integration → Google Assistant (Manual)."
      );
      throw err;
    }
  );
}

// ---------------------------------------------------------------------------
// 1. Inject our key into voiceAssistants (from data/expose.ts)
// ---------------------------------------------------------------------------

function patchVoiceAssistants() {
  try {
    var origKeys = Object.keys;
    var seen = new WeakSet();

    Object.keys = function (obj) {
      try {
        if (
          obj &&
          typeof obj === "object" &&
          !Array.isArray(obj) &&
          !seen.has(obj) &&
          "conversation" in obj &&
          "cloud.alexa" in obj &&
          "cloud.google_assistant" in obj
        ) {
          seen.add(obj);
          if (!(ASSISTANT_ID in obj)) {
            obj[ASSISTANT_ID] = { domain: "google_assistant", name: ASSISTANT_NAME };
            _info("Injected " + ASSISTANT_ID + " into voiceAssistants map");
          }
        }
      } catch (e) {
        _error("Error in Object.keys interceptor: " + e.message);
      }
      return origKeys(obj);
    };
    _debug("Patch 1/4 applied: voiceAssistants (Object.keys)");
  } catch (e) {
    _error("Failed to apply patch 1/4 (voiceAssistants): " + e.message);
  }
}

// ---------------------------------------------------------------------------
// 2. Intercept Array.prototype.forEach to fix the sort key
// ---------------------------------------------------------------------------

function patchSortKey() {
  try {
    var origForEach = Array.prototype.forEach;

    Array.prototype.forEach = function (callback, thisArg) {
      try {
        if (
          this.length === SORT_TARGET.length &&
          SORT_TARGET.every(function (v, i) { return this[i] === v; }, this) &&
          !this.includes(ASSISTANT_ID)
        ) {
          this.push(ASSISTANT_ID);
          _info("Injected " + ASSISTANT_ID + " into sort-order array");
        }
      } catch (e) {
        _error("Error in Array.forEach interceptor: " + e.message);
      }
      return origForEach.call(this, callback, thisArg);
    };
    _debug("Patch 2/4 applied: sort key (Array.forEach)");
  } catch (e) {
    _error("Failed to apply patch 2/4 (sort key): " + e.message);
  }
}

// ---------------------------------------------------------------------------
// 3. Wrap _availableAssistants getter on the expose page
// ---------------------------------------------------------------------------

function findExposeElement(root) {
  if (!root) return null;
  if (root.nodeType !== 1 && root.nodeType !== 11) return null;
  if (root.nodeName === "HA-CONFIG-VOICE-ASSISTANTS-EXPOSE") return root;
  if (root.shadowRoot) {
    var found = findExposeElement(root.shadowRoot);
    if (found) return found;
  }
  var children = root.children || [];
  for (var i = 0; i < children.length; i++) {
    var found = findExposeElement(children[i]);
    if (found) return found;
  }
  return null;
}

async function patchExposePage() {
  try {
    await customElements.whenDefined("ha-config-voice-assistants-expose");
    var cls = customElements.get("ha-config-voice-assistants-expose");
    if (!cls) {
      _warn(
        "ha-config-voice-assistants-expose element not found. " +
        "The expose page may not have been loaded yet. " +
        "The patch will be attempted when the element first renders."
      );
      return;
    }

    var desc = Object.getOwnPropertyDescriptor(
      cls.prototype,
      "_availableAssistants"
    );
    if (!desc || !desc.get) {
      _warn(
        "_availableAssistants getter not found on expose element. " +
        "HA may have renamed this property — exposure dropdown may not " +
        "include " + ASSISTANT_ID + "."
      );
      return;
    }

    var orig = desc.get;
    Object.defineProperty(cls.prototype, "_availableAssistants", {
      get: function () {
        try {
          var result = orig.call(this);
          if (!Array.isArray(result)) return result;
          if (!_gaManualEnabled) {
            var filtered = result.filter(function (id) { return id !== ASSISTANT_ID; });
            return filtered;
          }
          return result.includes(ASSISTANT_ID) ? result : result.concat(ASSISTANT_ID);
        } catch (e) {
          _error("Error in _availableAssistants getter: " + e.message);
          return orig.call(this);
        }
      },
    });
    _debug("Patch 3/4 applied: expose page (_availableAssistants getter)");

    var el =
      document.querySelector("ha-config-voice-assistants-expose") ||
      findExposeElement(document.documentElement);
    if (el) {
      try { el.requestUpdate(); } catch (e) { _debug("requestUpdate failed: " + e.message); }
    }
  } catch (e) {
    _error("Failed to apply patch 3/4 (expose page): " + e.message);
  }
}

// ---------------------------------------------------------------------------
// 4. Patch custom element prototypes (both new definitions and retroactive)
// ---------------------------------------------------------------------------

function _patchAssistantsPageProto(proto) {
  try {
    var origConnected = proto.connectedCallback;
    var origFirstUpdated = proto.firstUpdated;
    var origUpdated = proto.updated;

    proto.connectedCallback = function () {
      try {
        if (origConnected) origConnected.call(this);
      } catch (e) {
        _error("Error in original connectedCallback: " + e.message);
      }
      var self = this;
      requestAnimationFrame(function () {
        try { injectCardInto(self); } catch (e) {
          _error("Error injecting card in connectedCallback: " + e.message);
        }
      });
    };

    proto.firstUpdated = function (changedProps) {
      try { origFirstUpdated.call(this, changedProps); } catch (e) {
        _error("Error in original firstUpdated: " + e.message);
      }
      try { injectCardInto(this); } catch (e) {
        _error("Error injecting card in firstUpdated: " + e.message);
      }
    };
    proto.updated = function (changedProps) {
      try { origUpdated.call(this, changedProps); } catch (e) {
        _error("Error in original updated: " + e.message);
      }
      try { injectCardInto(this); } catch (e) {
        _error("Error injecting card in updated: " + e.message);
      }
    };
  } catch (e) {
    _error("Failed to patch assistants page proto: " + e.message);
  }
}

function _renderManualBrandIcon() {
  try {
    var root = this.shadowRoot || this;
    if (root.querySelector("img[data-ga-manual]")) return;
    root.innerHTML = "";
    var img = document.createElement("img");
    img.dataset.gaManual = "1";
    img.className = "logo";
    img.alt = ASSISTANT_NAME;
    img.src = getBrandIconUrl();
    img.crossOrigin = "anonymous";
    img.referrerPolicy = "no-referrer";
    img.onerror = function () {
      _warn("Brand icon failed to load from " + getBrandIconUrl());
    };
    root.appendChild(img);
  } catch (e) {
    _error("Error rendering manual brand icon: " + e.message);
  }
}

function _patchBrandIconProto(proto) {
  try {
    var origRender = proto.render;
    var origFirstUpdated = proto.firstUpdated;
    var origUpdated = proto.updated;
    proto.render = function () {
      if (this.voiceAssistantId === ASSISTANT_ID) return null;
      return origRender.call(this);
    };
    proto.firstUpdated = function (changedProps) {
      if (this.voiceAssistantId === ASSISTANT_ID) {
        _renderManualBrandIcon.call(this);
      } else {
        origFirstUpdated.call(this, changedProps);
      }
    };
    proto.updated = function (changedProps) {
      if (this.voiceAssistantId === ASSISTANT_ID) {
        _renderManualBrandIcon.call(this);
      } else {
        origUpdated.call(this, changedProps);
      }
    };
  } catch (e) {
    _error("Failed to patch brand icon proto: " + e.message);
  }
}

function _renderManualExposeIcon() {
  try {
    var root = this.shadowRoot || this;
    if (root.querySelector("[data-ga-manual]")) return;
    root.innerHTML = "";

    var containerId = (this.id || "ga") + "-" + ASSISTANT_ID;
    var container = document.createElement("div");
    container.className = "container";
    container.id = containerId;
    container.dataset.gaManual = "1";

    var icon = document.createElement("voice-assistant-brand-icon");
    icon.voiceAssistantId = ASSISTANT_ID;
    icon.hass = this.hass;
    if (this.manual) icon.style.filter = "grayscale(100%)";
    container.appendChild(icon);

    if (this.unsupported) {
      var alertIcon = document.createElement("ha-icon");
      alertIcon.icon = "mdi:alert-circle";
      alertIcon.classList.add("unsupported");
      container.appendChild(alertIcon);
    }
    root.appendChild(container);

    var tooltip = document.createElement("ha-tooltip");
    tooltip.setAttribute("for", containerId);
    tooltip.setAttribute("placement", "left");
    if (!this.unsupported && !this.manual) tooltip.setAttribute("disabled", "");

    var localize = this.hass && this.hass.localize;
    if (this.unsupported) {
      tooltip.appendChild(document.createTextNode(
        localize ? localize("ui.panel.config.voice_assistants.expose.not_supported") : ""
      ));
      if (this.manual) tooltip.appendChild(document.createElement("br"));
    }
    if (this.manual) {
      tooltip.appendChild(document.createTextNode(
        localize ? localize("ui.panel.config.voice_assistants.expose.manually_configured") : ""
      ));
    }
    root.appendChild(tooltip);
  } catch (e) {
    _error("Error rendering manual expose icon: " + e.message);
  }
}

function _patchExposeAssistantIconProto(proto) {
  try {
    var origRender = proto.render;
    var origFirstUpdated = proto.firstUpdated;
    var origUpdated = proto.updated;
    proto.render = function () {
      if (this.assistant === ASSISTANT_ID) return null;
      return origRender.call(this);
    };
    proto.firstUpdated = function (changedProps) {
      if (this.assistant === ASSISTANT_ID) {
        _renderManualExposeIcon.call(this);
      } else {
        origFirstUpdated.call(this, changedProps);
      }
    };
    proto.updated = function (changedProps) {
      if (this.assistant === ASSISTANT_ID) {
        _renderManualExposeIcon.call(this);
      } else {
        origUpdated.call(this, changedProps);
      }
    };
  } catch (e) {
    _error("Failed to patch expose assistant icon proto: " + e.message);
  }
}

var PATCHERS = {
  "ha-config-voice-assistants-assistants": _patchAssistantsPageProto,
  "voice-assistant-brand-icon": _patchBrandIconProto,
  "voice-assistants-expose-assistant-icon": _patchExposeAssistantIconProto,
};

function patchCustomElements() {
  try {
    var origDefine = customElements.define;

    customElements.define = function (name, constructor, options) {
      try {
        var patcher = PATCHERS[name];
        if (patcher) patcher(constructor.prototype);
      } catch (e) {
        _error("Error in customElements.define interceptor for '" + name + "': " + e.message);
      }
      return origDefine.call(this, name, constructor, options);
    };

    for (var name in PATCHERS) {
      try {
        var cls = customElements.get(name);
        if (cls) PATCHERS[name](cls.prototype);
      } catch (e) {
        _error("Error patching already-defined element '" + name + "': " + e.message);
      }
    }
    _debug("Patch 4/4 applied: custom elements (" + Object.keys(PATCHERS).join(", ") + ")");
  } catch (e) {
    _error("Failed to apply patch 4/4 (custom elements): " + e.message);
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

var _observerActive = new WeakSet();

var INSERTION_LOOKUP = [
  { selector: "assist-pref", before: false },
  { selector: "assist-current-device-pref", before: false },
  { selector: "cloud-discover", before: true },
  { selector: "cloud-google-pref", before: true },
];

function findInsertionPoint(content) {
  for (var i = 0; i < INSERTION_LOOKUP.length; i++) {
    var item = INSERTION_LOOKUP[i];
    try {
      var el = content.querySelector(item.selector);
      if (el) return { ref: el, before: item.before };
    } catch (e) {
      _debug("querySelector('" + item.selector + "') failed: " + e.message);
    }
  }
  return { ref: null, before: false };
}

function makeSettingItem(hass, headlineKey, supportKey, headlineFallback, supportFallback) {
  var item = document.createElement("ha-md-list-item");
  item.style.cssText = "--md-list-item-leading-space:0;--md-list-item-trailing-space:0;--md-item-overflow:visible";
  var headline = document.createElement("span");
  headline.slot = "headline";
  headline.textContent = (hass && hass.localize(headlineKey)) || headlineFallback;
  item.appendChild(headline);
  var support = document.createElement("span");
  support.slot = "supporting-text";
  support.textContent = (hass && hass.localize(supportKey)) || supportFallback;
  item.appendChild(support);
  return item;
}

function makeSwitchSettingItem(hass, headlineKey, supportKey, headlineFallback, supportFallback, handler) {
  var item = makeSettingItem(hass, headlineKey, supportKey, headlineFallback, supportFallback);
  var sw = document.createElement("ha-switch");
  sw.slot = "end";
  if (handler) sw.addEventListener("change", handler);
  item.appendChild(sw);
  return item;
}

var _pinTimer = null;

function buildCard() {
  try {
    var hass = getHass();

    var brandIcon = document.createElement("voice-assistant-brand-icon");
    brandIcon.voiceAssistantId = ASSISTANT_ID;
    brandIcon.hass = hass;
    brandIcon.style.cssText = "height:28px;margin-right:16px;margin-inline-end:16px;margin-inline-start:initial";

    var card = document.createElement("ha-card");
    card.setAttribute("outlined", "");
    card.setAttribute("data-ga-manual-card", "1");

    var header = document.createElement("h1");
    header.className = "card-header";
    header.style.cssText = "display:flex;align-items:center;position:relative";
    header.appendChild(brandIcon);
    header.appendChild(document.createTextNode(ASSISTANT_NAME));
    card.appendChild(header);

    var headerActions = document.createElement("div");
    headerActions.style.cssText = "position:absolute;right:24px;inset-inline-end:24px;inset-inline-start:initial;top:50%;transform:translateY(-50%);display:flex;flex-direction:row;align-items:center";
    var helpBtn = document.createElement("ha-icon-button");
    helpBtn.label = "Learn how it works";
    helpBtn.href = "https://www.home-assistant.io/integrations/google_assistant/";
    helpBtn.target = "_blank";
    helpBtn.rel = "noreferrer";
    helpBtn.style.cssText = "display:flex;align-items:center;margin-right:8px;margin-inline-end:8px;margin-inline-start:initial;direction:var(--direction);color:var(--secondary-text-color)";
    var helpIcon = document.createElement("ha-icon");
    helpIcon.icon = "mdi:help-circle-outline";
    helpIcon.style.display = "block";
    helpBtn.appendChild(helpIcon);
    headerActions.appendChild(helpBtn);

    var globalSwitch = document.createElement("ha-switch");
    headerActions.appendChild(globalSwitch);

    header.appendChild(headerActions);

    var body = document.createElement("div");
    body.className = "card-content";

    var desc = document.createElement("p");
    desc.textContent =
      (hass && hass.localize("ui.panel.config.cloud.account.google.info") || "")
        .replace(/\s*Cloud\b/g, "") ||
      "With the Google Assistant integration for Home Assistant, you'll be able to control all your Home Assistant devices via any Google Assistant-enabled device.";
    body.appendChild(desc);

    var settingsRows = [];
    var reportStateSwitch = null;
    var pinInput = null;

    function addSetting(el) {
      settingsRows.push(el);
      body.appendChild(el);
    }

    var exposeItem = makeSwitchSettingItem(
      hass,
      "ui.panel.config.voice_assistants.expose.expose_new_entities",
      "ui.panel.config.voice_assistants.expose.expose_new_entities_info",
      "Expose new entities",
      "Should new entities be exposed? Exposes supported devices that are not classified as security devices.",
      onExposeToggle
    );
    addSetting(exposeItem);

    var reportStateItem = makeSwitchSettingItem(
      hass,
      "ui.panel.config.cloud.account.google.enable_state_reporting",
      "ui.panel.config.cloud.account.google.info_state_reporting",
      "Enable state reporting",
      "If you enable state reporting, Home Assistant will send all state changes of exposed entities to Google. This speeds up voice commands and allows you to always see the latest states in the Google app.",
      onReportStateToggle
    );
    reportStateSwitch = reportStateItem.querySelector("ha-switch");
    addSetting(reportStateItem);

    var securityItem = makeSettingItem(
      hass,
      "ui.panel.config.cloud.account.google.security_devices",
      "ui.panel.config.cloud.account.google.enter_pin_info",
      "Security devices",
      "Please enter a PIN to interact with security devices. Security devices are doors, garage doors, and locks. You will be asked to say/enter this PIN when interacting with security devices via Google Assistant."
    );
    addSetting(securityItem);

    pinInput = document.createElement("ha-input");
    pinInput.label =
      (hass && hass.localize("ui.panel.config.cloud.account.google.devices_pin")) ||
      "Security devices PIN";
    pinInput.placeholder =
      (hass && hass.localize("ui.panel.config.cloud.account.google.enter_pin_hint")) ||
      "Enter a PIN to use security devices";
    pinInput.style.cssText = "width:250px;margin-top:8px";
    pinInput.addEventListener("input", onPinChanged);
    addSetting(pinInput);

    card.appendChild(body);

    var actions = document.createElement("div");
    actions.className = "card-actions";
    actions.style.cssText = "display:flex";

    var exposeLink = document.createElement("a");
    exposeLink.href = "/config/voice-assistants/expose?assistants=" + ASSISTANT_ID + "&historyBack";
    exposeLink.style.textDecoration = "none";

    var exposeBtn = document.createElement("ha-button");
    exposeBtn.setAttribute("appearance", "plain");
    exposeBtn.textContent = "Exposed entities";
    exposeBtn.setAttribute("data-ga-count", "");
    exposeLink.appendChild(exposeBtn);
    actions.appendChild(exposeLink);

    card.appendChild(actions);

    settingsRows.push(actions);

    // Global toggle: calls enable/disable WS commands
    globalSwitch.addEventListener("change", function () {
      if (globalSwitch.checked) {
        _enableIntegration(card, globalSwitch, settingsRows);
      } else {
        _disableIntegration(card, globalSwitch, settingsRows);
      }
    });

    // Default: hidden until state is fetched
    for (var i = 0; i < settingsRows.length; i++) {
      settingsRows[i].style.display = "none";
    }

    // Fetch initial config state
    refreshCardState(card, globalSwitch, settingsRows, reportStateSwitch, pinInput);

    return card;
  } catch (e) {
    _error("Failed to build card: " + e.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Enable/disable integration
// ---------------------------------------------------------------------------

function _enableIntegration(card, globalSwitch, settingsRows) {
  getEntryId().then(function (entryId) {
    var hass = getHass();
    if (!hass) {
      _warn("_enableIntegration: Home Assistant not loaded");
      globalSwitch.checked = false;
      return;
    }

    _info("Enabling Google Assistant for entry_id=" + entryId);
    hass.callWS({
      type: "google_assistant_manual/enable",
      entry_id: entryId,
    }).then(function () {
      _info("Google Assistant enabled successfully");
      _gaManualEnabled = true;
      _refreshExposePage();
      for (var i = 0; i < settingsRows.length; i++) {
        settingsRows[i].style.display = "";
      }
      refreshExposeToggle(card);
    }).catch(function (err) {
      _error("Failed to enable Google Assistant: " + (err.message || err.error || err.code || String(err)));
      globalSwitch.checked = false;
      _showToast(
        "Failed to enable Google Assistant. " +
        (err.message || err.error || "Check Home Assistant logs for details.") +
        "\n\nTry reloading the integration from Settings → Devices & Services.",
        true
      );
    });
  }).catch(function (err) {
    _error("_enableIntegration: " + err.message);
    globalSwitch.checked = false;
  });
}

function _disableIntegration(card, globalSwitch, settingsRows) {
  getEntryId().then(function (entryId) {
    var hass = getHass();
    if (!hass) {
      _warn("_disableIntegration: Home Assistant not loaded");
      globalSwitch.checked = true;
      return;
    }

    _info("Disabling Google Assistant for entry_id=" + entryId);
    hass.callWS({
      type: "google_assistant_manual/disable",
      entry_id: entryId,
    }).then(function () {
      _info("Google Assistant disabled successfully");
      _gaManualEnabled = false;
      _refreshExposePage();
      for (var i = 0; i < settingsRows.length; i++) {
        settingsRows[i].style.display = "none";
      }
    }).catch(function (err) {
      _error("Failed to disable Google Assistant: " + (err.message || err.error || err.code || String(err)));
      globalSwitch.checked = true;
      _showToast(
        "Failed to disable Google Assistant. " +
        (err.message || err.error || "Check Home Assistant logs for details.") +
        "\n\nTry removing the integration from Settings → Devices & Services.",
        true
      );
    });
  }).catch(function (err) {
    _error("_disableIntegration: " + err.message);
    globalSwitch.checked = true;
  });
}

// ---------------------------------------------------------------------------
// Card state refresh
// ---------------------------------------------------------------------------

function refreshCardState(card, globalSwitch, settingsRows, reportStateSwitch, pinInput) {
  getEntryId().then(function (entryId) {
    var hass = getHass();
    if (!hass) {
      _debug("refreshCardState: Home Assistant not loaded yet, will retry on next render");
      return;
    }

    hass.callWS({
      type: "google_assistant_manual/get_config",
      entry_id: entryId,
    }).then(function (config) {
      _debug("refreshCardState received config: enabled=" + config.enabled + " report_state=" + config.report_state);

      _gaManualEnabled = config.enabled;
      _refreshExposePage();

      globalSwitch.checked = config.enabled;

      for (var i = 0; i < settingsRows.length; i++) {
        settingsRows[i].style.display = config.enabled ? "" : "none";
      }

      if (reportStateSwitch) {
        reportStateSwitch.checked = config.report_state;
        reportStateSwitch.disabled = !config.enabled;
      }

      if (pinInput) {
        if (config.secure_devices_pin) {
          pinInput.value = config.secure_devices_pin;
        }
        pinInput.disabled = !config.enabled;
      }

      // Also refresh expose toggle + entity count
      refreshExposeToggle(card);
    }).catch(function (err) {
      _error("Failed to fetch card state: " + (err.message || err.error || err.code || String(err)));
      // Keep defaults — card will show with toggles off
    });
  }).catch(function (err) {
    _error("refreshCardState: " + err.message);
  });
}

/**
 * Inject the card into a ha-config-voice-assistants-assistants element.
 * Idempotent — safe to call at any time (lifecycle hooks, DOM scans, observers).
 */
function injectCardInto(el) {
  if (!el) return;

  try {
    var root = el.shadowRoot || el;
    var content = root.querySelector(".content");
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
        var obs = new MutationObserver(function () {
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

    var card = buildCard();
    if (!card) {
      _error("buildCard returned null, card injection aborted");
      return;
    }

    var point = findInsertionPoint(content);

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
      _error("DOM insertion failed: " + e.message + ". Falling back to appendChild.");
      try {
        content.appendChild(card);
      } catch (e2) {
        _error("Fallback appendChild also failed: " + e2.message);
      }
    }
  } catch (e) {
    _error("injectCardInto failed: " + e.message);
  }
}

/**
 * Recursively search a DOM tree (including all shadow roots) for
 * ha-config-voice-assistants-assistants elements.
 */
function findAllAssistantsElements(root) {
  var results = [];
  if (!root) return results;
  if (root.nodeType !== 1 && root.nodeType !== 11) return results;

  if (root.nodeName === "HA-CONFIG-VOICE-ASSISTANTS-ASSISTANTS") {
    results.push(root);
  }

  if (root.shadowRoot) {
    try {
      results.push.apply(results, findAllAssistantsElements(root.shadowRoot));
    } catch (e) {
      _debug("Could not traverse shadowRoot of " + root.nodeName + ": " + e.message);
    }
  }

  try {
    var children = root.children || root.childNodes || [];
    for (var i = 0; i < children.length; i++) {
      try {
        results.push.apply(results, findAllAssistantsElements(children[i]));
      } catch (e) {
        /* skip problem children */
      }
    }
  } catch (e) {
    /* children access may fail on some nodes */
  }

  return results;
}

/**
 * Scan the entire DOM (including all shadow roots) for assistants page
 * elements and inject the card into each.
 */
function injectIntoAllAssistantsElements() {
  try {
    var elements = findAllAssistantsElements(document.documentElement);
    _debug("Found " + elements.length + " assistants page elements to inject into");
    for (var i = 0; i < elements.length; i++) {
      try { injectCardInto(elements[i]); } catch (e) {
        _error("Error injecting card into element " + i + ": " + e.message);
      }
    }
  } catch (e) {
    _error("injectIntoAllAssistantsElements failed: " + e.message);
  }
}

// ---------------------------------------------------------------------------
// WS-backed toggle handlers
// ---------------------------------------------------------------------------

function _refreshExposePage() {
  try {
    var el = findExposeElement(document.documentElement);
    if (!el) return;
    if (el._fetchEntities) {
      el._fetchEntities();
    } else if (el.requestUpdate) {
      el.requestUpdate();
    }
  } catch (e) {
    _debug("_refreshExposePage: " + e.message);
  }
}

function refreshExposeToggle(card) {
  var hass = getHass();
  if (!hass) return;
  var sw = card.querySelector("ha-switch");
  var btn = card.querySelector("[data-ga-count]");

  Promise.all([
    hass.callWS({ type: "homeassistant/expose_new_entities/get", assistant: ASSISTANT_ID }),
    hass.callWS({ type: "homeassistant/expose_entity/list" }),
  ]).then(function (results) {
    if (sw) sw.checked = results[0].expose_new;
    if (!btn) return;
    var exposedEntities = results[1].exposed_entities || {};
    var count = 0;
    try {
      count = Object.values(exposedEntities).filter(function (s) {
        return s && s[ASSISTANT_ID];
      }).length;
    } catch (e) {
      _debug("Error counting exposed entities: " + e.message);
    }
    btn.textContent = hass.localize
      ? hass.localize("ui.panel.config.voice_assistants.assistants.pipeline.exposed_entities", { number: count })
      : count + " exposed entities";
  }).catch(function (err) {
    _error("Failed to refresh expose toggle: " + (err.message || err.error || String(err)));
  });
}

function onExposeToggle(e) {
  var hass = getHass();
  if (!hass) return;
  var checked = e.target.checked;
  hass.callWS({
    type: "homeassistant/expose_new_entities/set",
    assistant: ASSISTANT_ID,
    expose_new: checked,
  }).catch(function (err) {
    _error("Failed to set expose_new_entities: " + (err.message || err.error || String(err)));
    e.target.checked = !checked;
  });
}

function onReportStateToggle(e) {
  var hass = getHass();
  if (!hass) return;
  var checked = e.target.checked;

  getEntryId().then(function (entryId) {
    hass.callWS({
      type: "google_assistant_manual/update_config",
      entry_id: entryId,
      data: { report_state: checked },
    }).catch(function (err) {
      _error("Failed to update report_state: " + (err.message || err.error || String(err)));
      e.target.checked = !checked;
      _showToast(
        "Failed to " + (checked ? "enable" : "disable") + " state reporting. " +
        "Try toggling the integration off and on, or check Home Assistant logs.",
        true
      );
    });
  }).catch(function (err) {
    _error("onReportStateToggle entry resolution: " + err.message);
    e.target.checked = !checked;
  });
}

function onPinChanged(e) {
  var hass = getHass();
  if (!hass) return;
  var value = e.target.value;

  if (_pinTimer) clearTimeout(_pinTimer);
  _pinTimer = setTimeout(function () {
    getEntryId().then(function (entryId) {
      hass.callWS({
        type: "google_assistant_manual/update_config",
        entry_id: entryId,
        data: { secure_devices_pin: value },
      }).catch(function (err) {
        _error("Failed to update secure_devices_pin: " + (err.message || err.error || String(err)));
      });
    }).catch(function (err) {
      _error("onPinChanged entry resolution: " + err.message);
    });
  }, 500);
}

// ---------------------------------------------------------------------------
// Init — apply all patches, inject cards, start observers
// ---------------------------------------------------------------------------

function init() {
  _info("Companion JS loaded, applying patches (version 0.1.0)");

  // Apply each patch independently — one failing does not block the rest
  try { patchVoiceAssistants(); } catch (e) {
    _error("patchVoiceAssistants threw: " + e.message);
  }
  try { patchSortKey(); } catch (e) {
    _error("patchSortKey threw: " + e.message);
  }
  try { patchCustomElements(); } catch (e) {
    _error("patchCustomElements threw: " + e.message);
  }

  // Initial card injection
  try { injectIntoAllAssistantsElements(); } catch (e) {
    _error("injectIntoAllAssistantsElements threw: " + e.message);
  }

  // Watch for dynamically added assistants page elements
  try {
    var docObserver = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var addedNodes = mutations[i].addedNodes;
        for (var j = 0; j < addedNodes.length; j++) {
          var node = addedNodes[j];
          if (node.nodeType !== 1) continue;
          try {
            var elements = findAllAssistantsElements(node);
            for (var k = 0; k < elements.length; k++) {
              try { injectCardInto(elements[k]); } catch (e) {
                _error("Error injecting card into dynamically added element: " + e.message);
              }
            }
          } catch (e) {
            _debug("Error scanning dynamically added node: " + e.message);
          }
        }
      }
    });
    var target = document.body || document.documentElement;
    if (target) {
      docObserver.observe(target, {
        childList: true,
        subtree: true,
      });
      _debug("MutationObserver active on " + (target === document.body ? "document.body" : "documentElement"));
    } else {
      _warn("Cannot start MutationObserver: no document.body or documentElement");
    }
  } catch (e) {
    _error("Failed to start MutationObserver: " + e.message);
  }

  // Expose page patch (async, runs when element is defined)
  try { patchExposePage(); } catch (e) {
    _error("patchExposePage threw: " + e.message);
  }

  _info("Init complete — all patches applied");
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
