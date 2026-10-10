import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  outputDir: ".e2e/results",
  use: {
    baseURL: "http://127.0.0.1:18096",
    browserName: "chromium",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "docker build -q -t hass-ga-manual-ui-e2e tests/e2e && docker run --rm --init --network host --user $(id -u):$(id -g) -v \"$PWD:/workspace\" hass-ga-manual-ui-e2e",
    url: "http://127.0.0.1:18096/e2e-ready",
    timeout: 300_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
  },
});
