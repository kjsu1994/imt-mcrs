import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { SimulationEngine } from "../../src/engine.ts";
test("ISL control messages, delayed recovery, settings, 3D and throttled replay agree", async ({
  page,
  context,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page
    .getByRole("button", { name: "MCSR 예제 불러오기 · 16기", exact: true })
    .click();
  await expect(page.getByLabel("제어 통지 모델", { exact: true })).toHaveValue(
    "isl",
  );
  await expect(page.getByLabel("ACK 제한 시간", { exact: true })).toHaveValue(
    "500",
  );
  await expect(page.locator(".run-status")).toHaveText("일시정지");
  await expect(page.locator(".candidate-row")).toHaveCount(2);
  const toggle = page
    .getByLabel("제어 메시지 표시", { exact: true })
    .locator("..");
  await toggle.scrollIntoViewIfNeeded();
  const toggleBox = (await toggle.boundingBox())!,
    applyBox = (await page
      .getByRole("button", { name: "제어 통신 적용", exact: true })
      .boundingBox())!;
  expect(toggleBox.y).toBeGreaterThanOrEqual(applyBox.y + applyBox.height);

  await page.getByLabel("시뮬레이션 시간", { exact: true }).fill("1.04");
  await expect(page.locator(".control-summary")).toContainText("ACK 대기");
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
  async function visibleControls() {
    const r = await cdp.send("Runtime.callFunctionOn", {
      objectId: objects.objectId!,
      returnByValue: true,
      functionDeclaration: `function(){const v=this.find(v=>!v.isDestroyed()),p=v.scene.primitives;return Array.from({length:p.length},(_,i)=>p.get(i)).flatMap(x=>typeof x.length==='number'&&typeof x.get==='function'?Array.from({length:x.length},(_,i)=>x.get(i)):[]).filter(x=>typeof x.id==='string'&&x.id.startsWith('control:')&&x.show).length;}`,
    });
    return r.result.value;
  }
  await expect.poll(visibleControls).toBeGreaterThan(0);
  await page.getByLabel("제어 메시지 표시", { exact: true }).uncheck();
  await expect.poll(visibleControls).toBe(0);
  await page.getByLabel("제어 메시지 표시", { exact: true }).check();
  await expect.poll(visibleControls).toBeGreaterThan(0);
  await cdp.detach();
  await page
    .locator(".control-summary summary")
    .filter({ hasText: "제어 메시지 이력" })
    .click();
  await page
    .locator(".control-summary .event-jump")
    .filter({ hasText: "전달 실패" })
    .last()
    .click();
  await expect(page.locator(".control-summary")).toContainText("선택 #");
  await page.getByLabel("시뮬레이션 시간", { exact: true }).fill("1.25");
  await expect(page.locator(".recovery-list")).toContainText(
    "출발 영역 인지 —",
  );
  await page.getByLabel("시뮬레이션 시간", { exact: true }).fill("1.5");
  await expect(page.locator(".recovery-list")).toContainText("예비 전환");
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
  expect(data.result.mcsr.control.stats.retries).toBeGreaterThan(0);
  expect(data.result.serviceOutages[0].recoveryMechanism).toBe("reserve");
  await page.getByLabel("ACK 제한 시간", { exact: true }).fill("0");
  await page
    .getByRole("button", { name: "제어 통신 적용", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("ACK 제한 시간");
  await expect(page.locator(".run-status")).toHaveText("종료");
  await page.getByLabel("ACK 제한 시간", { exact: true }).fill("1000");
  await page
    .getByLabel("제어 통지 모델", { exact: true })
    .selectOption("fixed");
  await page
    .getByRole("button", { name: "제어 통신 적용", exact: true })
    .click();
  await expect(page.locator(".control-summary")).toHaveCount(0);
  await page
    .getByRole("button", { name: "MCSR 예제 불러오기 · 16기", exact: true })
    .click();
  await page.getByLabel("시뮬레이션 시간", { exact: true }).fill("1.04");
  await page.locator(".control-summary").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/mcsr-control.png" });
  await page
    .getByLabel("시나리오 가져오기", { exact: true })
    .setInputFiles({
      name: "candidate-routing.json",
      mimeType: "application/json",
      buffer: await readFile("examples/candidate-routing.json"),
    });
  await expect(page.locator(".control-summary")).toHaveCount(0);
  await page.addInitScript(() => {
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) =>
      raf(() => setTimeout(() => cb(performance.now()), 200));
  });
  await page.reload();
  await page
    .getByRole("button", { name: "MCSR 예제 불러오기 · 16기", exact: true })
    .click();
  await expect(page.locator(".run-status")).toHaveText("일시정지");
  await page.getByRole("button", { name: "끝까지 실행", exact: true }).click();
  await expect(page.locator(".run-status")).toHaveText("종료");
  const slowPending = page.waitForEvent("download");
  await page.getByRole("button", { name: "결과 저장", exact: true }).click();
  const slow = JSON.parse(
    await readFile((await (await slowPending).path())!, "utf8"),
  );
  expect(slow.result).toEqual(data.result);
  expect(errors).toEqual([]);
});
