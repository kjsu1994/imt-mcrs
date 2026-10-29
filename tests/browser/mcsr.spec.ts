import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { SimulationEngine } from "../../src/engine.ts";

test("MCSR regions, decisions, delayed CSIB, event seek and exported core replay agree", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  async function loadFixed() {
    await page
      .getByLabel("시나리오 가져오기", { exact: true })
      .setInputFiles({
        name: "mcsr-fixed-routing.json",
        mimeType: "application/json",
        buffer: await readFile("examples/mcsr-fixed-routing.json"),
      });
  }
  await page.goto("/");
  await expect(page.locator('option[value="mcsr"]')).toHaveJSProperty(
    "disabled",
    false,
  );
  await loadFixed();
  await expect(page.getByLabel("라우팅 알고리즘", { exact: true })).toHaveValue(
    "mcsr",
  );
  await expect(
    page.getByLabel("MCSR 영역 상태", { exact: true }),
  ).toContainText("SRD 4개");
  await expect(page.locator(".mcsr-summary")).toContainText("기준 탐색 일치");
  await expect(page.locator(".candidate-row")).toHaveCount(2);
  await expect(page.locator(".run-status")).toHaveText("일시정지");
  await page.locator(".candidate-row").nth(1).click();
  await expect(page.locator(".candidate-row.active")).toContainText("S1");
  await page.getByLabel("SRD·DS 표시", { exact: true }).uncheck();
  await page.getByLabel("SRD·DS 표시", { exact: true }).check();
  await page.getByLabel("시뮬레이션 시간", { exact: true }).fill("0.6");
  await expect(page.locator(".route-path")).toHaveText(
    "0000 → 0007 → 0006 → 0014 → 0013 → 0012",
  );
  await page.getByLabel("시뮬레이션 시간", { exact: true }).fill("2.5");
  await expect(page.locator(".route-path")).toHaveText(
    "연결 가능한 경로가 없습니다.",
  );
  await page
    .locator(".mcsr-summary summary")
    .filter({ hasText: "영역 갱신 이력" })
    .click();
  await page.locator(".mcsr-summary .event-jump").last().click();
  await expect(page.locator(".run-status")).toHaveText("일시정지");
  await page.getByRole("button", { name: "끝까지 실행", exact: true }).click();
  await expect(page.locator(".run-status")).toHaveText("종료");
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "결과 저장", exact: true }).click();
  const data = JSON.parse(
    await readFile((await (await pending).path())!, "utf8"),
  );
  const core = new SimulationEngine(data.scenario);
  core.advanceTo(data.scenario.durationUs);
  expect(data.result).toEqual(core.result());
  expect(data.result.validForAnalysis).toBe(true);
  expect(
    data.result.mcsr.events.some((e: any) => e.type === "csib-received"),
  ).toBe(true);
  await page.getByLabel("시뮬레이션 시간", { exact: true }).fill("0");
  await expect(page.locator(".mcsr-summary")).toContainText("기준 탐색 일치");
  await page.getByLabel("출발 노드", { exact: true }).selectOption("1");
  await expect(page.getByLabel("라우팅 알고리즘", { exact: true })).toHaveValue(
    "mcsr",
  );
  await page.getByLabel("SRD 슬롯 수", { exact: true }).selectOption("8");
  await expect(page.locator(".mcsr-summary")).toContainText("SRD 2개");
  await loadFixed();
  await expect(page.locator(".mcsr-summary")).toContainText("SRD 4개");
  await page.locator(".mcsr-summary").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/mcsr-regions.png" });
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.addInitScript(() => {
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) =>
      raf(() => setTimeout(() => callback(performance.now()), 200));
  });
  await page.reload();
  await loadFixed();
  await expect(page.locator(".run-status")).toHaveText("일시정지");
  await page.getByRole("button", { name: "끝까지 실행", exact: true }).click();
  await expect(page.locator(".run-status")).toHaveText("종료");
  const slowDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "결과 저장", exact: true }).click();
  const slow = JSON.parse(
    await readFile((await (await slowDownload).path())!, "utf8"),
  );
  expect(slow.result).toEqual(data.result);
  expect(errors).toEqual([]);
});
