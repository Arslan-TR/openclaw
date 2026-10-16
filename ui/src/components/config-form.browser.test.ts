import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import { configHintTranslationKey } from "../i18n/lib/config-hint-translation.ts";
import {
  renderAnalyzedFormFixture,
  renderConfigFormFixture,
} from "../test-helpers/config-form-fixtures.tsx";
import type { ConfigFormProps } from "./config-form.shared.ts";
import {
  scalar,
  anyOf,
  oneOf,
  analyzeProperties,
  array,
  byText,
  edit,
  expectElement,
  object,
  query,
} from "./config-form.test-support.ts";
import { analyzeConfigSchema } from "./config-form.ts";

function renderConfigForm(
  props: Omit<ConfigFormProps, "onShowAdvanced"> & {
    onShowAdvanced?: () => void;
  },
) {
  return { showAdvanced: true, onShowAdvanced: () => {}, ...props };
}

const rootSchema = object({
  gateway: object({
    auth: object({
      token: { type: "string" },
    }),
  }),
  allowFrom: array({ type: "string" }),
  mode: scalar("string", { enum: ["off", "token"] }),
  enabled: {
    type: "boolean",
  },
  bind: anyOf({ const: "auto" }, { const: "lan" }, { const: "tailnet" }, { const: "loopback" }),
});
const rootAnalysis = analyzeConfigSchema(rootSchema);
let container: HTMLDivElement;
let onPatch: ReturnType<typeof vi.fn<ConfigFormProps["onPatch"]>>;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  onTestFinished(() => container.remove());
  onPatch = vi.fn();
});

function renderForm(
  analysis: ReturnType<typeof analyzeConfigSchema>,
  props: Omit<Parameters<typeof renderAnalyzedFormFixture>[2], "onPatch">,
) {
  renderAnalyzedFormFixture(container, analysis, { ...props, onPatch });
}

function selectSegmented(control: HTMLElement) {
  query<HTMLInputElement>(control, '.settings-segmented__input[type="radio"]').click();
}

afterEach(async () => {
  await i18n.setLocale("en");
});

