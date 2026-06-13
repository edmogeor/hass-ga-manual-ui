/**
 * Integration tests for the Google Assistant (Manual) frontend companion.
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
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
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
    it("injects a card into ha-config-voice-assistants-assistants", () => {
      const hass = createMockHass();
      setupDom(hass);
      evalFrontend();

      const card = document.querySelector("[data-ga-manual-card]");
      expect(card).not.toBeNull();
    });

    it("card is an ha-card with outlined attribute", () => {
      const hass = createMockHass();
      setupDom(hass);
      evalFrontend();

      const card = document.querySelector("[data-ga-manual-card]");
      expect(card).not.toBeNull();
      expect(card!.tagName).toBe("HA-CARD");
      expect(card!.hasAttribute("outlined")).toBe(true);
    });

    it("card contains the assistant name in header", () => {
      const hass = createMockHass();
      setupDom(hass);
      evalFrontend();

      const card = document.querySelector("[data-ga-manual-card]");
      const header = card!.querySelector("h1.card-header");
      expect(header).not.toBeNull();
      expect(header!.textContent).toContain("Google Assistant (Manual)");
    });

    it("card header has our bundled brand icon", () => {
      const hass = createMockHass();
      setupDom(hass);
      evalFrontend();

      const card = document.querySelector("[data-ga-manual-card]");
      const icon = card!.querySelector<HTMLImageElement>("img[data-ga-manual]");
      expect(icon).not.toBeNull();
      // Served locally, not from the brands CDN.
      expect(icon!.getAttribute("src")).toBe("/hass_ga_manual_ui/brand/icon.png");
    });

    it("card body contains settings rows", () => {
      const hass = createMockHass();
      setupDom(hass);
      evalFrontend();

      const card = document.querySelector("[data-ga-manual-card]");
      const body = card!.querySelector(".card-content");
      expect(body).not.toBeNull();

      const rows = body!.querySelectorAll("ha-md-list-item");
      expect(rows.length).toBe(3);
    });

    it("card has an expose new entities switch", () => {
      const hass = createMockHass();
      setupDom(hass);
      evalFrontend();

      const card = document.querySelector("[data-ga-manual-card]");
      const switches = card!.querySelectorAll("ha-md-list-item ha-switch");
      expect(switches.length).toBeGreaterThanOrEqual(1);
    });

    it("card has a description paragraph", () => {
      const hass = createMockHass();
      setupDom(hass);
      evalFrontend();

      const card = document.querySelector("[data-ga-manual-card]");
      const desc = card!.querySelector(".card-content p");
      expect(desc).not.toBeNull();
      expect(desc!.textContent!.length).toBeGreaterThan(0);
    });

    it("card has a PIN input for secure devices", () => {
      const hass = createMockHass();
      setupDom(hass);
      evalFrontend();

      const card = document.querySelector("[data-ga-manual-card]");
      const inputs = card!.querySelectorAll("ha-input, input");
      expect(inputs.length).toBeGreaterThanOrEqual(1);
    });

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

  describe("global toggle state", () => {
    it("global toggle stays on after refreshExposeToggle (not clobbered)", async () => {
      // Regression: refreshExposeToggle did card.querySelector("ha-switch"),
      // which matched the header's global toggle (first switch in the card)
      // and reset it to expose_new (false) — instantly reverting the enable.
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

      setupDom(hass);
      evalFrontend();
      // Let refreshCardState + refreshExposeToggle (Promise.all) settle.
      await flushMicrotasks();
      await flushMicrotasks();
      await flushMicrotasks();

      const card = document.querySelector("[data-ga-manual-card]");
      const globalSwitch = card!.querySelector<HTMLInputElement>(
        "h1.card-header ha-switch",
      );
      expect(globalSwitch).not.toBeNull();
      expect(globalSwitch!.checked).toBe(true);
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

  describe("assistant card idempotency", () => {
    it("evaluating twice does not inject duplicate cards", () => {
      const hass = createMockHass();
      setupDom(hass);

      evalFrontend();
      evalFrontend();

      const cards = document.querySelectorAll("[data-ga-manual-card]");
      expect(cards.length).toBe(1);
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

  // We wrap render() to neutralise HA's splice bug, which drops our id from the
  // list driving the master Expose toggle and per-assistant row visibility.
  describe("entity dialog master expose toggle", () => {
    // Mirrors HA's render() assistant-list computation, including the splice
    // bug. Cloud enablement is configurable to cover mixed cloud setups.
    class FakeEntityVoiceSettings extends HTMLElement {
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
        const voiceAssistants: Record<string, { domain: string; name: string }> = {
          conversation: { domain: "assist_pipeline", name: "Assist" },
          "cloud.alexa": { domain: "cloud", name: "Amazon Alexa" },
          "cloud.google_assistant": { domain: "cloud", name: "Google Assistant" },
          hass_ga_manual_ui: { domain: "google_assistant", name: "GA Manual" },
        };
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

    it("keeps our assistant in uiAssistants (master toggle + row visibility)", () => {
      evalFrontend();
      const el = make();
      el.render();

      expect(el.uiAssistants).toContain("hass_ga_manual_ui");
      expect(el.uiAssistants).not.toContain("cloud.alexa");
      // With no cloud enabled, our row still renders last.
      expect(el.showAssistants).toEqual(["conversation", "hass_ga_manual_ui"]);
    });

    it("master toggle reflects exposure when only our assistant is exposed", () => {
      evalFrontend();
      const el = make();
      el.exposed = { hass_ga_manual_ui: true };
      el.render();

      expect(el.anyExposed).toBe(true);
    });

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

    it("awaits the expose write before delegating (master toggle)", async () => {
      evalFrontend();
      const el = make();
      el.entityId = "light.demo";
      const callWS = vi.fn((msg: { type: string }) => {
        if (msg.type === "homeassistant/expose_entity") el.order.push("expose");
        return Promise.resolve({});
      });
      el.hass = { callWS };

      await (
        el as unknown as { _toggleAll: (e: unknown) => Promise<void> }
      )._toggleAll({
        target: { checked: true, assistants: ["conversation", "hass_ga_manual_ui"] },
      });

      expect(el.order).toEqual(["expose", "orig-all"]);
      expect(callWS).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "homeassistant/expose_entity",
          assistants: ["conversation", "hass_ga_manual_ui"],
          entity_ids: ["light.demo"],
          should_expose: true,
        }),
      );
    });

    it("awaits the expose write before delegating (per-assistant toggle)", async () => {
      evalFrontend();
      const el = make();
      el.entityId = "light.demo";
      const callWS = vi.fn((msg: { type: string }) => {
        if (msg.type === "homeassistant/expose_entity") el.order.push("expose");
        return Promise.resolve({});
      });
      el.hass = { callWS };

      await (
        el as unknown as { _toggleAssistant: (e: unknown) => Promise<void> }
      )._toggleAssistant({
        target: { checked: false, assistant: "hass_ga_manual_ui" },
      });

      expect(el.order).toEqual(["expose", "orig-assistant"]);
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

  // The dialog feeds a static `exposed` snapshot; we recompute it from the entry.
  describe("expose-tab dialog refresh", () => {
    class FakeDialogVoiceSettings extends HTMLElement {
      _params: { exposed?: Record<string, unknown>; extEntityReg?: unknown } | undefined;
      _entityEntryUpdated(ev: { detail: unknown }) {
        if (this._params) this._params.extEntityReg = ev.detail;
      }
    }
    if (!customElements.get("dialog-voice-settings")) {
      customElements.define("dialog-voice-settings", FakeDialogVoiceSettings);
    }

    it("recomputes exposed from the updated entry", () => {
      evalFrontend();
      const el = document.createElement(
        "dialog-voice-settings",
      ) as unknown as FakeDialogVoiceSettings;
      el._params = {
        exposed: { conversation: true, hass_ga_manual_ui: true },
        extEntityReg: null,
      };
      const entry = {
        options: {
          conversation: { should_expose: false },
          hass_ga_manual_ui: { should_expose: false },
        },
      };

      (
        el as unknown as { _entityEntryUpdated: (e: unknown) => void }
      )._entityEntryUpdated({ detail: entry });

      expect(el._params!.exposed).toEqual({
        conversation: false,
        hass_ga_manual_ui: false,
      });
      expect(el._params!.extEntityReg).toBe(entry);
    });
  });
});
