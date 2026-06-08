/**
 * Google Assistant (Manual) — Frontend companion module.
 * Patches the HA frontend at runtime so the integration appears in the
 * voice assistants UI alongside the built-in cloud assistants.
 */

const ASSISTANT_ID = "google_assistant_manual";
const ASSISTANT_NAME = "Google Assistant (Manual)";
const SORT_TARGET = ["conversation", "cloud.alexa", "cloud.google_assistant"];
const ASSET_URL = "/google_assistant_manual/assets";

function getBrandIconUrl() {
  return `${ASSET_URL}/icon.png`;
}

// ---------------------------------------------------------------------------
// 1. Inject our key into voiceAssistants (from data/expose.ts)
// ---------------------------------------------------------------------------

function patchVoiceAssistants() {
  const origKeys = Object.keys;
  const seen = new WeakSet();

  Object.keys = function (obj) {
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
      }
    }
    return origKeys(obj);
  };
}

// ---------------------------------------------------------------------------
// 2. Intercept Array.prototype.forEach to fix the sort key
// ---------------------------------------------------------------------------

function patchSortKey() {
  const origForEach = Array.prototype.forEach;

  Array.prototype.forEach = function (callback, thisArg) {
    if (
      this.length === SORT_TARGET.length &&
      SORT_TARGET.every((v, i) => this[i] === v) &&
      !this.includes(ASSISTANT_ID)
    ) {
      this.push(ASSISTANT_ID);
    }
    return origForEach.call(this, callback, thisArg);
  };
}

// ---------------------------------------------------------------------------
// 3. Wrap _availableAssistants getter on the expose page
// ---------------------------------------------------------------------------

function findExposeElement(root) {
  if (!root) return null;
  if (root.nodeType !== 1 && root.nodeType !== 11) return null;
  if (root.nodeName === "HA-CONFIG-VOICE-ASSISTANTS-EXPOSE") return root;
  if (root.shadowRoot) {
    const found = findExposeElement(root.shadowRoot);
    if (found) return found;
  }
  const children = root.children || [];
  for (const child of children) {
    const found = findExposeElement(child);
    if (found) return found;
  }
  return null;
}

async function patchExposePage() {
  await customElements.whenDefined("ha-config-voice-assistants-expose");
  const cls = customElements.get("ha-config-voice-assistants-expose");
  if (!cls) return;

  const desc = Object.getOwnPropertyDescriptor(
    cls.prototype,
    "_availableAssistants"
  );
  if (!desc || !desc.get) return;

  const orig = desc.get;
  Object.defineProperty(cls.prototype, "_availableAssistants", {
    get() {
      const result = orig.call(this);
      return Array.isArray(result) && !result.includes(ASSISTANT_ID)
        ? [...result, ASSISTANT_ID]
        : result;
    },
  });

  const el =
    document.querySelector("ha-config-voice-assistants-expose") ||
    findExposeElement(document.documentElement);
  if (el) el.requestUpdate();
}

// ---------------------------------------------------------------------------
// 4. Patch custom element prototypes (both new definitions and retroactive)
// ---------------------------------------------------------------------------

function _patchAssistantsPageProto(proto) {
  const origConnected = proto.connectedCallback;
  const origFirstUpdated = proto.firstUpdated;
  const origUpdated = proto.updated;

  // connectedCallback is the most reliable hook — Lit lifecycle hooks may
  // have already fired before our patches ran (common on hard refresh).
  proto.connectedCallback = function () {
    if (origConnected) origConnected.call(this);
    const self = this;
    // Defer so shadowRoot and initial render have settled
    requestAnimationFrame(function () {
      injectCardInto(self);
    });
  };

  proto.firstUpdated = function (changedProps) {
    origFirstUpdated.call(this, changedProps);
    injectCardInto(this);
  };
  proto.updated = function (changedProps) {
    origUpdated.call(this, changedProps);
    injectCardInto(this);
  };
}

