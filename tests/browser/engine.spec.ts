import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { SimulationEngine } from "../../src/engine.ts";
test("Worker results match headless replay with normal and throttled rendering", async ({
  browser,
}) => {
  let baseline: unknown;
  for (const slow of [false, true]) {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
      acceptDownloads: true,
    });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    if (slow)
      await page.addInitScript(() => {
        const raf = window.requestAnimationFrame.bind(window);
        window.requestAnimationFrame = (callback) =>
          raf(() => setTimeout(() => callback(performance.now()), 200));
      });
    await page.goto("/");
    await expect(page.locator(".run-status")).not.toHaveText("계산 중");
    await expect(page.locator(".brand img")).toHaveAttribute(
      "src",
      /logo\.png$/,
    );
    await expect(page.locator(".org-logo")).toHaveAttribute(
      "src",
      /imt_logo\.png$/,
    );
    await expect(page.locator("link[rel=icon]")).toHaveAttribute(
      "href",
      /logo\.png$/,
    );
    await page.getByRole("button", { name: "일시정지", exact: true }).click();
    for (const [label, value] of [
      ["궤도 수", "1"],
      ["궤도당 위성", "8"],
      ["궤도 고도", "2000"],
      ["경사각", "0"],
      ["위상 인자", "0"],
    ])
      await page.getByLabel(label, { exact: true }).fill(value);
    await page.getByRole("button", { name: "성좌 적용", exact: true }).click();
    await page.getByLabel("도착 노드", { exact: true }).selectOption("3");
    await page.getByLabel("실험 길이", { exact: true }).fill("3");
    await page.getByRole("button", { name: "실험 적용", exact: true }).click();
    await page.getByLabel("선택 링크", { exact: true }).selectOption("0:1");
    await page.getByLabel("장애 예약 시각").fill("1");
    await page.getByRole("button", { name: "장애 예약", exact: true }).click();
    await expect(page.locator(".failure-panel summary")).toContainText("1건");
    await page.getByLabel("장애 예약 시각").fill("2");
    await page.getByRole("button", { name: "복구 예약", exact: true }).click();
    await expect(page.locator(".failure-panel summary")).toContainText("2건");
    await page
      .getByRole("button", { name: "끝까지 실행", exact: true })
      .click();
    await expect(page.locator(".run-status")).toHaveText("종료");
    await expect(page.locator(".recovery-list")).toContainText("202.000 ms");
    const pending = page.waitForEvent("download");
    await page.getByRole("button", { name: "결과 저장", exact: true }).click();
    const download = await pending;
    const exported = JSON.parse(
      await readFile((await download.path())!, "utf8"),
    );
    const core = new SimulationEngine(exported.scenario);
    core.advanceTo(exported.scenario.durationUs);
    expect(exported.result).toEqual(core.result());
    if (baseline) expect(exported.result).toEqual(baseline);
    else baseline = exported.result;
    await page.getByLabel("시뮬레이션 시간", { exact: true }).fill("0");
    await expect(page.locator(".recovery-list")).toContainText("기록 없음");
    await page
      .getByRole("button", { name: "끝까지 실행", exact: true })
      .click();
    await expect(page.locator(".run-status")).toHaveText("종료");
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page.getByLabel("재생 속도").selectOption("1");
    await page.getByRole("button", { name: "재생", exact: true }).click();
    await expect(page.locator(".run-status")).toHaveText("재생 중");
    await expect.poll(async () => Number(await page.getByLabel("시뮬레이션 시간", { exact: true }).inputValue())).toBeGreaterThan(0);
    await page.getByRole("button", { name: "일시정지", exact: true }).click();
    expect(errors).toEqual([]);
    await page.close();
  }
});
