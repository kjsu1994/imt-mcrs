import { createHash } from "node:crypto";
import { chromium, expect } from "@playwright/test";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { normalizeScenario, SimulationEngine } from "../src/engine.ts";
import assert from "node:assert/strict";
const [
  url = "http://127.0.0.1:5173/",
  directory = `artifacts/performance/browser-${Date.now()}`,
] = process.argv.slice(2);
mkdirSync(directory, { recursive: true });
const output = `${directory}/report.json`;
writeFileSync(output, "[]", { flag: "wx" });
const browser = await chromium.launch({
  channel: process.platform === "win32" ? "msedge" : undefined,
  args: ["--enable-webgl", "--ignore-gpu-blocklist"],
});
const reports: unknown[] = [];
try {
  for (const n of [72, 1584]) {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
      acceptDownloads: true,
    });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.setDefaultTimeout(120000);
    console.error(`${n}: opening ${url}`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
    const scenario = normalizeScenario(
      JSON.parse(readFileSync(`examples/mcsr-${n}.json`, "utf8")),
    );
    await page.getByLabel("시나리오 가져오기", { exact: true }).setInputFiles({
      name: "benchmark.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(scenario)),
    });
    await expect(page.getByLabel("실험 길이", { exact: true })).toHaveValue(
      String(scenario.durationUs / 1e6),
    );
    await expect(page.locator(".run-status")).toHaveText("일시정지", {
      timeout: 120000,
    });
    await page.getByLabel("재생 속도").selectOption("1");
    await page.getByRole("button", { name: "재생", exact: true }).click();
    // Anonymous callbacks avoid tsx naming helpers inside serialized browser functions.
    // External rAF measures the same frame interval in the frozen and current applications.
    console.error(`${n}: sampling frames`);
    const renderer = await page.evaluate(async () => {
      const samples: number[] = [],
        start = performance.now();
      let last = start;
      while (last - start < 8000) {
        const now = await new Promise<number>((resolve) =>
          requestAnimationFrame(resolve),
        );
        samples.push(now - last);
        last = now;
      }
      const sorted = [...samples].sort((a, b) => a - b);
      return {
        fps: (1000 * samples.length) / (last - start),
        frameP95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
        frames: samples.length,
      };
    });
    await page.getByRole("button", { name: "일시정지", exact: true }).click();
    const diagnostic = await page.evaluate(
      () => window.__mcsrPerformance ?? null,
    );
    const short = { ...scenario, durationUs: 31000000 };
    short.failures = short.failures.filter((f) => f.atUs <= short.durationUs);
    short.linkMetricUpdates = short.linkMetricUpdates.filter(
      (f) => f.atUs <= short.durationUs,
    );
    await page.getByLabel("시나리오 가져오기", { exact: true }).setInputFiles({
      name: "short.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(short)),
    });
    await expect(page.getByLabel("실험 길이", { exact: true })).toHaveValue(
      "31",
    );
    await expect(page.locator(".run-status")).toHaveText("일시정지", {
      timeout: 120000,
    });
    console.error(`${n}: fast-forwarding 31 seconds`);
    await expect(
      page.getByRole("button", { name: "끝까지 실행", exact: true }),
    ).toBeEnabled();
    // Measure dispatch-to-DOM completion; Playwright assertion polling can dominate a short run.
    const fastForwardWallMs = await page.evaluate(
      (buttonText) =>
        new Promise<number>((resolve, reject) => {
          const button = [...document.querySelectorAll("button")].find(
            (b) => b.textContent?.trim() === buttonText,
          );
          if (!button || button.disabled) {
            reject(new Error("Fast-forward button unavailable"));
            return;
          }
          const started = performance.now();
          const timer = setTimeout(() => {
            observer.disconnect();
            reject(new Error("Fast-forward timeout"));
          }, 180000);
          const observer = new MutationObserver(() => {
            if (
              document.querySelector(".run-status")?.textContent?.trim() ===
              "종료"
            ) {
              observer.disconnect();
              clearTimeout(timer);
              resolve(performance.now() - started);
            }
          });
          observer.observe(document.querySelector(".run-status")!, {
            childList: true,
            subtree: true,
            characterData: true,
          });
          button.click();
        }),
      "끝까지 실행",
    );
    const pending = page.waitForEvent("download");
    await page.getByRole("button", { name: "결과 저장", exact: true }).click();
    const exported = JSON.parse(
      readFileSync((await (await pending).path())!, "utf8"),
    );
    const worker = exported.performance ?? null;
    assert.deepEqual(errors, []);
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page.close();
    const core = new SimulationEngine(short, undefined, true, {
      render: false,
    });
    while (!core.advanceTo(short.durationUs, 500)) core.drainDeltas();
    assert.deepEqual(
      exported.result,
      JSON.parse(JSON.stringify(core.result())),
    );
    console.error(`${n}: Worker/headless results match`);
    reports.push({
      n,
      url,
      viewport: { width: 1440, height: 1000 },
      browser: browser.version(),
      renderer,
      fastForwardWallMs,
      worker,
      diagnostic,
      errors,
      logicalMatch: true,
      logicalHash: createHash("sha256")
        .update(JSON.stringify(exported.result))
        .digest("hex"),
    });
    writeFileSync(output, JSON.stringify(reports, null, 2) + "\n");
  }
} finally {
  await browser.close();
}
console.log(JSON.stringify(reports, null, 2));
