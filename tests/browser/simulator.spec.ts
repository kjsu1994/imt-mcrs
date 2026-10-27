import { test, expect } from "@playwright/test";
test("offline globe, flow, controls and regeneration", async ({ page }) => {
  const errors: string[] = [],
    external: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/*", async (r) => {
    const u = r.request().url();
    if (u.startsWith("http") && !u.startsWith("http://127.0.0.1:5173")) {
      external.push(u);
      await r.abort();
    } else await r.continue();
  });
  await page.goto("/");
  await expect(page.locator("canvas")).toBeVisible();
  await page.waitForTimeout(4000);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "일시정지", exact: true }).click();
  await page.waitForTimeout(500);
  const time = await page.locator("time").innerText();
  await page.waitForTimeout(600);
  await expect(page.locator("time")).toHaveText(time);
  await page.getByLabel("출발 노드", { exact: true }).selectOption("1");
  await page.getByLabel("도착 노드", { exact: true }).selectOption("5");
  await expect(page.locator(".route-summary")).toContainText("홉");
  await page.getByRole("button", { name: "위성 추적", exact: false }).click();
  await page.getByRole("button", { name: "추적 해제", exact: false }).click();
  await page.getByLabel("시뮬레이션 시간", { exact: true }).fill("1200");
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: "시간 초기화", exact: true }).click();
  await page.getByLabel("궤도 고도", { exact: true }).fill("0");
  await page.getByRole("button", { name: "성좌 적용" }).click();
  await expect(page.getByRole("alert")).toContainText("고도");
  await page.getByLabel("성좌 프리셋").selectOption("1");
  await page.getByRole("button", { name: "성좌 적용" }).click();
  await page.waitForTimeout(3000);
  await expect(page.getByLabel("위성 선택")).toHaveValue("");
  await expect(page.getByLabel("위성 선택").locator("option")).toHaveCount(
    1585,
  );
  await expect(page.locator("canvas")).toHaveCount(1);
  await page.screenshot({ path: "test-results/simulator.png" });
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByLabel("위성 선택").selectOption("0");
  await page.getByLabel("전체 궤도선", { exact: false }).check();
  await page.getByLabel("전체 궤도선", { exact: false }).uncheck();
  await page.getByRole("button", { name: "재생", exact: true }).click();
  const perf = await page.evaluate(async () => {
    const canvas = document.querySelector("canvas")!,
      gl = canvas.getContext("webgl2"),
      ext = gl?.getExtension("WEBGL_debug_renderer_info");
    const gpu = ext
      ? gl!.getParameter(ext.UNMASKED_RENDERER_WEBGL)
      : "unavailable";
    return await new Promise<{
      medianFps: number;
      frames: number;
      gpu: string;
      userAgent: string;
    }>((resolve) => {
      const deltas: number[] = [];
      let first = performance.now(),
        last = first;
      function frame(now: number) {
        deltas.push(now - last);
        last = now;
        if (now - first < 60000) requestAnimationFrame(frame);
        else {
          deltas.sort((a, b) => a - b);
          resolve({
            medianFps: 1000 / deltas[Math.floor(deltas.length / 2)],
            frames: deltas.length,
            gpu,
            userAgent: navigator.userAgent,
          });
        }
      }
      requestAnimationFrame(frame);
    });
  });
  await page.screenshot({ path: "test-results/after-performance.png" });
  console.log("PERFORMANCE", JSON.stringify(perf));
  await test.info().attach("performance.json", {
    body: JSON.stringify(perf, null, 2),
    contentType: "application/json",
  });
});
