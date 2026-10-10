/**
 * Unit tests for the Google Assistant (Manual) frontend companion.
 *
 * Sets up a jsdom DOM with mocked Home Assistant APIs, evaluates the compiled
 * frontend.js IIFE, and verifies the settings card is injected correctly.
 *
 * We evaluate the JS via new Function() rather than ES module import because
 * vitest's module transform pipeline interferes with the IIFE execution.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module-level setup — read and cache the compiled JS
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, "..");

const FRONTEND_JS_PATH = resolve(
  __dirname,
  "../custom_components/hass_ga_manual_ui/frontend.js",
);
const FRONTEND_JS_CODE = readFileSync(FRONTEND_JS_PATH, "utf8");

// BUILD_VERSION is baked from manifest.json at build time — read it from there.
const MANIFEST_VERSION = JSON.parse(
  readFileSync(
    resolve(__dirname, "../custom_components/hass_ga_manual_ui/manifest.json"),
    "utf8",
  ),
).version as string;

function evalFrontend(): void {
  new Function(FRONTEND_JS_CODE)();
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface MockHass {
  callWS: ReturnType<typeof vi.fn>;
  callService: ReturnType<typeof vi.fn>;
  localize: ReturnType<typeof vi.fn>;
}

function createMockHass(): MockHass {
  return {
    callWS: vi.fn((msg: Record<string, unknown>) => {
      if (msg.type === "hass_ga_manual_ui/get_entry_id") {
        return Promise.resolve({ entry_id: "mock-entry" });
      }
      if (msg.type === "hass_ga_manual_ui/get_config") {
        return Promise.resolve({
          enabled: false,
          report_state: false,
          secure_devices_pin: "",
          yaml_suppressed: false,
        });
      }
      if (
        msg.type === "homeassistant/expose_new_entities/get" ||
        msg.type === "homeassistant/expose_entity/list"
      ) {
        return Promise.resolve({
          expose_new_entities: false,
          exposed_entities: {},
        });
      }
      return Promise.resolve({});
    }),
    callService: vi.fn(),
    localize: vi.fn((key: string) => key),
  };
}

function setupDom(hass: MockHass): void {
  const homeAssistant = document.createElement("home-assistant");
  (homeAssistant as unknown as Record<string, unknown>).hass = hass;
  document.body.appendChild(homeAssistant);

  const assistantsPage = document.createElement(
    "ha-config-voice-assistants-assistants"
  );
  const content = document.createElement("div");
  content.className = "content";
  // The card injection waits for .content to have children before injecting.
  content.appendChild(document.createElement("div"));
  assistantsPage.appendChild(content);
  document.body.appendChild(assistantsPage);
}

async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, 0));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Google Assistant Manual frontend", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    // Card strings are fetched from the static locale endpoint; default to a
    // miss so tests fall back to the bundled EN_STRINGS unless they opt in.
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({ ok: false, json: () => Promise.resolve({}) }),
      ),
    );
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  describe("card injection", () => {
    it("card is not injected when no assistants page exists", () => {
      const hass = createMockHass();
      const ha = document.createElement("home-assistant");
      (ha as unknown as Record<string, unknown>).hass = hass;
      document.body.appendChild(ha);

      evalFrontend();

      const card = document.querySelector("[data-ga-manual-card]");
      expect(card).toBeNull();
    });
  });

  describe("WebSocket calls", () => {
    it("calls WS get_entry_id exactly once", () => {
      const hass = createMockHass();
      setupDom(hass);
      evalFrontend();

      const entryCalls = hass.callWS.mock.calls.filter(
        (c: unknown[]) =>
          typeof c[0] === "object" &&
          (c[0] as Record<string, unknown>).type ===
            "hass_ga_manual_ui/get_entry_id"
      );
      expect(entryCalls.length).toBe(1);
    });

    it("calls WS get_config after entry_id resolves", async () => {
      const hass = createMockHass();
      setupDom(hass);
      evalFrontend();
      await flushMicrotasks();
      await flushMicrotasks();

      const configCalls = hass.callWS.mock.calls.filter(
        (c: unknown[]) =>
          typeof c[0] === "object" &&
          (c[0] as Record<string, unknown>).type ===
            "hass_ga_manual_ui/get_config"
      );
      // At least one (the card); init's page-independent version check adds another.
      expect(configCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("handles failed get_entry_id gracefully", () => {
      const hass = createMockHass();
      hass.callWS.mockRejectedValue(
        new Error("No config entry found for hass_ga_manual_ui")
      );

      setupDom(hass);
      expect(() => evalFrontend()).not.toThrow();
    });

    it("handles failed get_config gracefully", async () => {
      const hass = createMockHass();
      hass.callWS.mockImplementation((msg: Record<string, unknown>) => {
        if (msg.type === "hass_ga_manual_ui/get_entry_id") {
          return Promise.resolve({ entry_id: "abc123" });
        }
        return Promise.reject(new Error("Config read failed"));
      });

      setupDom(hass);
      evalFrontend();
      await flushMicrotasks();
    });
  });

  describe("localization", () => {
    it("fetches the locale file and applies it to the YAML alert", async () => {
      const hass = createMockHass();
      const TRANSLATED =
        "Custom translated YAML notice <code>google_assistant:</code>";
      hass.callWS.mockImplementation((msg: Record<string, unknown>) => {
        if (msg.type === "hass_ga_manual_ui/get_entry_id") {
          return Promise.resolve({ entry_id: "mock-entry" });
        }
        if (msg.type === "hass_ga_manual_ui/get_config") {
          return Promise.resolve({
            enabled: true,
            report_state: false,
            secure_devices_pin: "",
            yaml_suppressed: true,
          });
        }
        return Promise.resolve({});
      });

      const fetchMock = vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({ frontend: { yaml_detected: TRANSLATED } }),
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      setupDom(hass);
      evalFrontend();
      await flushMicrotasks();
      await flushMicrotasks();
      await flushMicrotasks();

      // The locale file for the active language was requested over HTTP.
      expect(fetchMock).toHaveBeenCalledWith(
        "/hass_ga_manual_ui/locale/en.json",
      );

      // The build-time YAML alert text was re-applied from the fetched strings.
      const alert = document
        .querySelector("[data-ga-manual-card]")
        ?.querySelector('ha-alert[alert-type="info"]');
      expect(alert).not.toBeNull();
      expect(alert!.innerHTML).toBe(TRANSLATED);
    });
  });

  describe("stale-version reload prompt", () => {
    function mockHassWithVersion(version: string): MockHass {
      const hass = createMockHass();
      hass.callWS.mockImplementation((msg: Record<string, unknown>) => {
        if (msg.type === "hass_ga_manual_ui/get_entry_id") {
          return Promise.resolve({ entry_id: "mock-entry" });
        }
        if (msg.type === "hass_ga_manual_ui/get_config") {
          return Promise.resolve({
            enabled: true,
            report_state: false,
            secure_devices_pin: "",
            yaml_suppressed: false,
            version,
          });
        }
        if (msg.type === "homeassistant/expose_new_entities/get") {
          return Promise.resolve({ expose_new: false });
        }
        if (msg.type === "homeassistant/expose_entity/list") {
          return Promise.resolve({ exposed_entities: {} });
        }
        return Promise.resolve({});
      });
      return hass;
    }

    // The update prompt is posted as a persistent_notification (consistent with
    // the install one), so assert on callService rather than a toast event.
    function updateNotifications(hass: MockHass): unknown[][] {
      return hass.callService.mock.calls.filter(
        (c: unknown[]) =>
          c[0] === "persistent_notification" &&
          c[1] === "create" &&
          (c[2] as Record<string, unknown> | undefined)?.notification_id ===
            "hass_ga_manual_ui_update",
      );
    }

    it("prompts a reload when the served version differs from the bundle", async () => {
      const hass = mockHassWithVersion("99.0.0-stale");
      setupDom(hass);

      evalFrontend();
      await flushMicrotasks();
      await flushMicrotasks();
      await flushMicrotasks();

      const calls = updateNotifications(hass);
      expect(calls.length).toBeGreaterThanOrEqual(1);
      expect((calls[0][2] as { message: string }).message).toContain(
        "new version",
      );
    });

    it("does not prompt when the served version matches the bundle", async () => {
      const hass = mockHassWithVersion(MANIFEST_VERSION);
      setupDom(hass);

      evalFrontend();
      await flushMicrotasks();
      await flushMicrotasks();
      await flushMicrotasks();

      expect(updateNotifications(hass).length).toBe(0);
      expect(hass.callService).toHaveBeenCalledWith(
        "persistent_notification",
        "dismiss",
        { notification_id: "hass_ga_manual_ui_update" },
      );
    });

    it("prompts a reload even when the Assistants page is never opened", async () => {
      // Only the home-assistant root — no assistants page, so the card never
      // builds. The prompt must still fire from the init-time version check.
      const hass = mockHassWithVersion("99.0.0-stale");
      const homeAssistant = document.createElement("home-assistant");
      (homeAssistant as unknown as Record<string, unknown>).hass = hass;
      document.body.appendChild(homeAssistant);

      evalFrontend();
      await flushMicrotasks();
      await flushMicrotasks();
      await flushMicrotasks();

      expect(document.querySelector("[data-ga-manual-card]")).toBeNull();
      const calls = updateNotifications(hass);
      expect(calls.length).toBeGreaterThanOrEqual(1);
      expect((calls[0][2] as { message: string }).message).toContain(
        "new version",
      );
    });
  });

  describe("global patches", () => {
    it("Object.keys still works normally after patching", () => {
      evalFrontend();
      const obj = { a: 1, b: 2, c: 3 };
      expect(Object.keys(obj)).toEqual(["a", "b", "c"]);
    });

    it("Array.prototype.forEach still works normally after patching", () => {
      evalFrontend();
      const items: number[] = [];
      [1, 2, 3].forEach((n) => items.push(n * 2));
      expect(items).toEqual([2, 4, 6]);
    });
  });

  describe("error resilience", () => {
    it("does not throw when evaluated with empty DOM", () => {
      expect(() => evalFrontend()).not.toThrow();
    });
  });

  // Icons are patched at render() level: our assistant returns a stable node
  // (self-hosted, never the CDN) that survives Lit reusing the element.
  describe("custom element icon patches", () => {
    // Custom elements can only be defined once per realm; reuse across tests.
    class FakeBrandIcon extends HTMLElement {
      voiceAssistantId = "";
      hass: unknown = { localize: (k: string) => k };
      render() {
        return "ORIG:" + this.voiceAssistantId;
      }
    }
    class FakeExposeIcon extends HTMLElement {
      assistant = "";
      hass: unknown = { localize: (k: string) => k };
      manual = false;
      unsupported = false;
      render() {
        return "ORIG:" + this.assistant;
      }
    }
    if (!customElements.get("voice-assistant-brand-icon")) {
      customElements.define("voice-assistant-brand-icon", FakeBrandIcon);
    }
    if (!customElements.get("voice-assistants-expose-assistant-icon")) {
      customElements.define(
        "voice-assistants-expose-assistant-icon",
        FakeExposeIcon,
      );
    }

    it("brand icon renders our self-hosted icon node for our assistant", () => {
      evalFrontend();
      const el = document.createElement(
        "voice-assistant-brand-icon",
      ) as unknown as FakeBrandIcon;
      el.voiceAssistantId = "hass_ga_manual_ui";

      const node = el.render() as unknown as HTMLImageElement;
      expect(node).toBeInstanceOf(HTMLImageElement);
      expect(node.dataset.gaManual).toBe("1");
      // Self-hosted, never the brands CDN.
      expect(node.getAttribute("src")).toContain("/hass_ga_manual_ui/brand/");
    });

    it("brand icon returns a stable node across re-renders (Lit safe)", () => {
      evalFrontend();
      const el = document.createElement(
        "voice-assistant-brand-icon",
      ) as unknown as FakeBrandIcon;
      el.voiceAssistantId = "hass_ga_manual_ui";

      expect(el.render()).toBe(el.render());
    });

    it("brand icon delegates to HA for non-manual assistants (recycling)", () => {
      evalFrontend();
      const el = document.createElement(
        "voice-assistant-brand-icon",
      ) as unknown as FakeBrandIcon;

      // Element first shows our assistant, then is reused for another id.
      el.voiceAssistantId = "hass_ga_manual_ui";
      expect(el.render()).toBeInstanceOf(HTMLImageElement);

      el.voiceAssistantId = "cloud.google_assistant";
      // No stale node leaks — HA's own render result is returned.
      expect(el.render()).toBe("ORIG:cloud.google_assistant");
    });

    it("expose icon renders our icon + tooltip for our assistant", () => {
      evalFrontend();
      const el = document.createElement(
        "voice-assistants-expose-assistant-icon",
      ) as unknown as FakeExposeIcon;
      el.assistant = "hass_ga_manual_ui";

      const node = el.render() as unknown as HTMLElement;
      expect(node).toBeInstanceOf(HTMLElement);
      expect(node.dataset.gaManual).toBe("1");
      const img = node.querySelector<HTMLImageElement>("img[data-ga-manual]");
      expect(img).not.toBeNull();
      expect(img!.getAttribute("src")).toContain("/hass_ga_manual_ui/brand/");
      expect(node.querySelector("ha-tooltip")).not.toBeNull();
    });

    it("expose icon rebuilds only when its props change", () => {
      evalFrontend();
      const el = document.createElement(
        "voice-assistants-expose-assistant-icon",
      ) as unknown as FakeExposeIcon;
      el.assistant = "hass_ga_manual_ui";

      const first = el.render();
      expect(el.render()).toBe(first); // same props → stable node
      el.manual = true;
      expect(el.render()).not.toBe(first); // prop change → rebuilt
    });

    it("expose icon delegates to HA for non-manual assistants (recycling)", () => {
      evalFrontend();
      const el = document.createElement(
        "voice-assistants-expose-assistant-icon",
      ) as unknown as FakeExposeIcon;

      el.assistant = "hass_ga_manual_ui";
      expect(el.render()).toBeInstanceOf(HTMLElement);

      el.assistant = "conversation";
      expect(el.render()).toBe("ORIG:conversation");
    });
  });

  it("patches real exposure classes when HA replaces the custom element registry", async () => {
    const hass = createMockHass();
    const callWS = vi.fn((msg: Record<string, unknown>) => Promise.resolve(msg));
    hass.callWS = callWS;
    const homeAssistant = document.createElement("home-assistant");
    (homeAssistant as unknown as { hass: MockHass }).hass = hass;
    document.body.appendChild(homeAssistant);

    // The scoped registry retains the intercepted native define, registering
    // empty stand-ins there while get() on the replacement returns real classes.
    const nativeDefine = vi.spyOn(customElements, "define").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      evalFrontend();
      const interceptedDefine = customElements.define;
      const definitions = new Map<string, CustomElementConstructor>();
      const replacement = {
        get: (name: string) => definitions.get(name),
        define(name: string, cls: CustomElementConstructor) {
          definitions.set(name, cls);
          interceptedDefine.call(customElements, name, class extends HTMLElement {});
        },
      } as unknown as CustomElementRegistry;
      vi.stubGlobal("customElements", replacement);

      const assistants: Record<string, { domain: string; name: string }> = {
        conversation: { domain: "assist_pipeline", name: "Assist" },
        "cloud.alexa": { domain: "alexa", name: "Amazon Alexa" },
        "cloud.google_assistant": { domain: "google_assistant", name: "Google Assistant" },
      };
      class FilterProbe {
        firstUpdated() {
          Object.keys(assistants);
        }
      }
      definitions.set("ha-filter-voice-assistants", FilterProbe as unknown as CustomElementConstructor);

      class ExposePage extends HTMLElement {
        _searchParms = new URLSearchParams();
        get _availableAssistants() {
          return ["conversation"];
        }
        _addEntry() {
          const ids = this._searchParms.has("assistants")
            ? this._searchParms.get("assistants")!.split(",")
            : this._availableAssistants;
          return {
            names: ids.map((id) => assistants[id].name),
            exposeEntities: (entities: string[]) => callWS({
              type: "homeassistant/expose_entity",
              assistants: ids,
              entity_ids: entities,
              should_expose: true,
            }),
          };
        }
      }
      warn.mockClear();
      replacement.define("ha-config-voice-assistants-expose", ExposePage);
      const page = Object.create(ExposePage.prototype) as ExposePage;
      page._searchParms = new URLSearchParams();
      const dialog = page._addEntry();
      expect(dialog.names).toEqual(["Assist", "Google Assistant (Manual)"]);
      await dialog.exposeEntities(["light.demo"]);
      expect(hass.callWS).toHaveBeenCalledWith({
        type: "homeassistant/expose_entity",
        assistants: ["conversation", "hass_ga_manual_ui"],
        entity_ids: ["light.demo"],
        should_expose: true,
      });
      // The assistant card links to this filtered route. Without priming the
      // real map, HA's dialog throws while resolving the assistant's name.
      page._searchParms.set("assistants", "hass_ga_manual_ui");
      expect(page._addEntry().names).toEqual(["Google Assistant (Manual)"]);

      // Later registrations use the new hook synchronously and do not rewrap
      // previously patched classes when they pass through the native hook.
      const patchedAddEntry = ExposePage.prototype._addEntry;
      class CloudDiscover extends HTMLElement {
        render() { return "CLOUD PROMOTION"; }
      }
      const originalRender = CloudDiscover.prototype.render;
      replacement.define("cloud-discover", CloudDiscover);
      expect(CloudDiscover.prototype.render).not.toBe(originalRender);
      expect(ExposePage.prototype._addEntry).toBe(patchedAddEntry);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      nativeDefine.mockRestore();
      warn.mockRestore();
    }
  });

  // We wrap render() to neutralise HA's splice bug, which drops our id from the
  // list driving the master Expose toggle and per-assistant row visibility.
  describe("entity dialog master expose toggle", () => {
    // Mirrors HA's render() assistant-list computation, including the splice
    // bug. Cloud enablement is configurable to cover mixed cloud setups.
    class FakeEntityVoiceSettings extends HTMLElement {
      static voiceAssistants: Record<string, { domain: string; name: string }> = {
        conversation: { domain: "assist_pipeline", name: "Assist" },
        "cloud.alexa": { domain: "cloud", name: "Amazon Alexa" },
        "cloud.google_assistant": { domain: "cloud", name: "Google Assistant" },
      };
      exposed: Record<string, boolean> = {};
      googleEnabled = false;
      alexaEnabled = false;
      uiAssistants: string[] = [];
      showAssistants: string[] = [];
      anyExposed = false;
      // Fields HA's element exposes that our patches read.
      hass: unknown;
      entityId?: string;
      _unsupported: Record<string, boolean> = {};
      requestUpdate = vi.fn();
      // HA's originals (our patch wraps them); record call order + the event
      // target they receive, for assertions.
      order: string[] = [];
      lastTarget: unknown = null;
      _toggleAll(ev: { target: unknown }) {
        this.order.push("orig-all");
        this.lastTarget = ev?.target ?? null;
      }
      _toggleAssistant(ev: { target: unknown }) {
        this.order.push("orig-assistant");
        this.lastTarget = ev?.target ?? null;
      }
      render() {
        const voiceAssistants = FakeEntityVoiceSettings.voiceAssistants;
        const showAssistants = [...Object.keys(voiceAssistants)];
        const uiAssistants = [...showAssistants];
        if (!this.googleEnabled) {
          showAssistants.splice(showAssistants.indexOf("cloud.google_assistant"), 1);
          uiAssistants.splice(showAssistants.indexOf("cloud.google_assistant"), 1);
        }
        if (!this.alexaEnabled) {
          showAssistants.splice(showAssistants.indexOf("cloud.alexa"), 1);
          uiAssistants.splice(showAssistants.indexOf("cloud.alexa"), 1);
        }
        this.showAssistants = showAssistants;
        this.uiAssistants = uiAssistants;
        this.anyExposed = uiAssistants.some((k) => this.exposed[k]);
        return null;
      }
    }
    if (!customElements.get("entity-voice-settings")) {
      customElements.define("entity-voice-settings", FakeEntityVoiceSettings);
    }

    const make = () =>
      document.createElement(
        "entity-voice-settings",
      ) as unknown as FakeEntityVoiceSettings;

    // Regression: Alexa cloud on, Google cloud off (a plausible manual-Google
    // setup). The fix must keep enabled Alexa and drop disabled Google cloud —
    // i.e. not diverge from stock HA — while still including our assistant.
    it("does not corrupt cloud rows in mixed cloud setups", () => {
      evalFrontend();
      const el = make();
      el.alexaEnabled = true;
      el.googleEnabled = false;
      el.render();

      expect(el.uiAssistants).toContain("cloud.alexa");
      expect(el.uiAssistants).not.toContain("cloud.google_assistant");
      expect(el.uiAssistants).toContain("hass_ga_manual_ui");
    });

    it("marks our assistant unsupported when the backend says not_supported", async () => {
      evalFrontend();
      const el = make();
      el.entityId = "light.demo";
      el.hass = {
        callWS: vi.fn(() => Promise.reject({ code: "not_supported" })),
      };

      (el as unknown as { updated: (m: Map<string, unknown>) => void }).updated(
        new Map(),
      );
      await new Promise((r) => setTimeout(r, 0));

      expect(el._unsupported["hass_ga_manual_ui"]).toBe(true);
      expect(el.requestUpdate).toHaveBeenCalled();
    });

    it("keeps our assistant supported when the backend returns entity info", async () => {
      evalFrontend();
      const el = make();
      el.entityId = "light.demo";
      el.hass = {
        callWS: vi.fn(() =>
          Promise.resolve({
            entity_id: "light.demo",
            might_2fa: false,
            disable_2fa: false,
          }),
        ),
      };

      (el as unknown as { updated: (m: Map<string, unknown>) => void }).updated(
        new Map(),
      );
      await new Promise((r) => setTimeout(r, 0));

      expect(el._unsupported["hass_ga_manual_ui"]).toBeUndefined();
    });

    it.each([
      ["_toggleAll", { checked: true, assistants: ["conversation", "hass_ga_manual_ui"] }, "orig-all"],
      ["_toggleAssistant", { checked: false, assistant: "hass_ga_manual_ui" }, "orig-assistant"],
    ] as const)("%s waits for the response before delegating", async (method, target, original) => {
      evalFrontend();
      const el = make();
      el.entityId = "light.demo";
      let resolveWrite!: (value: object) => void;
      const pendingWrite = new Promise<object>((finish) => { resolveWrite = finish; });
      const callWS = vi.fn((msg: { type: string }) => {
        if (msg.type === "homeassistant/expose_entity") el.order.push("expose");
        return pendingWrite;
      });
      el.hass = { callWS };

      const toggle = (el as unknown as Record<string, (e: unknown) => Promise<void>>)[method].call(el, { target });
      await flushMicrotasks();
      expect(el.order).toEqual(["expose"]);
      expect(callWS).toHaveBeenCalledWith({
        type: "homeassistant/expose_entity",
        assistants: method === "_toggleAll" ? ["conversation", "hass_ga_manual_ui"] : ["hass_ga_manual_ui"],
        entity_ids: ["light.demo"],
        should_expose: target.checked,
      });
      resolveWrite({});
      await toggle;
      expect(el.order).toEqual(["expose", original]);
    });

    // The switch's reactive props are reset after our await (intervening
    // re-render). HA's handler must receive a synchronous snapshot, not the
    // reset target, or it sends a malformed expose_entity call.
    it("passes HA's handler a snapshot, not the reset switch target", async () => {
      evalFrontend();
      const el = make();
      el.entityId = "light.demo";
      el.hass = { callWS: vi.fn(() => Promise.resolve({})) };

      const target = {
        checked: true,
        assistants: ["conversation", "hass_ga_manual_ui"],
      };
      const p = (
        el as unknown as { _toggleAll: (e: unknown) => Promise<void> }
      )._toggleAll({ target });
      // Simulate the browser/Lit resetting the switch after dispatch.
      target.checked = undefined as unknown as boolean;
      target.assistants = undefined as unknown as string[];
      await p;

      expect(el.lastTarget).toEqual({
        checked: true,
        assistants: ["conversation", "hass_ga_manual_ui"],
        assistant: undefined,
      });
    });
  });

  describe("YAML import error handling", () => {
    const flush = () => new Promise<void>((r) => setTimeout(r, 0));

    function importButton(): HTMLElement {
      class FakeDataEntryFlowDialog extends HTMLElement {
        _params?: { domain?: string; flowConfig?: { flowType?: string } };
        _step?: { type?: string };
        updated(_changedProps: Map<string, unknown>) {}
      }
      if (!customElements.get("dialog-data-entry-flow")) {
        customElements.define("dialog-data-entry-flow", FakeDataEntryFlowDialog);
      }

      const dialog = document.createElement(
        "dialog-data-entry-flow",
      ) as unknown as FakeDataEntryFlowDialog;
      dialog._params = {
        domain: "hass_ga_manual_ui",
        flowConfig: { flowType: "options_flow" },
      };
      dialog._step = { type: "form" };
      const root = dialog.attachShadow({ mode: "open" });
      root.appendChild(document.createElement("ha-dialog-footer"));
      dialog.updated(new Map());

      return root.querySelector<HTMLElement>("[data-ga-options-yaml=import]")!;
    }

    // Pick a file on the (already clicked) import flow and wait for the dialog.
    async function pickFileAndOpenDialog(): Promise<HTMLElement> {
      importButton().dispatchEvent(new Event("click"));
      const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
      const file = new File(["google_assistant:\n  project_id: p\n"], "c.yaml", {
        type: "text/yaml",
      });
      Object.defineProperty(input, "files", { value: [file], configurable: true });
      input.dispatchEvent(new Event("change"));
      await flush();
      return document.querySelector<HTMLElement>("[data-ga-confirm-dialog]")!;
    }

    it("import failure shows a visible error toast with the server reason", async () => {
      const hass = createMockHass();
      hass.callWS.mockImplementation((msg: Record<string, unknown>) => {
        if (msg.type === "hass_ga_manual_ui/get_entry_id") {
          return Promise.resolve({ entry_id: "e1" });
        }
        if (msg.type === "hass_ga_manual_ui/import_config") {
          return Promise.reject({
            code: "import_failed",
            message: "Invalid JWT Signature",
          });
        }
        return Promise.resolve({});
      });
      setupDom(hass);
      evalFrontend();
      await flush();

      const toasts: Record<string, unknown>[] = [];
      document.addEventListener("hass-notification", (e) =>
        toasts.push((e as CustomEvent).detail),
      );

      const dialog = await pickFileAndOpenDialog();
      dialog.querySelector<HTMLElement>("[data-ga-confirm]")!.dispatchEvent(
        new Event("click"),
      );
      await flush();
      await flush();

      expect(toasts).toHaveLength(1);
      expect(toasts[0].message).toContain("Failed to import configuration");
      expect(toasts[0].message).toContain("Invalid JWT Signature");
      // HA hides a toast when duration === 0, so an error must use a visible duration.
      expect(toasts[0].duration).not.toBe(0);
    });
  });

});
