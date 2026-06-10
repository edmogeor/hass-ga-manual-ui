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
  "../custom_components/google_assistant_manual/frontend.js",
);
const FRONTEND_JS_CODE = readFileSync(FRONTEND_JS_PATH, "utf8");

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
      if (msg.type === "google_assistant_manual/get_entry_id") {
        return Promise.resolve({ entry_id: "mock-entry" });
      }
      if (msg.type === "google_assistant_manual/get_config") {
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
  });

  afterEach(() => {
    document.body.innerHTML = "";
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

    it("card header has a brand icon element", () => {
      const hass = createMockHass();
      setupDom(hass);
      evalFrontend();

      const card = document.querySelector("[data-ga-manual-card]");
      const icon = card!.querySelector("voice-assistant-brand-icon");
      expect(icon).not.toBeNull();
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
            "google_assistant_manual/get_entry_id"
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
            "google_assistant_manual/get_config"
      );
      expect(configCalls.length).toBe(1);
    });

    it("handles failed get_entry_id gracefully", () => {
      const hass = createMockHass();
      hass.callWS.mockRejectedValue(
        new Error("No config entry found for google_assistant_manual")
      );

      setupDom(hass);
      expect(() => evalFrontend()).not.toThrow();
    });

    it("handles failed get_config gracefully", async () => {
      const hass = createMockHass();
      hass.callWS.mockImplementation((msg: Record<string, unknown>) => {
        if (msg.type === "google_assistant_manual/get_entry_id") {
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
        if (msg.type === "google_assistant_manual/get_entry_id") {
          return Promise.resolve({ entry_id: "mock-entry" });
        }
        if (msg.type === "google_assistant_manual/get_config") {
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
});
