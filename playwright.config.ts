import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/browser",
  timeout: process.env.CI ? 180000 : 120000,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    trace: "retain-on-failure",
    baseURL: "http://127.0.0.1:5173",
    viewport: { width: 1440, height: 1000 },
    channel: process.platform === "win32" ? "msedge" : undefined,
    launchOptions: {
      args: [
        "--enable-webgl",
        "--ignore-gpu-blocklist",
        ...(process.env.CI ? ["--enable-unsafe-swiftshader"] : []),
      ],
    },
  },
  webServer: {
    command: process.platform === "win32" ? "npm.cmd run dev" : "npm run dev",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: true,
    timeout: 120000,
  },
});
