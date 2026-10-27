import { test, expect } from "@playwright/test";
test("Earth remains centered after off-center zoom, drags and satellite tracking", async ({
  page,
  context,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.locator("canvas")).toBeVisible();
  await expect(page.locator(".run-status")).not.toHaveText("계산 중");
  // Inspect the live Cesium instance through DevTools without adding a production debug API.
  const moduleUrl = await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .map((e) => e.name)
      .find((u) => /\/deps\/cesium\.js/.test(u)),
  );
  expect(moduleUrl).toBeTruthy();
  const cdp = await context.newCDPSession(page);
  const { result } = await cdp.send("Runtime.evaluate", {
    expression: `import(${JSON.stringify(moduleUrl)}).then(m=>m.Viewer.prototype)`,
    awaitPromise: true,
  });
  const { objects } = await cdp.send("Runtime.queryObjects", {
    prototypeObjectId: result.objectId!,
  });
  async function camera() {
    const answer = await cdp.send("Runtime.callFunctionOn", {
      objectId: objects.objectId!,
      functionDeclaration: `function(){const v=this.find(v=>!v.isDestroyed()),c=v.camera,p=c.positionWC,d=c.directionWC,r=Math.hypot(p.x,p.y,p.z);return {alignment:-(p.x*d.x+p.y*d.y+p.z*d.z)/r,range:r,position:{x:p.x,y:p.y,z:p.z},minimum:v.scene.screenSpaceCameraController.minimumZoomDistance,maximum:v.scene.screenSpaceCameraController.maximumZoomDistance};}`,
      returnByValue: true,
    });
    return answer.result.value as {
      alignment: number;
      range: number;
      position: { x: number; y: number; z: number };
      minimum: number;
      maximum: number;
    };
  }
  async function centered() {
    await expect
      .poll(async () => (await camera()).alignment)
      .toBeGreaterThan(0.999999999);
    const c = await camera();
    expect(c.range).toBeGreaterThanOrEqual(c.minimum - 10);
    expect(c.range).toBeLessThanOrEqual(c.maximum + 10);
  }
  await centered();
  const motion = await cdp.send("Runtime.callFunctionOn", {
    objectId: objects.objectId!,
    functionDeclaration: `function(){const v=this.find(v=>!v.isDestroyed());return new Promise(resolve=>{const times=[];function sample(){times.push(v.clock.currentTime.secondsOfDay);if(times.length<40)requestAnimationFrame(sample);else resolve(times);}requestAnimationFrame(sample);});}`,
    awaitPromise: true,
    returnByValue: true,
  });
  const times = motion.result.value as number[];
  expect(new Set(times).size).toBeGreaterThan(times.length * 0.6);
  await page.getByRole("button", { name: "일시정지", exact: true }).click();
  const rotationBox = (await page.locator("canvas").boundingBox())!;
  async function dragAngle(range: number) {
    await cdp.send("Runtime.callFunctionOn", {
      objectId: objects.objectId!,
      functionDeclaration: `function(range){const c=this.find(v=>!v.isDestroyed()).camera,p=c.position,r=range/Math.hypot(p.x,p.y,p.z);p.x*=r;p.y*=r;p.z*=r;}`,
      arguments: [{ value: range }],
    });
    await page.waitForTimeout(100);
    const before = await camera();
    const x = rotationBox.x + rotationBox.width / 2, y = rotationBox.y + rotationBox.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + rotationBox.width * 0.08, y, { steps: 8 });
    await page.mouse.up();
    const after = await camera();
    return Math.acos(Math.min(1, Math.max(-1, (before.position.x*after.position.x + before.position.y*after.position.y + before.position.z*after.position.z) / (before.range*after.range))));
  }
  const farAngle = await dragAngle(6378137 + 21000000);
  const nearAngle = await dragAngle(6378137 + 500000);
  expect(farAngle).toBeGreaterThan(0.1);
  expect(nearAngle).toBeGreaterThan(0);
  expect(nearAngle / farAngle).toBeLessThan(0.1);
  await page.getByRole("button", { name: "전체 보기", exact: true }).click();
  for (const [dx, dy] of [
    [0, 0.22],
    [0, -0.22],
    [0.22, 0],
    [-0.22, 0],
  ]) {
    for (let turn = 0; turn < 6; turn++) {
      const before = await camera();
      const x = rotationBox.x + rotationBox.width / 2;
      const y = rotationBox.y + rotationBox.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(
        x + rotationBox.width * dx,
        y + rotationBox.height * dy,
        { steps: 10 },
      );
      await page.mouse.up();
      await centered();
      const after = await camera();
      expect(
        Math.hypot(
          after.position.x - before.position.x,
          after.position.y - before.position.y,
          after.position.z - before.position.z,
        ),
        `rotation ${dx},${dy} pass ${turn}`,
      ).toBeGreaterThan(before.range * 0.05);
    }
  }
  for (const [width, height] of [
    [1440, 900],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    await page.getByRole("button", { name: "전체 보기", exact: true }).click();
    await centered();
    const box = (await page.locator("canvas").boundingBox())!;
    for (const [x, y, delta] of [
      [0.1, 0.2, -3000],
      [0.9, 0.8, -3000],
      [0.9, 0.2, 6000],
      [0.1, 0.8, 6000],
    ]) {
      await page.mouse.move(box.x + box.width * x, box.y + box.height * y);
      await page.mouse.wheel(0, delta);
      await page.waitForTimeout(300);
      await centered();
    }
    const before = (await camera()).position;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.65, {
      steps: 12,
    });
    await page.mouse.up();
    await centered();
    const after = (await camera()).position;
    expect(
      Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z),
    ).toBeGreaterThan(1000);
    await page.keyboard.down("Shift");
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2, {
      steps: 8,
    });
    await page.mouse.up();
    await page.keyboard.up("Shift");
    await centered();
    await page.mouse.down({ button: "middle" });
    await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.8, {
      steps: 8,
    });
    await page.mouse.up({ button: "middle" });
    await centered();
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "위성 추적", exact: true }).click();
  await expect.poll(async () => (await camera()).alignment).toBeLessThan(0.999);
  await page.getByRole("button", { name: "추적 해제", exact: true }).click();
  await centered();
  await page.getByRole("button", { name: "전체 보기", exact: true }).click();
  await centered();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(errors).toEqual([]);
  await cdp.detach();
});
