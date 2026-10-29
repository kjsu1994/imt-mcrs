import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { SimulationEngine } from "../../src/engine.ts";

test("automatic frontier, service choice, cached recovery and result replay agree", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.locator('option[value="dominant-paths"]')).toHaveJSProperty(
    "disabled",
    true,
  );
  await page.getByLabel("시나리오 가져오기", { exact: true }).setInputFiles({
    name: "dominant-routing.json",
    mimeType: "application/json",
    buffer: await readFile("examples/dominant-routing.json"),
  });
  await expect(page.getByLabel("라우팅 알고리즘", { exact: true })).toHaveValue(
    "dominant-paths",
  );
  await expect(page.locator(".search-summary")).toContainText("우세 2개");
  await expect(page.locator(".candidate-row")).toHaveCount(2);
  await expect(page.locator(".run-status")).toHaveText("일시정지");
  await page.getByLabel("시뮬레이션 시간", { exact: true }).fill("0.6");
  await expect(page.locator(".route-path")).toHaveText(
    "0000 → 0007 → 0006 → 0005 → 0004 → 0003",
  );
  await page.locator(".candidate-row").nth(1).click();
  await expect(page.locator(".candidate-row.active")).toHaveCount(1);
  await page.getByLabel("서비스 유형", { exact: true }).selectOption("LS");
  await page.getByLabel("시뮬레이션 시간", { exact: true }).fill("0.6");
  await expect(page.locator(".route-path")).toHaveText(
    "0000 → 0001 → 0002 → 0003",
  );
  await page.getByLabel("서비스 유형", { exact: true }).selectOption("HR");
  await page.getByLabel("시뮬레이션 시간", { exact: true }).fill("0.6");
  await expect(page.locator(".route-path")).toHaveText(
    "0000 → 0007 → 0006 → 0005 → 0004 → 0003",
  );
  await page.getByLabel("서비스 유형", { exact: true }).selectOption("TS");
  await page.getByLabel("시뮬레이션 시간", { exact: true }).fill("1.5");
  await expect(page.locator(".routing-analysis")).toContainText(
    "저장 후보 재사용",
  );
  await expect(page.locator(".route-path")).toHaveText(
    "0000 → 0001 → 0002 → 0003",
  );
  await expect(page.locator(".search-summary")).toHaveCount(0);
  await page.getByLabel("시뮬레이션 시간", { exact: true }).fill("0");
  await expect(page.locator(".search-summary")).toContainText("완성 2개");
  await page.getByRole("button", { name: "끝까지 실행", exact: true }).click();
  await expect(page.locator(".run-status")).toHaveText("종료");
  await expect(page.locator(".search-summary")).toContainText("우세 0개");
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "결과 저장", exact: true }).click();
  const data = JSON.parse(
    await readFile((await (await pending).path())!, "utf8"),
  );
  expect(data.scenario.schemaVersion).toBe(8);
  expect(data.scenario.routing.algorithm).toBe("dominant-paths");
  expect(data.result.validForAnalysis).toBe(true);
  expect(data.result.routingEvaluations).toHaveLength(3);
  expect(
    data.result.routingAnalyses.some((a: any) => a.mode === "reserve"),
  ).toBe(true);
  const core = new SimulationEngine(data.scenario);
  core.advanceTo(data.scenario.durationUs);
  expect(data.result).toEqual(core.result());
  await page.getByLabel("시뮬레이션 시간", { exact: true }).fill("0");
  await expect(page.locator(".search-summary")).toContainText("우세 2개");
  await page.getByLabel("라우팅 알고리즘", { exact: true }).selectOption("bfs");
  await expect(page.locator(".search-summary")).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  const pruned = JSON.parse(
    await readFile("examples/dominant-routing.json", "utf8"),
  );
  pruned.linkMetricUpdates[1].jitterMs = 3;
  await page
    .getByLabel("시나리오 가져오기", { exact: true })
    .setInputFiles({
      name: "pruned.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(pruned)),
    });
  await expect(page.locator(".search-summary")).toContainText("우세 1개");
  await expect(page.locator(".search-summary")).toContainText("제거 1개");
  await page.locator(".search-summary summary").click();
  await expect(page.locator(".search-summary")).toContainText(
    "우세 경로 0 → 1 → 2 → 3",
  );
  await page.locator(".routing-analysis").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/dominant-frontier.png" });
  expect(errors).toEqual([]);
});

test("invalid automatic scale preserves the current run; fatal Worker errors show failure", async ({
  page,
}) => {
  await page.goto("/");
  const input = JSON.parse(
    await readFile("examples/dominant-routing.json", "utf8"),
  );
  await page.getByLabel("시나리오 가져오기", { exact: true }).setInputFiles({
    name: "oversized.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        ...input,
        config: { ...input.config, planes: 3, perPlane: 8 },
      }),
    ),
  });
  await expect(page.getByRole("alert")).toContainText("16기");
  await expect(page.getByLabel("라우팅 알고리즘", { exact: true })).toHaveValue(
    "bfs",
  );
  await page.addInitScript(() => {
    const Native = window.Worker;
    window.Worker = class extends Native {
      postMessage(
        message: any,
        options?: Transferable[] | StructuredSerializeOptions,
      ) {
        if (message?.type === "load") {
          setTimeout(
            () =>
              this.dispatchEvent(
                new MessageEvent("message", {
                  data: {
                    type: "error",
                    runId: message.runId,
                    message: "탐색 한도 초과",
                    fatal: true,
                  },
                }),
              ),
            100,
          );
          return;
        }
        if (Array.isArray(options)) super.postMessage(message, options);
        else super.postMessage(message, options);
      }
    };
  });
  await page.reload();
  await expect(page.getByRole("alert")).toContainText("탐색 한도");
  await expect(page.locator(".run-status")).toHaveText("계산 실패");
  await expect(page.locator(".play")).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "끝까지 실행", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "결과 저장", exact: true }),
  ).toBeDisabled();
});
