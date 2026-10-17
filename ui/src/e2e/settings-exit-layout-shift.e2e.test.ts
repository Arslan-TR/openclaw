import { expect, it } from "vitest";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Settings exit layout shift",
  startServerBeforeBrowser: true,
});

const targets = [
  { pathname: "/usage", routeId: "usage" },
  { pathname: "/agents", routeId: "agents-home" },
] as const;

suite.define(() => {
  for (const target of targets) {
    it.each([400, 820])(
      `keeps the shell still from Models to ${target.pathname} at %ipx`,
      (width) =>
        suite.withPage(
          { ...createControlUiE2eContextOptions(), viewport: { width, height: 900 } },
          async ({ page }) => {
            await installMockGateway(page);
            await page.goto(`${suite.server.baseUrl}settings/model-providers`);
            await waitForControlUiRoute(page, {
              pathname: "/settings/model-providers",
              routeId: "model-providers",
            });
            await page.evaluate(() => {
              const shifts: unknown[] = [];
              Reflect.set(window, "__layoutShifts", shifts);
              new PerformanceObserver((list) => {
                for (const entry of list.getEntries()) {
                  const shift = entry as PerformanceEntry & {
                    value: number;
                    sources?: { node?: Node | null }[];
                  };
                  shifts.push({
                    value: shift.value,
                    nodes: shift.sources?.map((source) =>
                      source.node instanceof Element
                        ? source.node.className
                        : source.node?.nodeName,
                    ),
                  });
                }
              }).observe({ type: "layout-shift" });
            });
            await page.evaluate((pathname) => {
              history.pushState(null, "", pathname);
              window.dispatchEvent(new PopStateEvent("popstate"));
            }, target.pathname);
            await waitForControlUiRoute(page, target);
            const shifts = await page.evaluate(
              () =>
                new Promise((resolve) => {
                  // Layout-shift entries arrive after the frame that paints them.
                  requestAnimationFrame(() =>
                    requestAnimationFrame(() =>
                      setTimeout(() => resolve(Reflect.get(window, "__layoutShifts")), 100),
                    ),
                  );
                }),
            );
            expect(shifts).toEqual([]);
          },
        ),
    );
  }
});
