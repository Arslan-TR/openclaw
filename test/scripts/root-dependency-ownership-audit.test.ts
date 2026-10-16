import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyRootDependencyOwnership,
  collectRootDependencyOwnershipAudit,
  collectRootDependencyOwnershipCheckErrors,
  collectModuleSpecifiers,
} from "../../scripts/root-dependency-ownership-audit.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function makeTempRepo(files: Record<string, string | object>) {
  const dir = tempDirs.make("openclaw-root-deps-audit-");
  for (const [file, value] of Object.entries(files)) {
    const target = path.join(dir, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, typeof value === "string" ? value : JSON.stringify(value), "utf8");
  }
  return dir;
}

function runtimeRecord(depName: string, spec: string, file: string, overrides = {}) {
  return {
    category: "core_runtime",
    declaredInExtensions: [],
    depName,
    fileCount: 1,
    internalizedBundledRuntimeOwners: [],
    recommendation: "keep at root",
    sampleFiles: [file],
    sections: [file.split("/")[0]],
    spec,
    ...overrides,
  };
}

describe("collectModuleSpecifiers", () => {
  it("resolves simple string constants used by lazy runtime imports", () => {
    expect([
      ...collectModuleSpecifiers(`
        const READABILITY_MODULE = "@mozilla/readability";
        const CLAWPDF_MODULE = "clawpdf";
        const CIAO_MODULE_ID = "@homebridge/ciao";
        let SQLITE_VEC_MODULE_ID = "sqlite-vec";
        import(READABILITY_MODULE);
        import(CLAWPDF_MODULE);
        require(CIAO_MODULE_ID);
        require.resolve(SQLITE_VEC_MODULE_ID);
      `),
    ]).toEqual(["@mozilla/readability", "clawpdf", "@homebridge/ciao", "sqlite-vec"]);
  });
});

describe("classifyRootDependencyOwnership", () => {
  it("treats scripts and tests as dev-only candidates", () => {
    expect(
      classifyRootDependencyOwnership({
        sections: ["scripts", "test"],
      }),
    ).toEqual({
      category: "script_or_test_only",
      recommendation: "consider moving from dependencies to devDependencies",
    });
  });

  it("treats extension-only deps as localizable", () => {
    expect(
      classifyRootDependencyOwnership({
        depName: "vendor-sdk",
        sections: ["extensions", "test"],
      }),
    ).toEqual({
      category: "extension_only_localizable",
      recommendation:
        "remove from root package.json and rely on owning extension manifests plus doctor --fix",
    });
  });

  it("treats unreferenced deps as removal candidates", () => {
    expect(
      classifyRootDependencyOwnership({
        sections: [],
      }),
    ).toEqual({
      category: "unreferenced",
      recommendation: "investigate removal; no direct source imports found in scanned files",
    });
  });
});

