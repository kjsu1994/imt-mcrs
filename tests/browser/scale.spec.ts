import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import {
  SimulationEngine,
  normalizeScenario,
  createScenario,
  DEFAULT_EPOCH_MS,
} from "../../src/engine.ts";
import { PRESETS } from "../../src/model.ts";
test("72 and 1584 bounded MCSR are selectable, observable and match CLI under slow rendering", async ({
  page,
  context,
}) => {
  test.setTimeout(240000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  for (const n of [72, 1584]) {
    await page
      .getByRole("button", {
        name: `MCSR 예제 · ${n === 72 ? "72" : "1,584"}기`,
        exact: true,
      })
      .click();
    await expect(page.locator(".run-status")).toHaveText("일시정지", {
      timeout: 60000,
    });
    await expect(
      page.getByLabel("MCSR 탐색 모드", { exact: true }),
    ).toHaveValue("bounded");
    await expect(
      page.getByLabel("MCSR 영역 상태", { exact: true }),
    ).toContainText(`SRD ${n === 72 ? 9 : 72}개`, { timeout: 60000 });
    await expect(page.getByLabel("탐색 제한", { exact: true })).toContainText(
      "전체 우세 경로 보장 없음",
    );
    if (n === 1584) {
      const url = await page.evaluate(() =>
        performance
          .getEntriesByType("resource")
          .map((e) => e.name)
          .find((u) => /\/deps\/cesium\.js/.test(u)),
      );
      const cdp = await context.newCDPSession(page);
      const { result } = await cdp.send("Runtime.evaluate", {
        expression: `import(${JSON.stringify(url)}).then(m=>m.Viewer.prototype)`,
        awaitPromise: true,
      });
      const { objects } = await cdp.send("Runtime.queryObjects", {
        prototypeObjectId: result.objectId!,
      });
      async function labels() {
        const r = await cdp.send("Runtime.callFunctionOn", {
          objectId: objects.objectId!,
          returnByValue: true,
          functionDeclaration: `function(){const v=this.find(v=>!v.isDestroyed()),p=v.scene.primitives;return Array.from({length:p.length},(_,i)=>p.get(i)).flatMap(x=>typeof x.length==='number'&&typeof x.get==='function'?Array.from({length:x.length},(_,i)=>x.get(i)):[]).filter(x=>typeof x.text==='string'&&x.text.startsWith('DS · S')&&x.show).length;}`,
        });
        return r.result.value;
      }
      await expect.poll(labels).toBe(2);
      await page.getByLabel("위성 선택", { exact: true }).selectOption("777");
      await expect.poll(labels).toBe(3);
      await page.getByLabel("위성 선택", { exact: true }).selectOption("");
      await expect.poll(labels).toBe(2);
      await page.getByLabel("SRD·DS 표시", { exact: true }).uncheck();
      await expect.poll(labels).toBe(0);
      await page.getByLabel("SRD·DS 표시", { exact: true }).check();
      await expect.poll(labels).toBe(2);
      await cdp.detach();
    }
    if (n === 1584) {
      await expect(page.locator(".candidate-row strong").first()).toContainText(
        "…",
      );
      await expect(page.locator(".candidate-row").first()).toHaveAttribute(
        "title",
        /^0 → .*1573$/,
      );
      await expect(page.locator(".candidate-row").first()).toContainText("ms");
    }
    await page.locator(".candidate-row").first().click();
    await expect(page.locator(".candidate-row.active")).toHaveCount(1);
    const s = normalizeScenario(
      JSON.parse(await readFile(`examples/mcsr-${n}.json`, "utf8")),
    );
    s.durationUs = 26000000;
    s.failures = s.failures.filter((f) => f.atUs <= s.durationUs);
    s.linkMetricUpdates = s.linkMetricUpdates.filter(
      (f) => f.atUs <= s.durationUs,
    );
    async function load() {
      await page
        .getByLabel("시나리오 가져오기", { exact: true })
        .setInputFiles({
          name: "scale.json",
          mimeType: "application/json",
          buffer: Buffer.from(JSON.stringify(s)),
        });
      await expect(page.locator(".run-status")).toHaveText("일시정지", {
        timeout: 60000,
      });
    }
    async function result() {
      const pending = page.waitForEvent("download");
      await page
        .getByRole("button", { name: "결과 저장", exact: true })
        .click();
      return JSON.parse(
        await readFile((await (await pending).path())!, "utf8"),
      );
    }
    await load();
    await page
      .getByRole("button", { name: "끝까지 실행", exact: true })
      .click();
    await expect(page.locator(".run-status")).toHaveText("종료", {
      timeout: 60000,
    });
    const normal = await result(),
      core = new SimulationEngine(s);
    while (!core.advanceTo(s.durationUs, 500)) core.drainDeltas();
    expect(normal.result).toEqual(core.result());
    expect(normal.result.validForAnalysis).toBe(true);
    await page.getByLabel("시뮬레이션 시간", { exact: true }).fill("0");
    await expect(page.locator(".run-status")).toHaveText("일시정지", {
      timeout: 60000,
    });
    await expect(
      page.getByLabel("MCSR 탐색 모드", { exact: true }),
    ).toHaveValue("bounded");
    await page.locator(".mcsr-summary").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `test-results/mcsr-scale-${n}.png` });
    if (n === 1584) {
      await page.addInitScript(() => {
        const raf = window.requestAnimationFrame.bind(window);
        window.requestAnimationFrame = (callback) =>
          raf(() => setTimeout(() => callback(performance.now()), 200));
      });
      await page.reload();
      await load();
      await page
        .getByRole("button", { name: "끝까지 실행", exact: true })
        .click();
      await expect(page.locator(".run-status")).toHaveText("종료", {
        timeout: 60000,
      });
      expect((await result()).result).toEqual(normal.result);
    }
  }
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(errors).toEqual([]);
});
test("a Worker load cancels an unfinished large search without exporting the old job", async ({
  page,
}) => {
  const large = createScenario(PRESETS[1].config, DEFAULT_EPOCH_MS, 0, 1573);
  large.routing.algorithm = "mcsr";
  const small = createScenario(PRESETS[0].config, DEFAULT_EPOCH_MS);
  await page.goto("/");
  const reply = await page.evaluate(
    ({ large, small }) =>
      new Promise<any>((resolve, reject) => {
        const worker = new Worker("/src/simulation.worker.ts", {
          type: "module",
        });
        const timer = setTimeout(() => {
          worker.terminate();
          reject(new Error("worker load timeout"));
        }, 30000);
        worker.onmessage = ({ data }) => {
          if (data.type === "error") {
            clearTimeout(timer);
            worker.terminate();
            reject(new Error(data.message));
          } else if (data.type === "state" && data.runId === 2) {
            clearTimeout(timer);
            worker.terminate();
            resolve({
              runId: data.runId,
              timeUs: data.progress.timeUs,
              pathValid: data.progress.pathValid,
            });
          }
        };
        worker.postMessage({
          type: "load",
          runId: 1,
          scenario: large,
          playing: false,
          speed: 1,
        });
        setTimeout(
          () =>
            worker.postMessage({
              type: "load",
              runId: 2,
              scenario: small,
              playing: false,
              speed: 1,
            }),
          10,
        );
      }),
    { large, small },
  );
  expect(reply).toEqual({ runId: 2, timeUs: 0, pathValid: true });
});

