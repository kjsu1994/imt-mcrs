import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import {
  SimulationEngine,
  createScenario,
  DEFAULT_EPOCH_MS,
} from "../../src/engine.ts";
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
    await expect(page.locator(".run-status")).not.toHaveText("계산 중", {
      timeout: 30000,
    });
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
    await expect(
      page.locator(".failure-panel details:not(.link-history) > summary"),
    ).toContainText("1건");
    await page.getByLabel("장애 예약 시각").fill("2");
    await page.getByRole("button", { name: "복구 예약", exact: true }).click();
    await expect(
      page.locator(".failure-panel details:not(.link-history) > summary"),
    ).toContainText("2건");
    await page.getByLabel("선택 링크", { exact: true }).selectOption("1:2");
    await page.getByLabel("장애 예약 시각").fill("1.05");
    await page.getByRole("button", { name: "장애 예약", exact: true }).click();
    await expect(
      page.locator(".failure-panel details:not(.link-history) > summary"),
    ).toContainText("3건");
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
    expect(exported.scenario.schemaVersion).toBe(5);
    await expect(
      page.getByLabel("현재 경로 속성", { exact: true }),
    ).toContainText("100.0 %");
    await expect(
      page.getByLabel("현재 경로 속성", { exact: true }),
    ).toContainText("0.00 ms");
    expect(exported.result.routingAlgorithm).toBe("BFS");
    expect(
      exported.result.currentPathMetrics.candidate.propagationDelayMs,
    ).toBeGreaterThan(0);
    expect(exported.result.routingEvaluations.length).toBeGreaterThan(0);
    expect(exported.scenario.epochMs).toBe(Date.UTC(2026, 0, 1));
    expect(exported.result.outageCount).toBe(1);
    expect(exported.result.linkFailures).toHaveLength(2);
    expect(exported.result.totalDowntimeUs).toBe(202000);
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
    await expect
      .poll(async () =>
        Number(
          await page
            .getByLabel("시뮬레이션 시간", { exact: true })
            .inputValue(),
        ),
      )
      .toBeGreaterThan(0);
    await page.getByRole("button", { name: "일시정지", exact: true }).click();
    expect(errors).toEqual([]);
    await page.close();
  }
});

test("UTC is fixed and editable while unused seed is explicitly reserved", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".run-status")).toHaveText("재생 중");
  await page.getByRole("button", { name: "일시정지", exact: true }).click();
  await expect(page.getByLabel("시작 UTC", { exact: true })).toHaveValue(
    "2026-01-01T00:00",
  );
  await expect(page.getByLabel("시드", { exact: true })).toBeDisabled();
  await page
    .getByLabel("시작 UTC", { exact: true })
    .fill("2026-02-02T03:04:05");
  await page.getByRole("button", { name: "실험 적용", exact: true }).click();
  await expect(page.locator("time")).toContainText("2026-02-02 03:04:05");
  await page.getByLabel("시작 UTC", { exact: true }).fill("");
  await page.getByRole("button", { name: "실험 적용", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("시작 시각");
  await expect(page.locator("time")).toContainText("2026-02-02 03:04:05");
});

test("manual link metrics survive Worker seeks and result export", async ({
  page,
}) => {
  const scenario = {
    ...createScenario(
      { planes: 1, perPlane: 8, altitude: 2000, inclination: 0, phase: 0 },
      DEFAULT_EPOCH_MS,
      0,
      3,
    ),
    durationUs: 3000000,
    linkMetricUpdates: [
      {
        atUs: 0,
        linkId: "0:1",
        bufferCapacityPackets: 1000,
        queuedPackets: 800,
        jitterMs: 2,
      },
      {
        atUs: 500000,
        linkId: "0:1",
        bufferCapacityPackets: 1000,
        queuedPackets: 950,
        jitterMs: 5,
      },
    ],
    failures: [{ atUs: 1000000, linkId: "0:1", down: true }],
  };
  await page.goto("/");
  const result = await page.evaluate(async (scenario) => {
    const worker = new Worker("/src/simulation.worker.ts", { type: "module" });
    function request(
      message: object,
      accepts: (reply: any) => boolean,
    ): Promise<any> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          worker.terminate();
          reject(new Error("Worker timeout"));
        }, 15000);
        worker.onmessage = ({ data }) => {
          if (data.type === "error") {
            clearTimeout(timer);
            reject(new Error(data.message));
          } else if (accepts(data)) {
            clearTimeout(timer);
            resolve(data);
          }
        };
        worker.postMessage(message);
      });
    }
    try {
      const initial = await request(
        { type: "load", runId: 1, scenario, playing: false, speed: 1 },
        (r) => r.type === "state" && r.reset,
      );
      const changed = await request(
        { type: "seek", runId: 1, nextRunId: 2, atUs: 500000 },
        (r) => r.type === "state" && r.runId === 2 && !r.busy,
      );
      const reset = await request(
        { type: "seek", runId: 2, nextRunId: 3, atUs: 0 },
        (r) => r.type === "state" && r.runId === 3 && !r.busy,
      );
      await request(
        { type: "finish", runId: 3 },
        (r) =>
          r.type === "state" &&
          !r.busy &&
          r.progress.timeUs === scenario.durationUs,
      );
      const exported = await request(
        { type: "export", runId: 3, what: "result" },
        (r) => r.type === "export",
      );
      return {
        initial: initial.progress.currentPathMetrics,
        changed: changed.progress.currentPathMetrics,
        reset: reset.progress.currentPathMetrics,
        exported: exported.data,
      };
    } finally {
      worker.terminate();
    }
  }, scenario);
  expect(result.initial.candidate.availableBufferRatio).toBe(0.2);
  expect(result.changed.candidate.availableBufferRatio).toBe(0.05);
  expect(result.changed.candidate.jitterMs).toBe(5);
  expect(result.reset).toEqual(result.initial);
  expect(result.exported.scenario).toEqual(scenario);
  const core = new SimulationEngine(scenario);
  core.advanceTo(scenario.durationUs);
  expect(result.exported.result).toEqual(core.result());
});