describe("collectRootDependencyOwnershipCheckErrors", () => {
  it("catches dependencies mirrored at root but only imported by one extension", () => {
    const manifest = { dependencies: { "vendor-sdk": "^1.0.0" } };
    const repoRoot = makeTempRepo({
      "package.json": manifest,
      "extensions/demo-channel/package.json": manifest,
      "extensions/demo-channel/src/setup.ts": 'const sdk = await import("vendor-sdk");\n',
    });

    const records = collectRootDependencyOwnershipAudit({ repoRoot, scanRoots: ["extensions"] });

    expect(collectRootDependencyOwnershipCheckErrors(records)).toEqual([
      "root dependency 'vendor-sdk' is extension-owned (remove from root package.json and rely on owning extension manifests plus doctor --fix); extension declarations: demo-channel:dependencies; sample imports: extensions/demo-channel/src/setup.ts",
    ]);
  });

  it("classifies root dependencies referenced through constant dynamic imports", () => {
    const repoRoot = makeTempRepo({
      "package.json": { dependencies: { clawpdf: "^0.2.0", "sqlite-vec": "0.1.9" } },
      "src/media/pdf-extract.ts": `
        const CLAWPDF_MODULE = "clawpdf";
        export async function loadPdf() {
          return import(CLAWPDF_MODULE);
        }
      `,
      "packages/memory-host-sdk/src/host/sqlite-vec.ts": `
        const SQLITE_VEC_MODULE_ID = "sqlite-vec";
        export async function loadSqliteVecModule() {
          return import(SQLITE_VEC_MODULE_ID);
        }
      `,
    });

    const records = collectRootDependencyOwnershipAudit({
      repoRoot,
      scanRoots: ["src", "packages"],
    });

    expect(records).toEqual([
      runtimeRecord("clawpdf", "^0.2.0", "src/media/pdf-extract.ts"),
      runtimeRecord("sqlite-vec", "0.1.9", "packages/memory-host-sdk/src/host/sqlite-vec.ts"),
    ]);
  });

  it("does not fail explicitly root-owned internal extension runtime dependencies", () => {
    const repoRoot = makeTempRepo({
      "package.json": {
        dependencies: { "@homebridge/ciao": "^1.3.7", "playwright-core": "1.59.1" },
      },
      "extensions/bonjour/package.json": { dependencies: { "@homebridge/ciao": "^1.3.7" } },
      "extensions/bonjour/src/advertiser.ts":
        'const CIAO_MODULE_ID = "@homebridge/ciao";\nimport(CIAO_MODULE_ID);\n',
      "extensions/browser/package.json": { dependencies: { "playwright-core": "1.59.1" } },
      "extensions/browser/src/browser/playwright-core.runtime.ts":
        'const runtime = require("playwright-core");\n',
    });

    const records = collectRootDependencyOwnershipAudit({ repoRoot, scanRoots: ["extensions"] });

    expect(records).toEqual([
      runtimeRecord("@homebridge/ciao", "^1.3.7", "extensions/bonjour/src/advertiser.ts", {
        category: "root_owned_extension_runtime",
        declaredInExtensions: ["bonjour:dependencies"],
        recommendation:
          "keep at root; the Bonjour runtime is shipped with packaged startup surfaces even though the bundled plugin also declares it",
      }),
      runtimeRecord(
        "playwright-core",
        "1.59.1",
        "extensions/browser/src/browser/playwright-core.runtime.ts",
        {
          category: "root_owned_extension_runtime",
          declaredInExtensions: ["browser:dependencies"],
          recommendation:
            "keep at root; the internal browser runtime is shipped with core even though downloadable browser-adjacent plugins also declare it",
        },
      ),
    ]);
    expect(collectRootDependencyOwnershipCheckErrors(records)).toStrictEqual([]);
  });

  it("allows runtime deps for bundled plugins that are still packaged in core", () => {
    const repoRoot = makeTempRepo({
      "package.json": {
        dependencies: { "vendor-sdk": "^1.0.0" },
        files: ["dist/", "!dist/extensions/externalized/**"],
      },
      "extensions/internal/package.json": { dependencies: { "vendor-sdk": "^1.0.0" } },
      "extensions/internal/openclaw.plugin.json": {},
      "extensions/internal/src/setup.ts": 'const sdk = await import("vendor-sdk");\n',
    });

    const records = collectRootDependencyOwnershipAudit({ repoRoot, scanRoots: ["extensions"] });

    expect(records).toEqual([
      runtimeRecord("vendor-sdk", "^1.0.0", "extensions/internal/src/setup.ts", {
        category: "root_owned_extension_runtime",
        declaredInExtensions: ["internal:dependencies"],
        internalizedBundledRuntimeOwners: ["internal:dependencies"],
        recommendation:
          "keep at root while bundled plugin runtime dependencies are internalized; owners: internal:dependencies",
      }),
    ]);
    expect(collectRootDependencyOwnershipCheckErrors(records)).toStrictEqual([]);
  });
});