describe("config form renderer", () => {
  it.each([
    { label: "Ingress", initiallyOpen: false },
    { label: "Portals", initiallyOpen: true },
  ])(
    "retains the manually toggled $label disclosure across a form update",
    ({ label, initiallyOpen }) => {
      const schema = object({
        gateway: object({
          portals: {
            ...object({
              ingress: {
                ...object({ port: { type: "integer" } }),
                title: "Ingress",
              },
            }),
            title: "Portals",
          },
        }),
      });
      const props = renderConfigForm({
        schema,
        uiHints: {},
        value: { gateway: { portals: { ingress: { port: 443 } } } },
        onPatch,
      });
      const findDisclosure = () =>
        [...container.querySelectorAll<HTMLDetailsElement>("details.cfg-object")].find(
          (node) =>
            node.querySelector(":scope > summary .settings-row__title")?.textContent?.trim() ===
            label,
        );
      renderConfigFormFixture(container, props);
      const disclosure = expectElement(findDisclosure(), label);
      const input = query<HTMLInputElement>(container, 'input[type="number"]');
      expect(input.value).toBe("443");
      expect(disclosure.open).toBe(initiallyOpen);
      query(disclosure, "summary").click();
      expect(disclosure.open).toBe(!initiallyOpen);

      renderConfigFormFixture(container, {
        ...props,
        value: { gateway: { portals: { ingress: { port: 8443 } } } },
      });

      expect(findDisclosure()).toBe(disclosure);
      expect(container.querySelector('input[type="number"]')).toBe(input);
      expect(input.value).toBe("8443");
      expect(disclosure.open).toBe(!initiallyOpen);
    },
  );

  it.each([
    {
      key: "gateway.auth.token",
      label: "Gateway Token",
      translated: "Ağ geçidi belirteci",
      help: "Token used to authenticate with the Gateway.",
      translatedHelp: "Ağ geçidi kimlik doğrulamasında kullanılan belirteç.",
      field: true,
    },
    {
      key: "cloudWorkers",
      label: "Cloud Workers",
      translated: "Bulut çalışanları",
      help: "Section help from the Gateway.",
      translatedHelp: "Bölüm açıklaması.",
      field: false,
    },
  ])(
    "localizes $key hints and preserves missing-copy fallbacks",
    async ({ key, label, translated, help, translatedHelp, field }) => {
      const hash = (kind: "label" | "help", text: string) =>
        configHintTranslationKey(key, kind, text).split(".").at(-1)!;
      i18n.registerTranslation("tr", {
        configHints: {
          [field ? "gateway%2Eauth%2Etoken" : key]: {
            label: { [hash("label", label)]: translated },
            help: { [hash("help", help)]: translatedHelp },
          },
        },
      });
      const analysis = field
        ? rootAnalysis
        : analyzeProperties({
            [key]: object({ enabled: { type: "boolean" } }, { description: "Schema description." }),
          });
      const props = { value: {}, onPatch, uiHints: { [key]: { label, help } } };
      const heading = () =>
        field
          ? container.querySelector("input.settings-input")?.getAttribute("aria-label")
          : container.querySelector("h2.settings-section__heading")?.textContent?.trim();
      const expectHelp = (text: string) => {
        if (field) {
          expect(container.textContent).toContain(text);
        } else {
          expect(container.querySelector(".settings-section__desc")?.textContent?.trim()).toBe(
            text,
          );
        }
      };
      for (const [locale, expectedLabel, expectedHelp] of [
        ["tr", translated, translatedHelp],
        ["en", label, help],
      ] as const) {
        await i18n.setLocale(locale);
        renderAnalyzedFormFixture(container, analysis, props);
        expect(heading()).toBe(expectedLabel);
        expectHelp(expectedHelp);
      }
      if (!field) {
        await i18n.setLocale("tr");
        renderAnalyzedFormFixture(container, analysis, {
          ...props,
          uiHints: { [key]: { label, help: "Updated Gateway help without a translation." } },
        });
        expect(heading()).toBe(translated);
        expectHelp("Updated Gateway help without a translation.");
        renderAnalyzedFormFixture(container, analysis, { ...props, uiHints: {} });
        expect(heading()).toBe("CloudWorkers");
        expectHelp("Schema description.");
      }
    },
  );

  it.each([false, true])(
    "renders section copy once, scoped to the subsection: %s",
    (subsection) => {
      renderForm(rootAnalysis, {
        value: {},
        activeSection: "gateway",
        activeSubsection: subsection ? "auth" : undefined,
        uiHints: { gateway: { label: "Runtime gateway label", help: "Runtime gateway help" } },
      });
      expect(
        Array.from(
          container.querySelectorAll(
            ".settings-section > .settings-section__header .settings-section__heading",
          ),
          (node) => node.textContent?.trim(),
        ),
      ).toEqual([subsection ? "Auth" : "Gateway"]);
      if (subsection) {
        expect(container.querySelector(".cfg-object")).toBeNull();
        expect(
          Array.from(container.querySelectorAll(".settings-row__title"), (node) =>
            node.textContent?.trim(),
          ),
        ).toEqual(["Token"]);
      } else {
        expect(container.querySelector(".settings-section__desc")?.textContent?.trim()).toBe(
          "Gateway server settings (port, auth, binding)",
        );
      }
    },
  );

  it("conceals core-classified encryption, private-key, and local service env values", () => {
    const analysis = analyzeProperties({
      encryptKey: { type: "string" },
      privateKey: { type: "string" },
      localService: object({
        env: object({ FOO: { type: "string" } }),
      }),
    });

    renderForm(analysis, {
      value: {
        encryptKey: "encrypt-value",
        privateKey: "private-value",
        localService: { env: { FOO: "env-value" } },
      },
      revealSensitive: false,
    });

    for (const label of ["Encrypt Key", "Private Key", "FOO"]) {
      const input = query<HTMLInputElement>(container, `input[aria-label='${label}']`);
      expect(input.readOnly).toBe(true);
      expect(input.classList.contains("cfg-redacted")).toBe(true);
      expect(input.value).toBe("");
    }
    expect(container.innerHTML).not.toContain("encrypt-value");
    expect(container.innerHTML).not.toContain("private-value");
    expect(container.innerHTML).not.toContain("env-value");
  });

  it.each([
    ["string", { type: "string" }],
    ["string or SecretRef", { type: ["string", "object"] }],
  ])("keeps a masked sensitive %s field editable across keystrokes", async (_name, tokenSchema) => {
    const { userEvent } = await import("vitest/browser");
    const analysis = analyzeProperties({ token: tokenSchema });
    const revealed = new Set<string>();
    let value: Record<string, unknown> = {};
    const draw = () =>
      renderConfigFormFixture(
        container,
        renderConfigForm({
          schema: analysis.schema,
          unsupportedPaths: analysis.unsupportedPaths,
          uiHints: { token: { sensitive: true } },
          value,
          maskSensitive: true,
          isSensitivePathRevealed: (path) => revealed.has(path.join(".")),
          onToggleSensitivePath: (path) => {
            revealed.add(path.join("."));
            draw();
          },
          onPatch: (_path, next) => {
            value = { token: next };
            draw();
          },
        }),
      );
    const token = () => query<HTMLInputElement>(container, "input[aria-label='Token']");

    draw();
    await userEvent.click(token());
    await userEvent.keyboard("xy");
    await userEvent.click(token());

    expect(value).toEqual({ token: "xy" });
    expect(document.activeElement).toBe(token());
    expect(token().readOnly).toBe(false);
    expect(token().type).toBe("password");
    expect(revealed.size).toBe(0);
  });

  it("renders inputs and patches values", () => {
    const analysis = rootAnalysis;
    renderForm(analysis, {
      uiHints: {
        "gateway.auth.token": { label: "Gateway Token", sensitive: true },
      },
      value: { allowFrom: ["+1"], bind: "auto" },
      revealSensitive: true,
    });

    const tokenInput = query<HTMLInputElement>(
      container,
      '#config-section-gateway input.settings-input[type="text"]',
    );
    edit(tokenInput, "abc123");
    expect(onPatch).toHaveBeenCalledWith(["gateway", "auth", "token"], "abc123");

    const tokenButton = byText<HTMLElement>(container, ".settings-segmented__btn", "token");
    selectSegmented(tokenButton);
    expect(onPatch).toHaveBeenCalledWith(["mode"], "token");

    const checkbox = query<HTMLInputElement>(container, '.settings-toggle__input[role="switch"]');
    checkbox.click();
    expect(onPatch).toHaveBeenCalledWith(["enabled"], true);

    const addButton = byText<HTMLButtonElement>(container, ".cfg-array button", "Add");
    addButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(["allowFrom"], ["+1", ""]);

    const removeButton = query(container, ".cfg-array button[aria-label='Remove item']");
    removeButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(["allowFrom"], []);

    const tailnetButton = byText<HTMLElement>(container, ".settings-segmented__btn", "tailnet");
    selectSegmented(tailnetButton);
    expect(onPatch).toHaveBeenCalledWith(["bind"], "tailnet");
  });

  it("preserves raw phone values and focus as presentations change", () => {
    const analysis = analyzeProperties({
      fromNumber: { type: "string" },
      target: { type: "string" },
      accounts: {
        type: "object",
        additionalProperties: object({
          allowFrom: array({ type: "string" }),
        }),
      },
    });
    const draw = (fromNumber: string) =>
      renderForm(analysis, {
        uiHints: {
          fromNumber: { presentation: "phone-number" },
          target: { presentation: "phone-number" },
          "accounts.*.allowFrom.*": { presentation: "phone-number" },
        },
        value: {
          fromNumber,
          target: "token-value",
          accounts: { work: { allowFrom: ["+81312345678"] } },
        },
      });

    draw("+4930123456");
    const phoneInputs = Array.from(
      container.querySelectorAll<HTMLInputElement>(".settings-phone-presentation input"),
    );
    expect(phoneInputs.map((input) => input.value)).toEqual(
      expect.arrayContaining(["+4930123456", "+81312345678", "token-value"]),
    );
    expect(phoneInputs).toHaveLength(3);
    expect(
      Array.from(container.querySelectorAll(".settings-phone-presentation__value")).map((node) =>
        node.textContent?.trim(),
      ),
    ).toEqual(expect.arrayContaining(["Germany · +49 30 123456", "Japan · +81 3 1234 5678"]));
    const tokenInput = expectElement(
      Array.from(container.querySelectorAll<HTMLInputElement>("input.settings-input")).find(
        (input) => input.value === "token-value",
      ),
      "token input",
    );
    const tokenPresentation = expectElement(
      tokenInput.closest(".settings-phone-presentation"),
      "token phone presentation wrapper",
    );
    expect(tokenPresentation.querySelector(".settings-phone-presentation__value")).toBeNull();

    const fromNumberInput = expectElement(
      phoneInputs.find((input) => input.value === "+4930123456"),
      "from number input",
    );
    edit(fromNumberInput, " +4930123456 ");
    expect(onPatch).toHaveBeenLastCalledWith(["fromNumber"], " +4930123456 ");
    fromNumberInput.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onPatch).toHaveBeenLastCalledWith(["fromNumber"], "+4930123456");
    draw("+123");
    fromNumberInput.focus();
    for (const phone of ["+4930123456", "+123"]) {
      draw(phone);
      const presentation = fromNumberInput.closest(".settings-phone-presentation")!;
      if (phone === "+123") {
        expect(presentation.querySelector(".settings-phone-presentation__value")).toBeNull();
      } else {
        expect(
          presentation.querySelector(".settings-phone-presentation__value")?.textContent,
        ).toContain("+49 30 123456");
      }
      expect(presentation.querySelector("input.settings-input")).toBe(fromNumberInput);
      expect(document.activeElement).toBe(fromNumberInput);
    }
  });

  it.each([false, true])("renders named toggle rows with wildcard hints: %s", (wildcard) => {
    const analysis = analyzeConfigSchema(
      wildcard
        ? object({
            plugins: object({
              entries: {
                type: "object",
                additionalProperties: object({ enabled: { type: "boolean" } }),
              },
            }),
          })
        : object({
            features: object({ beta: { type: "boolean", description: "Enable beta features" } }),
          }),
    );
    renderForm(analysis, {
      uiHints: wildcard ? { "plugins.entries.*.enabled": { label: "Plugin Enabled" } } : {},
      value: wildcard
        ? { plugins: { entries: { "voice-call": { enabled: true } } } }
        : { features: { beta: false } },
    });
    const checkbox = query<HTMLInputElement>(container, '.settings-toggle__input[role="switch"]');
    const row = expectElement(checkbox.closest(".settings-row"), "toggle row");
    const label = wildcard ? "Plugin Enabled" : "Beta";
    expect(row.tagName).toBe("DIV");
    expect(row.querySelector(".settings-row__title")?.textContent?.trim()).toBe(label);
    expect(
      container.querySelector(`#${checkbox.getAttribute("aria-labelledby")}`)?.textContent?.trim(),
    ).toBe(label);
    if (!wildcard) {
      expect(row.querySelector(".settings-row__desc")?.textContent?.trim()).toBe(
        "Enable beta features",
      );
    }
    checkbox.click();
    expect(onPatch).toHaveBeenCalledWith(
      wildcard ? ["plugins", "entries", "voice-call", "enabled"] : ["features", "beta"],
      !wildcard,
    );
  });

  it("keeps dropdown selects on their configured value after options render", () => {
    const schema = object({
      provider: scalar("string", {
        enum: ["anthropic", "codex", "gemini", "openai", "openrouter", "zai"],
      }),
      bind: anyOf(
        { const: "auto" },
        { const: "lan" },
        { const: "tailnet" },
        { const: "loopback" },
        { const: "public" },
        { const: "off" },
      ),
    });
    const analysis = analyzeConfigSchema(schema);

    renderForm(analysis, { value: { provider: "openai", bind: "tailnet" } });

    const selects = container.querySelectorAll<HTMLSelectElement>("select.settings-select");
    expect(selects).toHaveLength(2);
    const selectedLabels = Array.from(selects).map((select) =>
      select.selectedOptions[0]?.textContent?.trim(),
    );
    expect(selectedLabels).toEqual(["tailnet", "openai"]);
  });

  it("shows an unset default-on boolean as its placeholder instead of an off toggle", () => {
    const analysis = analyzeProperties({
      cron: object({ enabled: { type: "boolean" } }),
    });
    renderConfigFormFixture(
      container,
      renderConfigForm({
        schema: analysis.schema,
        uiHints: { "cron.enabled": { label: "Automations Enabled", placeholder: "Default: On" } },
        unsupportedPaths: analysis.unsupportedPaths,
        value: {},
        onPatch,
      }),
    );

    expect(container.querySelector('.settings-toggle__input[role="switch"]')).toBeNull();
    const select = query<HTMLSelectElement>(container, 'select[aria-label="Automations Enabled"]');
    expect(select.selectedOptions[0]?.textContent?.trim()).toBe("Default: On");
    expect(onPatch).not.toHaveBeenCalled();
    select.value = "1";
    select.dispatchEvent(new Event("change"));
    expect(onPatch).toHaveBeenLastCalledWith(["cron", "enabled"], false);
    select.value = "0";
    select.dispatchEvent(new Event("change"));
    expect(onPatch).toHaveBeenLastCalledWith(["cron", "enabled"], true);
    select.value = "__unset__";
    select.dispatchEvent(new Event("change"));
    expect(onPatch).toHaveBeenLastCalledWith(["cron", "enabled"], undefined);
  });

  it.each([
    { key: "slack", additionalProperties: { type: "string" }, value: { channelA: "ok" } },
    { key: "accounts", additionalProperties: true, value: { default: { enabled: true } } },
  ])("removes entries from the $key map", ({ key, additionalProperties, value }) => {
    const analysis = analyzeProperties({ [key]: { type: "object", additionalProperties } });
    expect(analysis.unsupportedPaths).toEqual([]);
    renderForm(analysis, { value: { [key]: value } });
    query(container, ".cfg-map button[aria-label='Remove entry']").dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    expect(onPatch).toHaveBeenCalledWith([key], {});
  });

  it("filters by authored metadata tags without rendering field chips", () => {
    const analysis = rootAnalysis;
    renderForm(analysis, {
      uiHints: {
        "gateway.auth.token": { tags: ["security", "advanced", "secret"] },
      },
      value: {},
    });

    expect(container.querySelector(".cfg-tag")).toBeNull();

    renderForm(analysis, {
      uiHints: {
        "gateway.auth.token": { tags: ["security", "advanced"] },
      },
      value: {},
      searchQuery: "tag:advanced",
    });

    const sectionTitle = query(container, ".settings-section__heading");
    expect(sectionTitle.textContent?.trim()).toBe("Gateway");
    const fieldLabel = byText<HTMLElement>(container, ".settings-row__title", "Token");
    expect(fieldLabel.textContent?.trim()).toBe("Token");
    // Only the Auth subtree (matching the tag filter) renders rows.
    expect(
      Array.from(container.querySelectorAll(".settings-row__title")).map((label) =>
        label.textContent?.trim(),
      ),
    ).toEqual(["Auth", "Token"]);
  });

  it("supports SecretInput unions in additionalProperties maps", () => {
    const schema = object({
      models: object({
        providers: {
          type: "object",
          additionalProperties: object({
            apiKey: anyOf(
              { type: "string" },
              oneOf(
                ...["env", "file"].map((source) =>
                  object(
                    {
                      source: { type: "string", const: source },
                      provider: { type: "string" },
                      id: { type: "string" },
                    },
                    { required: ["source", "provider", "id"], additionalProperties: false },
                  ),
                ),
              ),
            ),
          }),
        },
      }),
    });
    const analysis = analyzeConfigSchema(schema);
    expect(analysis.unsupportedPaths).toEqual([]);

    renderForm(analysis, {
      uiHints: {
        "models.providers.*.apiKey": { sensitive: true },
      },
      value: { models: { providers: { openai: { apiKey: "old" } } } }, // pragma: allowlist secret
      revealSensitive: true,
    });

    const apiKeyInput = expectElement(
      Array.from(
        container.querySelectorAll<HTMLInputElement>(
          "#config-section-models .cfg-map input.settings-input[type='text']",
        ),
      ).find((input) => input.value === "old"),
      "provider api key input",
    );
    edit(apiKeyInput, "new-key");
    expect(onPatch).toHaveBeenCalledWith(["models", "providers", "openai", "apiKey"], "new-key");
  });

  it.each([
    {
      properties: { mixed: anyOf({ type: "string" }, object({})) },
      unsupported: [],
    },
    {
      properties: {
        lastTouchedAt: {
          title: "Config Last Touched At",
          description: "ISO timestamp of the last config write.",
          anyOf: [{ type: "string" }, {}],
        },
      },
      unsupported: ["lastTouchedAt"],
    },
    {
      properties: { note: anyOf({ type: "string", nullable: true }) },
      unsupported: [],
      nullable: true,
    },
    { properties: { note: { type: ["string", "null"] } }, unsupported: [] },
    {
      properties: {
        channels: object(
          {
            whatsapp: object({ enabled: { type: "boolean" } }),
          },
          { additionalProperties: {} },
        ),
      },
      unsupported: [],
    },
    {
      properties: {
        lastTouchedAt: anyOf({ type: "string" }, { type: "number" }),
        setupCommand: anyOf({ type: "string" }, array({ type: "string" })),
        allowedDomains: array({ type: "string" }),
        displayWidth: { type: "string" },
      },
      unsupported: [],
      value: {
        lastTouchedAt: "2026-05-05T00:00:00.000Z",
        setupCommand: "apt-get update",
        allowedDomains: ["example.com"],
        displayWidth: "960px",
      },
    },
  ])(
    "analyzes public union shapes: $properties",
    ({ properties, unsupported, nullable, value }) => {
      const analysis = analyzeProperties(properties);
      expect(analysis.unsupportedPaths).toEqual(unsupported);
      if (nullable) {
        expect(analysis.schema?.properties?.note?.nullable).toBe(true);
      }
      if (value) {
        renderForm(analysis, { value });
        expect(container.textContent).not.toContain("Unsupported schema node");
      }
    },
  );

  it.each([
    {
      key: "allowFrom",
      items: { type: "string" },
      defaults: ["+15550000000"],
      value: ["+15550001111", "+15550002222"],
      help: "Sender ids allowed to reach the agent.",
    },
    {
      key: "groups",
      items: array({ type: "string" }, { default: ["nested-default"] }),
      defaults: [["root-default"]],
      value: [["first"], ["second"]],
      help: "Group sender ids.",
    },
  ])("renders $key metadata only on the array header", ({ key, items, defaults, value, help }) => {
    const analysis = analyzeProperties({ [key]: array(items, { default: defaults }) });
    renderForm(analysis, { uiHints: { [key]: { help } }, value: { [key]: value } });
    const descriptions = Array.from(container.querySelectorAll(".settings-row__desc"), (node) =>
      node.textContent?.trim(),
    );
    expect(descriptions.filter((text) => text === help)).toHaveLength(1);
    expect(
      descriptions.filter((text) => text === `Default: ${JSON.stringify(defaults)}`),
    ).toHaveLength(1);
    expect(descriptions.some((text) => text?.includes("nested-default"))).toBe(false);
  });

  it.each([true, false])("renders section help only with a docs URL: %s", async (hasDocs) => {
    renderForm(rootAnalysis, {
      uiHints: hasDocs
        ? { gateway: { docsUrl: "https://docs.openclaw.ai/gateway/configuration" } }
        : {},
      value: {},
      activeSection: "gateway",
    });

    if (!hasDocs) {
      expect(container.querySelector(".settings-section__help-button")).toBeNull();
      return;
    }
    const button = query<HTMLButtonElement>(container, ".settings-section__help-button");
    expect(button.getAttribute("aria-label")).toBe("Help for Gateway");
    expect(button.querySelector("svg")).not.toBeNull();
    const tooltip = expectElement(button.closest("openclaw-tooltip"), "section help tooltip");
    expect((tooltip as HTMLElement & { content: string }).content).toBe("Help for Gateway");
    const link = query<HTMLAnchorElement>(container, ".settings-section__help-popover a");
    expect(link.textContent?.trim()).toBe("Learn more");
    expect(link.classList.contains("learn-more-link")).toBe(true);
    const popover = expectElement(link.closest('[role="dialog"]'), "section help popover");
    expect(button.getAttribute("aria-controls")).toBe(popover.id);
    expect(popover.getAttribute("aria-label")).toBe("Help for Gateway");
    expect(link.getAttribute("href")).toBe("https://docs.openclaw.ai/gateway/configuration");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");

    const { userEvent } = await import("vitest/browser");
    button.focus();
    await userEvent.keyboard("{Enter}");
    expect(popover.matches(":popover-open")).toBe(true);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const hidden = new Promise<void>((resolve) => {
      popover.addEventListener("overlay-after-hide", () => resolve(), { once: true });
    });
    await userEvent.keyboard("{Escape}");
    await hidden;
    expect(popover.matches(":popover-open")).toBe(false);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(button);
  });
});
