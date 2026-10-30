import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { normalizeScenario, SimulationEngine } from "../../src/engine";
let reportFile: string;
test.beforeAll(() => {
  const directory = resolve(`test-results/analysis-input-${Date.now()}`);
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      resolve("scripts/analyze-compare.ts"),
      "examples/mcsr-routing.json",
      "--output",
      directory,
    ],
    { encoding: "utf8", timeout: 60000 },
  );
  expect(result.status, result.stderr).toBe(0);
  reportFile = resolve(directory, "comparison.json");
});
test("comparison import preserves the live run, exposes metric evidence and replays the selected logical instant", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.getByRole("button", { name: "일시정지", exact: true }).click();
  const initialDuration = await page
    .getByLabel("실험 길이", { exact: true })
    .inputValue();
  await page.locator(".analysis-panel > summary").click();
  await page.getByLabel("비교 보고서 가져오기", { exact: true }).setInputFiles({
    name: "comparison.json",
    mimeType: "application/json",
    buffer: readFileSync(reportFile),
  });
  await expect(
    page.getByRole("table", { name: "알고리즘 비교" }),
  ).toContainText("MCSR");
  await expect(
    page.getByRole("table", { name: "알고리즘 비교" }),
  ).toContainText("BFS");
  await expect(page.getByLabel("실험 길이", { exact: true })).toHaveValue(
    initialDuration,
  );
  await expect(page.locator(".analysis-chart svg")).toHaveCount(4);
  await expect(page.getByLabel("분석 보고서 조건")).toContainText("16기 · 8초");
  await page.getByLabel("분석 시각", { exact: true }).fill("2.5");
  await page
    .getByLabel("분석 재생 알고리즘", { exact: true })
    .selectOption("mcsr");
  await page
    .getByRole("button", { name: "이 시점 3D 재생", exact: true })
    .click();
  await expect(page.getByLabel("실험 길이", { exact: true })).toHaveValue("8");
  await expect(page.getByLabel("라우팅 알고리즘", { exact: true })).toHaveValue(
    "mcsr",
  );
  await expect(page.getByLabel("시뮬레이션 시간", { exact: true })).toHaveValue(
    "2.5",
  );
  await expect(page.locator(".run-status")).toHaveText("일시정지");
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "결과 저장", exact: true }).click();
  const exported = JSON.parse(
    await readFile((await (await pending).path())!, "utf8"),
  );
  const core = new SimulationEngine(normalizeScenario(exported.scenario));
  while (!core.advanceTo(2500000, 500)) core.drainDeltas();
  expect(exported.result).toEqual(core.result());
  await page.getByLabel("비교 보고서 가져오기", { exact: true }).setInputFiles({
    name: "invalid.json",
    mimeType: "application/json",
    buffer: Buffer.from('{"analysisVersion":99}'),
  });
  await expect(page.locator(".analysis-panel [role=alert]")).toContainText(
    "유효하지 않은",
  );
  await expect(
    page.getByRole("table", { name: "알고리즘 비교" }),
  ).toContainText("MCSR");
  await expect(page.getByLabel("시뮬레이션 시간", { exact: true })).toHaveValue(
    "2.5",
  );
  expect(errors).toEqual([]);
});
test("comparison graphs and tables remain inside the mobile configuration panel", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "성좌 설정", exact: true }).click();
  await page.locator(".analysis-panel > summary").click();
  await page.getByLabel("비교 보고서 가져오기", { exact: true }).setInputFiles({
    name: "comparison.json",
    mimeType: "application/json",
    buffer: readFileSync(reportFile),
  });
  await expect(
    page.getByRole("table", { name: "알고리즘 비교" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  const chart = await page.locator(".analysis-chart").first().boundingBox();
  expect(chart!.x).toBeGreaterThanOrEqual(0);
  expect(chart!.x + chart!.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "test-results/analysis-mobile.png" });
});