function _renderManualBrandIcon() {
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
  root.appendChild(img);
}

function _patchBrandIconProto(proto) {
  const origRender = proto.render;
  const origFirstUpdated = proto.firstUpdated;
  const origUpdated = proto.updated;
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
}

function _renderManualExposeIcon() {
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
    alertIcon.icon = "mdi:alert-circle";
    alertIcon.classList.add("unsupported");
    container.appendChild(alertIcon);
  }
  root.appendChild(container);

  const tooltip = document.createElement("ha-tooltip");
  tooltip.setAttribute("for", containerId);
  tooltip.setAttribute("placement", "left");
  if (!this.unsupported && !this.manual) tooltip.setAttribute("disabled", "");

  const localize = this.hass && this.hass.localize;
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
}

function _patchExposeAssistantIconProto(proto) {
  const origRender = proto.render;
  const origFirstUpdated = proto.firstUpdated;
  const origUpdated = proto.updated;
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
}

const PATCHERS = {
  "ha-config-voice-assistants-assistants": _patchAssistantsPageProto,
  "voice-assistant-brand-icon": _patchBrandIconProto,
  "voice-assistants-expose-assistant-icon": _patchExposeAssistantIconProto,
};

function patchCustomElements() {
  const origDefine = customElements.define;

  customElements.define = function (name, constructor, options) {
    const patcher = PATCHERS[name];
    if (patcher) patcher(constructor.prototype);
    return origDefine.call(this, name, constructor, options);
  };

  for (const name in PATCHERS) {
    const cls = customElements.get(name);
    if (cls) PATCHERS[name](cls.prototype);
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

const _observerActive = new WeakSet();

const INSERTION_LOOKUP = [
  { selector: "assist-pref", before: false },
  { selector: "assist-current-device-pref", before: false },
  { selector: "cloud-discover", before: true },
  { selector: "cloud-google-pref", before: true },
];

function findInsertionPoint(content) {
  for (const { selector, before } of INSERTION_LOOKUP) {
    const el = content.querySelector(selector);
    if (el) return { ref: el, before };
  }
  return { ref: null, before: false };
}

function makeSettingItem(hass, headlineKey, supportKey, headlineFallback, supportFallback) {
  const item = document.createElement("ha-md-list-item");
  item.style.cssText = `--md-list-item-leading-space:0;--md-list-item-trailing-space:0;--md-item-overflow:visible`;
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

function makeSwitchSettingItem(hass, headlineKey, supportKey, headlineFallback, supportFallback, handler) {
  const item = makeSettingItem(hass, headlineKey, supportKey, headlineFallback, supportFallback);
  const sw = document.createElement("ha-switch");
  sw.slot = "end";
  if (handler) sw.addEventListener("change", handler);
  item.appendChild(sw);
  return item;
}

function buildCard() {
  const homeAssistant = document.querySelector("home-assistant");
  const hass = homeAssistant && homeAssistant.hass;

  const brandIcon = document.createElement("voice-assistant-brand-icon");
  brandIcon.voiceAssistantId = ASSISTANT_ID;
  brandIcon.hass = hass;
  brandIcon.style.cssText = `height:28px;margin-right:16px;margin-inline-end:16px;margin-inline-start:initial`;

  const card = document.createElement("ha-card");
  card.setAttribute("outlined", "");
  card.setAttribute("data-ga-manual-card", "1");

  const header = document.createElement("h1");
  header.className = "card-header";
  header.style.cssText = `display:flex;align-items:center;position:relative`;
  header.appendChild(brandIcon);
  header.appendChild(document.createTextNode(ASSISTANT_NAME));
  card.appendChild(header);

  const headerActions = document.createElement("div");
  headerActions.style.cssText = `position:absolute;right:24px;inset-inline-end:24px;inset-inline-start:initial;top:50%;transform:translateY(-50%);display:flex;flex-direction:row;align-items:center`;
  const helpBtn = document.createElement("ha-icon-button");
  helpBtn.label = "Learn how it works";
  helpBtn.href = "https://www.home-assistant.io/integrations/google_assistant/";
  helpBtn.target = "_blank";
  helpBtn.rel = "noreferrer";
  helpBtn.style.cssText = `display:flex;align-items:center;margin-right:8px;margin-inline-end:8px;margin-inline-start:initial;direction:var(--direction);color:var(--secondary-text-color)`;
  const helpIcon = document.createElement("ha-icon");
  helpIcon.icon = "mdi:help-circle-outline";
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
    (hass && hass.localize("ui.panel.config.cloud.account.google.info") || "")
      .replace(/\s*Cloud\b/g, "") ||
    "With the Google Assistant integration for Home Assistant, you'll be able to control all your Home Assistant devices via any Google Assistant-enabled device.";
  body.appendChild(desc);

  const settingsRows = [];

  function addSetting(el) {
    settingsRows.push(el);
    body.appendChild(el);
  }

  addSetting(
    makeSwitchSettingItem(
      hass,
      "ui.panel.config.voice_assistants.expose.expose_new_entities",
      "ui.panel.config.voice_assistants.expose.expose_new_entities_info",
      "Expose new entities",
      "Should new entities be exposed? Exposes supported devices that are not classified as security devices.",
      onExposeToggle
    )
  );

  addSetting(
    makeSwitchSettingItem(
      hass,
      "ui.panel.config.cloud.account.google.enable_state_reporting",
      "ui.panel.config.cloud.account.google.info_state_reporting",
      "Enable state reporting",
      "If you enable state reporting, Home Assistant will send all state changes of exposed entities to Google. This speeds up voice commands and allows you to always see the latest states in the Google app.",
      null
    )
  );

  addSetting(
    makeSettingItem(
      hass,
      "ui.panel.config.cloud.account.google.security_devices",
      "ui.panel.config.cloud.account.google.enter_pin_info",
      "Security devices",
      "Please enter a PIN to interact with security devices. Security devices are doors, garage doors, and locks. You will be asked to say/enter this PIN when interacting with security devices via Google Assistant."
    )
  );

  const pinInput = document.createElement("ha-input");
  pinInput.label =
    (hass && hass.localize("ui.panel.config.cloud.account.google.devices_pin")) ||
    "Security devices PIN";
  pinInput.placeholder =
    (hass && hass.localize("ui.panel.config.cloud.account.google.enter_pin_hint")) ||
    "Enter a PIN to use security devices";
  pinInput.style.cssText = `width:250px;margin-top:8px`;
  addSetting(pinInput);

  globalSwitch.addEventListener("change", function () {
    const visible = globalSwitch.checked;
    for (let i = 0; i < settingsRows.length; i++) {
      settingsRows[i].style.display = visible ? "" : "none";
    }
  });

  card.appendChild(body);

  const actions = document.createElement("div");
  actions.className = "card-actions";
  actions.style.cssText = "display:flex";

  const exposeLink = document.createElement("a");
  exposeLink.href = `/config/voice-assistants/expose?assistants=${ASSISTANT_ID}&historyBack`;
  exposeLink.style.textDecoration = "none";

  const exposeBtn = document.createElement("ha-button");
  exposeBtn.setAttribute("appearance", "plain");
  exposeBtn.textContent = "Exposed entities";
  exposeBtn.setAttribute("data-ga-count", "");
  exposeLink.appendChild(exposeBtn);
  actions.appendChild(exposeLink);

  card.appendChild(actions);

  settingsRows.push(actions);

  for (let i = 0; i < settingsRows.length; i++) {
    settingsRows[i].style.display = "none";
  }

  return card;
}

/**
 * Inject the card into a ha-config-voice-assistants-assistants element.
 * Idempotent — safe to call at any time (lifecycle hooks, DOM scans, observers).
 */
function injectCardInto(el) {
  if (!el) return;

  const root = el.shadowRoot || el;
  const content = root.querySelector(".content");
  if (!content) return;

  if (content.querySelector("[data-ga-manual-card]")) {
    _observerActive.delete(el);
    return;
  }

  if (content.children.length === 0) {
    if (!_observerActive.has(el)) {
      _observerActive.add(el);
      const obs = new MutationObserver(function () {
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

  console.log("[GA Manual] injecting card");

  const card = buildCard();
  const point = findInsertionPoint(content);

  if (point.ref && point.before) {
    point.ref.insertAdjacentElement("beforebegin", card);
  } else if (point.ref) {
    point.ref.insertAdjacentElement("afterend", card);
  } else {
    content.appendChild(card);
  }

  refreshExposeToggle(card);
}

/**
 * Recursively search a DOM tree (including all shadow roots) for
 * ha-config-voice-assistants-assistants elements.
 */
function findAllAssistantsElements(root) {
  const results = [];
  if (!root) return results;
  if (root.nodeType !== 1 && root.nodeType !== 11) return results;

  if (root.nodeName === "HA-CONFIG-VOICE-ASSISTANTS-ASSISTANTS") {
    results.push(root);
  }

  if (root.shadowRoot) {
    results.push(...findAllAssistantsElements(root.shadowRoot));
  }

  const children = root.children || root.childNodes || [];
  for (let i = 0; i < children.length; i++) {
    results.push(...findAllAssistantsElements(children[i]));
  }

  return results;
}

/**
 * Scan the entire DOM (including all shadow roots) for assistants page
 * elements and inject the card into each.
 */
function injectIntoAllAssistantsElements() {
  const elements = findAllAssistantsElements(document.documentElement);
  for (let i = 0; i < elements.length; i++) {
    injectCardInto(elements[i]);
  }
}

function refreshExposeToggle(card) {
  const homeAssistant = document.querySelector("home-assistant");
  const hass = homeAssistant && homeAssistant.hass;
  if (!hass) return;
  const sw = card.querySelector("ha-switch");
  const btn = card.querySelector("[data-ga-count]");
  Promise.all([
    hass.callWS({ type: "homeassistant/expose_new_entities/get", assistant: ASSISTANT_ID }),
    hass.callWS({ type: "homeassistant/expose_entity/list" }),
  ]).then(function (results) {
    if (sw) sw.checked = results[0].expose_new;
    if (!btn) return;
    const count = Object.values(results[1].exposed_entities).filter(function (s) {
      return s[ASSISTANT_ID];
    }).length;
    btn.textContent = hass.localize
      ? hass.localize("ui.panel.config.voice_assistants.assistants.pipeline.exposed_entities", { number: count })
      : `${count} exposed entities`;
  });
}

function onExposeToggle(e) {
  const homeAssistant = document.querySelector("home-assistant");
  const hass = homeAssistant && homeAssistant.hass;
  if (!hass) return;
  const checked = e.target.checked;
  hass.callWS({
    type: "homeassistant/expose_new_entities/set",
    assistant: ASSISTANT_ID,
    expose_new: checked,
  }).catch(function () {
    e.target.checked = !checked;
  });
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function init() {
  console.log("[GA Manual] companion JS loaded, applying patches");
  patchVoiceAssistants();
  patchSortKey();
  patchCustomElements();

  injectIntoAllAssistantsElements();

  const docObserver = new MutationObserver(function (mutations) {
    for (let i = 0; i < mutations.length; i++) {
      const addedNodes = mutations[i].addedNodes;
      for (let j = 0; j < addedNodes.length; j++) {
        const node = addedNodes[j];
        if (node.nodeType !== 1) continue;
        const elements = findAllAssistantsElements(node);
        for (let k = 0; k < elements.length; k++) {
          injectCardInto(elements[k]);
        }
      }
    }
  });
  docObserver.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true,
  });

  patchExposePage();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
