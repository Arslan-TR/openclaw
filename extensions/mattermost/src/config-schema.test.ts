import { describe, expect, it } from "vitest";
import { MattermostConfigSchema } from "./config-schema-core.js";

describe("MattermostConfigSchema", () => {
  it('rejects dmPolicy="open" without wildcard allowFrom', () => {
    const result = MattermostConfigSchema.safeParse({
      dmPolicy: "open",
    });
    expect(result.success).toBe(false);
  });

  it('accepts dmPolicy="open" with wildcard allowFrom', () => {
    const result = MattermostConfigSchema.safeParse({
      dmPolicy: "open",
      allowFrom: ["*"],
    });
    expect(result.success).toBe(true);
  });
});
