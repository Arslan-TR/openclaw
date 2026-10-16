/* @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  createConnectedContext,
  modelAccountProfile,
  mountProfilePage,
} from "./profile-page.test-support.tsx";

it("retains the name draft and loaded profile through a same-client blip, but retires them for another identity", async () => {
  let profile = modelAccountProfile;
  const request = vi.fn(async (method: string) => {
    if (method === "users.self") {
      return { profile };
    }
    if (method === "users.listModelAccounts") {
      return { profileId: profile.id, accounts: [], links: [] };
    }
    throw new Error(`Unexpected request ${method}`);
  });
  const harness = createConnectedContext(request as GatewayBrowserClient["request"], {
    id: modelAccountProfile.id,
    name: "Ada",
  });
  harness.emitHello(gatewayHelloForMethods([], ["operator.write"]));
  const page = mountProfilePage(harness.context);
  const input = () => page.querySelector<HTMLInputElement>(".identity-name-control input");
  try {
    await waitForSolid(() => expect(input()?.value).toBe("Ada"));
    input()!.value = "Ada draft";
    input()!.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    harness.emitConnected(false);
    flush();
    expect(input()?.value).toBe("Ada draft");
    expect(page.textContent).toContain("ada@example.test");
    expect(page.querySelector<HTMLButtonElement>(".identity-name-control button")?.disabled).toBe(
      true,
    );
    const reads = request.mock.calls.filter(([method]) => method === "users.self").length;
    harness.emitSnapshot({ phase: "connected", selfUser: undefined });
    flush();
    expect(input()?.value).toBe("Ada draft");
    expect(page.querySelector<HTMLButtonElement>(".identity-name-control button")?.disabled).toBe(
      true,
    );
    expect(request.mock.calls.filter(([method]) => method === "users.self")).toHaveLength(reads);
    harness.emitSnapshot({ selfUser: { id: modelAccountProfile.id, name: "Ada" } });
    await waitForSolid(() => {
      expect(input()?.value).toBe("Ada draft");
      expect(page.querySelector<HTMLButtonElement>(".identity-name-control button")?.disabled).toBe(
        false,
      );
    });
    profile = { ...modelAccountProfile, id: "profile-2", displayName: "Grace" };
    harness.emitSnapshot({ selfUser: { id: "profile-2", name: "Grace" } });
    await waitForSolid(() => expect(input()?.value).toBe("Grace"));
  } finally {
    page.unmount();
  }
});
