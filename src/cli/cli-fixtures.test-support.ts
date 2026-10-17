import fs from "node:fs/promises";
import path from "node:path";

export async function writeFixtureJson(file: string, value: unknown) {
  await fs.writeFile(file, JSON.stringify(value));
}

export async function writeCliPluginFixture(
  directory: string,
  name: string,
  manifest: Record<string, unknown>,
  source: string,
) {
  await fs.mkdir(directory, { recursive: true });
  await writeFixtureJson(path.join(directory, "package.json"), {
    name,
    version: "1.0.0",
    type: "module",
    openclaw: { extensions: ["./index.js"] },
  });
  await writeFixtureJson(path.join(directory, "openclaw.plugin.json"), {
    configSchema: { type: "object", properties: {}, additionalProperties: false },
    ...manifest,
  });
  await fs.writeFile(path.join(directory, "index.js"), source);
}
