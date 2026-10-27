import { test, expect } from "@playwright/test";

test("Worker heals dropped deltas and sends small progress messages between checkpoints", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    const w = window as any;
    w.transport = { messages: [], drop: false, dropped: false, resyncs: 0 };
    const Original = window.Worker;
    w.Worker = class extends Original {
      set onmessage(handler: any) {
        super.onmessage = (event) => {
          const data = event.data;
          if (data?.type === "state") {
            w.transport.messages.push({
              runId: data.runId,
              bytes: JSON.stringify(data).length,
              checkpointLinks: data.checkpoint?.links.length ?? 0,
              reset: data.reset,
              changedLinks: data.deltas.reduce(
                (n: number, d: any) => n + d.changedLinks.length,
                0,
              ),
            });
            if (
              w.transport.drop &&
              data.deltas.some((d: any) =>
                d.changedLinks.some((l: any) => l.id === "0:1" && !l.physical),
              )
            ) {
              w.transport.drop = false;
              w.transport.dropped = true;
              return;
            }
          }
          handler?.call(this, event);
        };
      }
      postMessage(
        message: any,
        options?: Transferable[] | StructuredSerializeOptions,
      ) {
        if (message?.type === "resync") w.transport.resyncs++;
        if (Array.isArray(options)) super.postMessage(message, options);
        else super.postMessage(message, options);
      }
    };
  });
  await page.goto("/");
  await expect(page.locator(".run-status")).toHaveText("재생 중");
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
  await page.getByLabel("실험 길이", { exact: true }).fill("8");
  await page.getByRole("button", { name: "실험 적용", exact: true }).click();
  await page.getByLabel("선택 링크", { exact: true }).selectOption("0:1");
  await page.getByLabel("장애 예약 시각").fill("1");
  await page.getByRole("button", { name: "장애 예약", exact: true }).click();
  await expect(page.getByText("장애 일정 1건", { exact: true })).toBeVisible();
  await page.getByLabel("장애 예약 시각").fill("1.05");
  await page.getByRole("button", { name: "복구 예약", exact: true }).click();
  await expect(page.getByText("장애 일정 2건", { exact: true })).toBeVisible();
  await page.getByLabel("재생 속도").selectOption("1");
  await page.evaluate(() => {
    (window as any).transport.drop = true;
  });
  await page.getByRole("button", { name: "재생", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).transport.resyncs), {
      timeout: 10000,
    })
    .toBeGreaterThan(0);
  await expect(page.locator(".run-status")).toHaveText("재생 중");
  await expect(page.locator(".recovery-list")).toContainText("50.000 ms");
  expect(await page.evaluate(() => (window as any).transport.dropped)).toBe(
    true,
  );
  await page.getByRole("button", { name: "일시정지", exact: true }).click();
  await page.getByLabel("실험 길이", { exact: true }).fill("30");
  await page.getByRole("button", { name: "실험 적용", exact: true }).click();
  await expect(page.locator(".run-status")).toHaveText("일시정지");
  await page.evaluate(() => {
    (window as any).transport.messages = [];
  });
  await page.getByLabel("성좌 프리셋").selectOption("1");
  await page.getByRole("button", { name: "성좌 적용", exact: true }).click();
  await expect(page.locator(".run-status")).toHaveText("일시정지");
  await page.getByRole("button", { name: "재생", exact: true }).click();
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (window as any).transport.messages.filter(
              (m: any) => m.checkpointLinks === 3146,
            ).length,
        ),
      { timeout: 10000 },
    )
    .toBeGreaterThanOrEqual(2);
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          (window as any).transport.messages.some(
            (m: any) => !m.checkpointLinks && !m.changedLinks,
          ),
        ),
      { timeout: 10000 },
    )
    .toBe(true);
  await page.getByRole("button", { name: "일시정지", exact: true }).click();
  const messages = (await page.evaluate(
    () => (window as any).transport.messages,
  )) as { bytes: number; checkpointLinks: number; changedLinks: number }[];
  const full = messages.find((m) => m.checkpointLinks === 3146)!;
  const idle = messages.filter((m) => !m.checkpointLinks && !m.changedLinks);
  // Message counts depend on host scheduling, so check the payload rather than throughput.
  expect(idle.length).toBeGreaterThan(0);
  expect(Math.max(...idle.map((m) => m.bytes))).toBeLessThan(full.bytes / 10);
  console.log(
    "TRANSPORT",
    JSON.stringify({
      checkpointBytes: full.bytes,
      maxIdleBytes: Math.max(...idle.map((m) => m.bytes)),
      idleMessages: idle.length,
    }),
  );
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(errors).toEqual([]);
});
