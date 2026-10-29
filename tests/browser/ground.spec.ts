import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import {
  createScenario,
  SimulationEngine,
  DEFAULT_EPOCH_MS,
  SECOND,
} from "../../src/engine.ts";
import { PRESETS, positions } from "../../src/model.ts";
import { defaultGround } from "../../src/ground.ts";
import type { Vec3 } from "../../src/model.ts";
const under = (v: Vec3) => ({
  latitude: (Math.atan2(v.z, Math.hypot(v.x, v.y)) * 180) / Math.PI,
  longitude: (Math.atan2(v.y, v.x) * 180) / Math.PI,
});

test("right-click places separate UT and GS, drag still zooms, and coordinates save and delete", async ({
  page,
}) => {
  const errors: string[] = [],
    external: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/*", async (route) => {
    if (
      route.request().url().startsWith("http") &&
      !route.request().url().startsWith("http://127.0.0.1:5173")
    ) {
      external.push(route.request().url());
      await route.abort();
    } else await route.continue();
  });
  await page.goto("/");
  await page.getByRole("button", { name: "일시정지", exact: true }).click();
  const canvas = page.locator("canvas");
  await expect(canvas).toBeVisible();
  await page.waitForTimeout(1000);
  const box = (await canvas.boundingBox())!;
  const center = { x: box.width / 2, y: box.height / 2 };
  await canvas.click({ button: "right", position: { x: 8, y: 8 } });
  await expect(page.getByRole("menu", { name: "지상 노드 지정" })).toHaveCount(
    0,
  );
  await canvas.click({ button: "right", position: center });
  await expect(
    page.getByRole("menu", { name: "지상 노드 지정" }),
  ).toBeVisible();
  const menu = (await page.getByRole("menu").boundingBox())!;
  expect(menu.x).toBeGreaterThanOrEqual(box.x);
  expect(menu.x + menu.width).toBeLessThanOrEqual(box.x + box.width);
  await page
    .getByRole("menuitem", { name: "여기에 사용자 단말(UT) 지정" })
    .click();
  await expect(page.getByLabel("통신 끝점", { exact: true })).toHaveValue(
    "ground",
  );
  await expect(page.getByLabel("UT 위도", { exact: true })).not.toHaveValue("");
  await expect(page.getByLabel("GS 위도", { exact: true })).toHaveValue("");
  await expect(
    page.getByLabel("지상 서비스 상태", { exact: true }),
  ).toContainText("대기");
  await canvas.click({
    button: "right",
    position: { x: center.x + 20, y: center.y + 10 },
  });
  await page.getByRole("menuitem", { name: "여기에 지상국(GS) 지정" }).click();
  await expect(page.getByLabel("GS 위도", { exact: true })).not.toHaveValue("");
  await page.getByLabel("UT 위도", { exact: true }).fill("19.4326");
  await page.getByLabel("UT 경도", { exact: true }).fill("-99.1332");
  await page.getByLabel("GS 위도", { exact: true }).fill("34.0522");
  await page.getByLabel("GS 경도", { exact: true }).fill("-118.2437");
  await page
    .getByRole("button", { name: "지상 설정 적용", exact: true })
    .click();
  await expect(
    page.getByLabel("지상 서비스 상태", { exact: true }),
  ).toContainText("연결");
  await expect(page.getByLabel("출발 노드", { exact: true })).toHaveCount(0);
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "시나리오 저장", exact: true })
    .click();
  const saved = JSON.parse(
    await readFile((await (await download).path())!, "utf8"),
  );
  expect(saved.schemaVersion).toBe(9);
  expect(saved.routing.algorithm).toBe("bfs");
  expect(saved.ground.ut).toEqual({ latitude: 19.4326, longitude: -99.1332 });
  expect(saved.ground.gs).toEqual({ latitude: 34.0522, longitude: -118.2437 });
  await page.mouse.move(box.x + center.x, box.y + center.y);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(box.x + center.x, box.y + center.y + 60, { steps: 8 });
  await page.mouse.up({ button: "right" });
  await expect(page.getByRole("menu")).toHaveCount(0);
  await page.getByRole("button", { name: "UT 삭제", exact: true }).click();
  await expect(page.getByLabel("UT 위도", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("GS 위도", { exact: true })).toHaveValue(
    "34.0522",
  );
  await expect(
    page.getByLabel("지상 서비스 상태", { exact: true }),
  ).toContainText("대기");
  await page.getByLabel("통신 끝점", { exact: true }).selectOption("satellite");
  await expect(page.getByLabel("출발 노드", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
});

test("BFS and MCSR ground handovers, exports and seeking match headless replay", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  for (const algorithm of ["bfs", "mcsr"] as const) {
    const s = createScenario(PRESETS[0].config, DEFAULT_EPOCH_MS);
    s.durationUs = 251 * SECOND;
    s.routing.algorithm = algorithm;
    const p = positions(s.config, 0, s.epochMs);
    s.ground = { ...defaultGround(), ut: under(p[0]), gs: under(p[61]) };
    await page.getByLabel("시나리오 가져오기", { exact: true }).setInputFiles({
      name: "ground.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(s)),
    });
    await expect(
      page.getByLabel("UT 접속 상태", { exact: true }),
    ).toContainText("위성 0 ·", { timeout: 30000 });
    await expect(
      page.getByLabel("GS 접속 상태", { exact: true }),
    ).toContainText("위성 61 ·");
    await page
      .getByRole("button", { name: "끝까지 실행", exact: true })
      .click();
    await expect(page.locator(".run-status")).toHaveText("종료", {
      timeout: 60000,
    });
    await expect(
      page.getByLabel("지상 서비스 상태", { exact: true }),
    ).toContainText("연결");
    await expect(
      page.getByLabel("UT 접속 상태", { exact: true }),
    ).toContainText("위성 41 ·");
    const pending = page.waitForEvent("download");
    await page.getByRole("button", { name: "결과 저장", exact: true }).click();
    const exported = JSON.parse(
      await readFile((await (await pending).path())!, "utf8"),
    );
    const core = new SimulationEngine(s);
    core.advanceTo(s.durationUs);
    expect(exported.result).toEqual(core.result());
    expect(exported.result.groundService.handoverDowntimeUs).toBe(102000);
    expect(exported.result.outageCount).toBe(0);
    await page.getByLabel("시뮬레이션 시간", { exact: true }).fill("249");
    await expect(
      page.getByLabel("지상 서비스 상태", { exact: true }),
    ).toContainText("수립 중", { timeout: 30000 });
    await page.getByLabel("시뮬레이션 시간", { exact: true }).fill("248");
    await expect(
      page.getByLabel("UT 접속 상태", { exact: true }),
    ).toContainText("위성 0 ·", { timeout: 30000 });
    if (algorithm === "mcsr")
      await page.screenshot({ path: "test-results/ground-mcsr-72.png" });
  }
  expect(errors).toEqual([]);
});

test("1584-satellite ground endpoints work with both BFS and MCSR", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  for (const algorithm of ["bfs", "mcsr"] as const) {
    const s = createScenario(PRESETS[1].config, DEFAULT_EPOCH_MS);
    s.durationUs = 2 * SECOND;
    s.routing.algorithm = algorithm;
    const p = positions(s.config, 0, s.epochMs);
    s.ground = { ...defaultGround(), ut: under(p[0]), gs: under(p[1573]) };
    await page.getByLabel("시나리오 가져오기", { exact: true }).setInputFiles({
      name: "ground-large.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(s)),
    });
    await expect(
      page.getByLabel("지상 서비스 상태", { exact: true }),
    ).toContainText("연결", { timeout: 60000 });
    await expect(
      page.getByLabel("UT 접속 상태", { exact: true }),
    ).toContainText("위성 0 ·");
    await expect(
      page.getByLabel("GS 접속 상태", { exact: true }),
    ).toContainText("위성 1573 ·");
    await page
      .getByRole("button", { name: "끝까지 실행", exact: true })
      .click();
    await expect(page.locator(".run-status")).toHaveText("종료", {
      timeout: 60000,
    });
    const pending = page.waitForEvent("download");
    await page.getByRole("button", { name: "결과 저장", exact: true }).click();
    const exported = JSON.parse(
      await readFile((await (await pending).path())!, "utf8"),
    );
    const core = new SimulationEngine(s);
    core.advanceTo(s.durationUs);
    expect(exported.result).toEqual(core.result());
    expect(exported.result.groundService.availability).toBe(1);
  }
  expect(errors).toEqual([]);
});

test("ground configuration and right-click menus fit small viewports", async ({
  page,
}) => {
  for (const [width, height] of [
    [390, 844],
    [667, 375],
    [320, 568],
  ]) {
    await page.setViewportSize({ width, height });
    await page.goto("/");
    await page.getByRole("button", { name: "일시정지", exact: true }).click();
    await page.getByRole("button", { name: "성좌 설정", exact: true }).click();
    await expect(page.locator(".config-panel")).toBeVisible();
    const canvas = page.locator("canvas"),
      box = (await canvas.boundingBox())!;
    await page.waitForTimeout(600);
    await canvas.click({
      button: "right",
      position: { x: box.width / 2, y: box.height / 2 },
    });
    const menu = page.getByRole("menu", { name: "지상 노드 지정" });
    await expect(menu).toBeVisible();
    const bounds = (await menu.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(box.x);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(box.x + box.width + 1);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(
      box.y + box.height + 1,
    );
    await page
      .getByRole("menuitem", { name: "여기에 사용자 단말(UT) 지정" })
      .click();
    await expect(page.locator(".config-panel")).toHaveCount(0);
    await expect(page.locator(".info-panel")).toBeVisible();
    await expect(page.getByLabel("UT 위도", { exact: true })).not.toHaveValue(
      "",
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({ path: `test-results/ground-mobile-${width}.png` });
  }
});
