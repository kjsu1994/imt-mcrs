import { test, expect } from "@playwright/test";
test("panels, globe and playback remain separate across viewport sizes", async ({
  page,
}) => {
  for (const [width, height] of [
    [1440, 900],
    [1280, 720],
    [1024, 768],
    [851, 650],
    [850, 650],
    [390, 844],
    [667, 375],
    [320, 568],
  ]) {
    await page.setViewportSize({ width, height });
    await page.goto("/");
    await expect(page.locator("canvas")).toBeVisible();
    await page.waitForLoadState("networkidle");
    await expect(page.locator(".cesium-widget-credits")).toBeHidden();
    await expect(page.locator("body")).not.toContainText(
      /ORBITAL LAB|MISSION CONTROL|VISUALIZATION|위성 사이의 흐름을 보다/,
    );
    if (width <= 850) {
      await page
        .getByRole("button", { name: "성좌 설정", exact: true })
        .click();
      await expect(page.locator(".config-panel")).toBeVisible();
      await page
        .getByRole("button", { name: "위성 정보", exact: true })
        .click();
      await expect(page.locator(".info-panel")).toBeVisible();
      await expect(page.locator(".config-panel")).toHaveCount(0);
    }
    const layout = await page.evaluate(() => {
      const rect = (selector: string) => {
        const b = document.querySelector(selector)!.getBoundingClientRect();
        return {
          left: b.left,
          right: b.right,
          top: b.top,
          bottom: b.bottom,
          width: b.width,
          height: b.height,
        };
      };
      const slider = document.querySelector("input[type=range]")!,
        s = slider.getBoundingClientRect();
      return {
        viewport: rect(".viewport"),
        workspace: rect(".workspace"),
        header: rect(".topbar"),
        footer: rect(".timeline"),
        left: document.querySelector(".config-panel")
          ? rect(".config-panel")
          : null,
        right: rect(".info-panel"),
        overflow: document.documentElement.scrollWidth > window.innerWidth,
        sliderAccessible:
          document.elementFromPoint(
            s.left + s.width / 2,
            s.top + s.height / 2,
          ) === slider,
      };
    });
    expect(layout.overflow, `${width} horizontal overflow`).toBe(false);
    expect(layout.header.bottom).toBeLessThanOrEqual(layout.workspace.top);
    expect(layout.workspace.bottom).toBeLessThanOrEqual(layout.footer.top);
    expect(layout.sliderAccessible, `${width} timeline hit target`).toBe(true);
    expect(layout.viewport.width).toBeGreaterThan(0);
    if (width > 850) {
      expect(layout.left!.right).toBeLessThan(layout.viewport.left);
      expect(layout.viewport.right).toBeLessThan(layout.right.left);
      expect(layout.right.bottom).toBeLessThan(layout.footer.top);
    } else expect(layout.viewport.bottom).toBeLessThan(layout.right.top);
    await page.screenshot({
      path: `test-results/layout-${width}x${height}.png`,
    });
  }
});