test("pausing during bounded work preserves the requested verification checkpoint", async ({
  page,
}) => {
  const scenario = createScenario(PRESETS[0].config, DEFAULT_EPOCH_MS, 0, 61);
  scenario.routing.algorithm = "mcsr";
  scenario.durationUs = 33000000;
  await page.goto("/");
  const result = await page.evaluate(
    (scenario) =>
      new Promise<any>((resolve, reject) => {
        const worker = new Worker("/src/simulation.worker.ts", {
          type: "module",
        });
        let stage = "initial";
        const timer = setTimeout(() => {
          worker.terminate();
          reject(new Error("pause checkpoint timeout"));
        }, 30000);
        worker.onmessage = ({ data }) => {
          if (data.type === "error") {
            clearTimeout(timer);
            worker.terminate();
            reject(new Error(data.message));
            return;
          }
          if (stage === "initial" && data.type === "state" && data.reset) {
            stage = "playing";
            worker.postMessage({
              type: "play",
              runId: 1,
              playing: true,
              speed: 300,
            });
          } else if (stage === "playing" && data.type === "busy") {
            stage = "paused";
            worker.postMessage({
              type: "play",
              runId: 1,
              playing: false,
              speed: 300,
            });
          } else if (
            stage === "paused" &&
            data.type === "state" &&
            !data.busy &&
            !data.playing
          ) {
            clearTimeout(timer);
            worker.terminate();
            resolve({ checkpoint: !!data.checkpoint, playing: data.playing });
          }
        };
        worker.postMessage({
          type: "load",
          runId: 1,
          scenario,
          playing: false,
          speed: 300,
        });
      }),
    scenario,
  );
  expect(result).toEqual({ checkpoint: true, playing: false });
});
