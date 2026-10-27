import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { SimulationEngine } from "../../src/engine.ts";

test("imported candidate routing survives selection, seeks, export and failed imports", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.getByLabel("시나리오 가져오기", { exact: true }).setInputFiles({
    name: "candidate-routing.json",
    mimeType: "application/json",
    buffer: await readFile("examples/candidate-routing.json"),
  });
  await expect(page.getByLabel("라우팅 알고리즘", { exact: true })).toHaveValue(
    "candidate-paths",
  );
  await expect(page.getByLabel("서비스 유형", { exact: true })).toHaveValue(
    "TS",
  );
  await expect(page.locator(".run-status")).toHaveText("일시정지");
  await expect(page.getByLabel("성좌 프리셋", { exact: true })).toHaveValue(
    "-1",
  );
  await expect(page.locator(".candidate-row")).toHaveCount(2);
  await page.locator(".candidate-row").nth(1).click();
  await expect(page.locator(".candidate-row.active")).toContainText(
    "0 → 7 → 6 → 5 → 4 → 3",
  );
  await page.getByLabel("시뮬레이션 시간", { exact: true }).fill("0.6");
  await expect(page.locator(".route-path")).toHaveText(
    "0000 → 0007 → 0006 → 0005 → 0004 → 0003",
  );
  await expect(page.locator(".routing-analysis")).toContainText("TS 선택 기준");
  await page.getByLabel("시뮬레이션 시간", { exact: true }).fill("0");
  await expect(page.locator(".route-path")).toHaveText(
    "0000 → 0001 → 0002 → 0003",
  );
  await page.getByLabel("서비스 유형", { exact: true }).selectOption("LS");
  await page.getByLabel("시뮬레이션 시간", { exact: true }).fill("0.6");
  await expect(page.locator(".route-path")).toHaveText(
    "0000 → 0001 → 0002 → 0003",
  );
  await page.getByLabel("서비스 유형", { exact: true }).selectOption("TS");
  await page.getByRole("button", { name: "끝까지 실행", exact: true }).click();
  await expect(page.locator(".run-status")).toHaveText("종료");
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "결과 저장", exact: true }).click();
  const data = JSON.parse(
    await readFile((await (await pending).path())!, "utf8"),
  );
  expect(data.scenario.routing.algorithm).toBe("candidate-paths");
  expect(data.scenario.routing.service).toBe("TS");
  expect(
    data.result.routingAnalyses.some((a: any) => a.mode === "reserve"),
  ).toBe(true);
  const core = new SimulationEngine(data.scenario);
  core.advanceTo(data.scenario.durationUs);
  expect(data.result).toEqual(core.result());
  await page.getByLabel("시나리오 가져오기", { exact: true }).setInputFiles({
    name: "invalid.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        ...data.scenario,
        routing: { algorithm: "mcsr", service: "TS", candidatePaths: [] },
      }),
    ),
  });
  await expect(page.getByRole("alert")).toContainText("라우팅 설정");
  await expect(page.getByLabel("라우팅 알고리즘", { exact: true })).toHaveValue(
    "candidate-paths",
  );
  await expect(page.locator(".run-status")).toHaveText("종료");
  expect(errors).toEqual([]);
});

test("nearby satellites use the local image and candidate inspection adds a separate line", async ({
  page,
  context,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.getByLabel("시나리오 가져오기", { exact: true }).setInputFiles({
    name: "candidate-routing.json",
    mimeType: "application/json",
    buffer: await readFile("examples/candidate-routing.json"),
  });
  await expect(page.locator(".candidate-row")).toHaveCount(2);
  const url = await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .map((e) => e.name)
      .find((u) => /\/deps\/cesium\.js/.test(u)),
  );
  expect(url).toBeTruthy();
  const cdp = await context.newCDPSession(page);
  const { result } = await cdp.send("Runtime.evaluate", {
    expression: `import(${JSON.stringify(url)}).then(m=>m.Viewer.prototype)`,
    awaitPromise: true,
  });
  const { objects } = await cdp.send("Runtime.queryObjects", {
    prototypeObjectId: result.objectId!,
  });
  async function inspect() {
    const result = await cdp.send("Runtime.callFunctionOn", {
      objectId: objects.objectId!,
      returnByValue: true,
      functionDeclaration: `function(){const v=this.find(v=>!v.isDestroyed()),p=v.scene.primitives,icons=Array.from({length:p.length},(_,i)=>p.get(i)).find(x=>x.length===8&&typeof x.get(0)?.image==='string');const c=v.camera.positionWC,b=icons?.get(0),pos=b?.position;return {icons:icons?.length,show:icons?.show,image:b?.image,near:b?.distanceDisplayCondition.near,far:b?.distanceDisplayCondition.far,distance:pos?Math.hypot(c.x-pos.x,c.y-pos.y,c.z-pos.z):null,preview:Array.from({length:p.length},(_,i)=>p.get(i)).some(x=>x.length===1&&x.get(0)?.width===5&&x.get(0)?.positions?.length===6)};}`,
    });
    return result.result.value;
  }
  await expect.poll(async () => (await inspect()).icons).toBe(8);
  expect((await inspect()).show).toBe(false);
  await page.locator(".candidate-row").nth(1).click();
  await expect.poll(async () => (await inspect()).preview).toBe(true);
  await page.getByLabel("위성 선택", { exact: true }).selectOption("0");
  await page.getByRole("button", { name: "위성 추적", exact: true }).click();
  await expect.poll(async () => (await inspect()).show).toBe(true);
  await expect
    .poll(async () => (await inspect()).distance)
    .toBeLessThan(5000000);
  expect((await inspect()).image).toMatch(/textures\/satellite-node\.png$/);
  const response = await page.request.get("/textures/satellite-node.png");
  expect(response.ok()).toBe(true);
  await page.screenshot({ path: "test-results/satellite-image.png" });
  expect(errors).toEqual([]);
  await cdp.detach();
});
