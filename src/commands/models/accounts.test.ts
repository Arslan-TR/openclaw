import { once } from "node:events";
import type { IncomingHttpHeaders } from "node:http";
import { CANCEL_SYMBOL } from "@clack/prompts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import type {
  UsersAuthConnectCatalogResult,
  UsersAuthConnectStartResult,
  UsersAuthConnectStatusResult,
  UsersListModelAccountsResult,
  UsersSelfResult,
} from "../../../packages/gateway-protocol/src/schema/users.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  buildMinimalGatewayHelloOkPayload,
  closeMinimalGatewayServer,
  parseMinimalGatewayRequestFrame,
  sendMinimalGatewayConnectChallenge,
  sendMinimalGatewayResponse,
} from "../../gateway/minimal-gateway.test-helpers.js";
import { ExitError } from "../../runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { DEVICE_CODE_PHISHING_WARNING } from "../../wizard/prompts.js";
import { sanitizeWizardStepForClient, WizardSession } from "../../wizard/session.js";
import {
  modelsAccountsUpdateDefaultCommand,
  modelsAccountsLoginCommand,
  modelsAccountsListCommand,
} from "./accounts.js";

const mocks = vi.hoisted(() => ({
  password: vi.fn<typeof import("@clack/prompts").password>(),
  autocomplete: vi.fn<typeof import("@clack/prompts").autocomplete>(),
  openUrl: vi.fn(async () => false),
}));
vi.mock("@clack/prompts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@clack/prompts")>()),
  password: mocks.password,
  autocomplete: mocks.autocomplete,
}));
vi.mock("../../infra/browser-open.js", () => ({ openUrl: mocks.openUrl }));

const PROFILE_ID = "person-test";
const ACCOUNT_ID = "personal-account-first";
const connected = {
  status: "connected",
  authProfileId: ACCOUNT_ID,
  links: [{ provider: "openai", authProfileId: ACCOUNT_ID, updatedAt: 1 }],
} satisfies UsersAuthConnectStatusResult;
const catalog = {
  providers: [
    { id: "openai", label: "OpenAI", methods: [{ id: "oauth", label: "Browser sign-in" }] },
  ],
} satisfies UsersAuthConnectCatalogResult;
const inputStep = {
  id: "redirect-input",
  type: "text",
  message: "Final redirect URL",
  sensitive: true,
  externalUrl: "https://auth.example/authorize?state=synthetic-state",
} as const;
const self = {
  profile: {
    id: PROFILE_ID,
    displayName: "Test Person",
    avatarMime: null,
    mergedInto: null,
    createdAt: 1,
    updatedAt: 1,
    emails: [],
    githubIdentity: null,
    hasAvatar: false,
  },
} satisfies UsersSelfResult;

type Request = {
  method: string;
  params: Record<string, unknown>;
  socket: WebSocket;
};

function expectRequests(requests: Request[], expected: Array<[string, Record<string, unknown>]>) {
  expect(requests.map(({ method, params }) => [method, params])).toEqual(expected);
}

function printed() {
  return JSON.stringify([
    output.log.mock.calls,
    output.error.mock.calls,
    output.writeJson.mock.calls,
  ]);
}

const connectParams = { profileId: PROFILE_ID, connectId: "operation-one" };
let output: ReturnType<typeof runtime>;

function login(
  port: string,
  options: Partial<Parameters<typeof modelsAccountsLoginCommand>[0]> = {},
) {
  return modelsAccountsLoginCommand({ port, provider: "openai", ...options }, output);
}

function expectNoPrompt() {
  expect(mocks.password).not.toHaveBeenCalled();
  expect(mocks.openUrl).not.toHaveBeenCalled();
}

async function withGateway(
  respond: (request: Request) => unknown,
  run: (gateway: {
    port: string;
    url: string;
    requests: Request[];
    connections: Request[];
    upgradeHeaders: IncomingHttpHeaders[];
  }) => Promise<void>,
  options: { config?: OpenClawConfig; env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  await withOpenClawTestState(
    { label: "personal-account-cli", scenario: "minimal", env: options.env },
    async (state) => {
      const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
      const requests: Request[] = [];
      const connections: Request[] = [];
      const upgradeHeaders: IncomingHttpHeaders[] = [];
      server.on("connection", (socket, upgrade) => {
        upgradeHeaders.push(upgrade.headers);
        sendMinimalGatewayConnectChallenge(socket);
        socket.on("message", (data) => {
          const frame = parseMinimalGatewayRequestFrame(data);
          if (!frame.id || !frame.method) {
            return;
          }
          const id = frame.id;
          const request = { method: frame.method, params: frame.params ?? {}, socket };
          if (frame.method === "connect") {
            connections.push(request);
            sendMinimalGatewayResponse(socket, id, buildMinimalGatewayHelloOkPayload());
            return;
          }
          requests.push(request);
          const reply = (body: object) => {
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ type: "res", id, ...body }));
            }
          };
          void Promise.resolve()
            .then(() => respond(request))
            .then(
              (payload) =>
                reply({
                  ok: true,
                  payload:
                    payload ??
                    (request.method === "users.self"
                      ? self
                      : request.method === "users.authConnect.catalog"
                        ? catalog
                        : {}),
                }),
              () =>
                reply({
                  ok: false,
                  error: { code: "FORBIDDEN", message: "Requires an authenticated user" },
                }),
            );
        });
      });
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected an ephemeral Gateway port.");
      }
      await state.writeConfig(
        options.config ?? {
          gateway: { mode: "local", port: address.port, auth: { mode: "none" } },
        },
      );
      try {
        await run({
          port: String(address.port),
          url: `ws://127.0.0.1:${address.port}`,
          requests,
          connections,
          upgradeHeaders,
        });
        expect(connections).toHaveLength(1);
        expect(new Set(requests.map(({ socket }) => socket)).size).toBe(1);
      } finally {
        await closeMinimalGatewayServer(server);
      }
    },
  );
}

function withLoginGateway(
  handlers: Record<string, (request: Request) => unknown>,
  run: Parameters<typeof withGateway>[1],
) {
  const routes: Record<string, (request: Request) => unknown> = {
    "users.authConnect.start": startResult,
  };
  for (const [operation, handler] of Object.entries(handlers)) {
    routes[`users.authConnect.${operation}`] = handler;
  }
  return withGateway((request) => routes[request.method]?.(request), run);
}

function runtime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    writeStdout: vi.fn(),
    writeJson: vi.fn(),
    exit: (code: number) => {
      throw new ExitError(code);
    },
  };
}

function expectJsonOutput(payload: unknown): void {
  expect(output.writeJson.mock.calls.map(([value]) => value)).toEqual([payload]);
}

function expectPersonalContext(url: string): void {
  const diagnostics = output.error.mock.calls.map(([line]) => String(line)).join("\n");
  expect(diagnostics).toContain("Scope: Personal");
  expect(diagnostics).toContain(`Gateway: ${url}`);
  expect(diagnostics).toContain(`Person: ${self.profile.displayName}`);
}

function startResult(): UsersAuthConnectStartResult {
  return {
    connectId: "operation-one",
    expiresAtMs: Date.now() + 60_000,
  };
}

function waitForPromptAbort(): void {
  mocks.password.mockImplementation(
    ({ signal }) =>
      new Promise((resolve) => {
        if (signal?.aborted) {
          resolve(CANCEL_SYMBOL);
        } else {
          signal?.addEventListener("abort", () => resolve(CANCEL_SYMBOL), { once: true });
        }
      }),
  );
}

const ttyDescriptors = [process.stdin, process.stderr].map(
  (stream) => [stream, Object.getOwnPropertyDescriptor(stream, "isTTY")] as const,
);
beforeEach(() => {
  output = runtime();
  for (const [stream] of ttyDescriptors) {
    Object.defineProperty(stream, "isTTY", { configurable: true, value: true });
  }
  mocks.password.mockReset();
  mocks.autocomplete.mockReset();
  mocks.openUrl.mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const [stream, descriptor] of ttyDescriptors) {
    if (descriptor) {
      Object.defineProperty(stream, "isTTY", descriptor);
    } else {
      Reflect.deleteProperty(stream, "isTTY");
    }
  }
});

it("prints one metadata page and its next cursor without fetching another page", async () => {
  const page: UsersListModelAccountsResult = {
    profileId: PROFILE_ID,
    accounts: [
      {
        authProfileId: ACCOUNT_ID,
        provider: "openai",
        label: "Work",
        authType: "oauth",
        selected: true,
      },
    ],
    nextCursor: ACCOUNT_ID,
    links: connected.links,
  };
  await withGateway(
    ({ method }) => (method === "users.listModelAccounts" ? page : undefined),
    async ({ port, url, requests, connections }) => {
      await modelsAccountsListCommand({ port, cursor: "previous-account", json: true }, output);
      expectRequests(requests, [
        ["users.self", {}],
        ["users.listModelAccounts", { cursor: "previous-account" }],
      ]);
      expectJsonOutput(page);
      expectPersonalContext(url);
      expect(output.log).not.toHaveBeenCalled();
      expect(connections[0]?.params).toMatchObject({
        device: { nonce: "test-nonce" },
        scopes: ["operator.read"],
      });
    },
  );
});

it("uses a credential-free explicit URL without leaking ambient, configured, or other-edge auth", async () => {
  const page = {
    profileId: PROFILE_ID,
    accounts: [],
    links: [],
  } satisfies UsersListModelAccountsResult;
  await withGateway(
    ({ method }) => (method === "users.listModelAccounts" ? page : undefined),
    async ({ url, requests, connections, upgradeHeaders }) => {
      await modelsAccountsListCommand({ url, json: true }, output);
      expect(requests.map(({ method }) => method)).toEqual([
        "users.self",
        "users.listModelAccounts",
      ]);
      expect(connections[0]?.params.auth).toBeUndefined();
      expect(upgradeHeaders[0]?.["x-edge-auth"]).toBeUndefined();
      expectPersonalContext(url);
      expectJsonOutput(page);
    },
    {
      env: {
        OPENCLAW_GATEWAY_TOKEN: "ambient-shared-token",
        OPENCLAW_GATEWAY_PASSWORD: "ambient-shared-password",
      },
      config: {
        gateway: {
          mode: "remote",
          auth: { mode: "token", token: "configured-local-token" },
          remote: {
            url: "wss://different-gateway.example/control",
            token: "configured-remote-token",
            password: "configured-remote-password",
            edgeAuth: { "X-Edge-Auth": "configured-other-edge-token" },
          },
        },
      },
    },
  );
});

it.each([
  {
    options: { action: "use" as const, authProfileId: ACCOUNT_ID },
    method: "users.selectModelAccount",
    params: { profileId: PROFILE_ID, authProfileId: ACCOUNT_ID },
    note: "Existing sessions keep",
  },
  {
    options: { action: "clear-default" as const, provider: "openai" },
    method: "users.unlinkAuthProfile",
    params: { profileId: PROFILE_ID, provider: "openai" },
    note: "Saved credentials and existing session accounts are unchanged",
  },
])(
  "binds $method to the authenticated person without changing sessions",
  async ({ options, method, params, note }) => {
    await withGateway(
      (request) => (request.method === method ? { links: connected.links } : undefined),
      async ({ port, url, requests }) => {
        await modelsAccountsUpdateDefaultCommand({ port, ...options }, output);
        expectRequests(requests, [
          ["users.self", {}],
          [method, params],
        ]);
        expectPersonalContext(url);
        expect(output.log).toHaveBeenCalledWith(expect.stringContaining(note));
      },
    );
  },
);

it("guides an unidentified person through login without prompting for provider credentials", async () => {
  await withGateway(
    () => {
      throw new Error("unidentified");
    },
    async ({ port, requests }) => {
      await expect(login(port)).rejects.toThrow("require a signed-in person");
      expect(requests.map((request) => request.method)).toEqual(["users.self"]);
      expectNoPrompt();
    },
  );
});

it("uses Gateway provider/method choices and sends a hidden API key only as the exact step answer", async () => {
  const apiKey = "synthetic-personal-api-key";
  const invalidKey = "synthetic-invalid-key";
  const validationError = "That answer is not valid. Check the sign-in instructions and try again.";
  const keyStep = { id: "api-key", type: "text", message: "API key", sensitive: true } as const;
  let answers = 0;
  const choices = {
    providers: [
      { id: "openai", label: "OpenAI", methods: [{ id: "oauth", label: "Browser" }] },
      {
        id: "xai",
        label: "Grok",
        methods: [
          { id: "api-key", label: "API key" },
          { id: "device-code", label: "Device code" },
        ],
      },
    ],
  } satisfies UsersAuthConnectCatalogResult;
  mocks.autocomplete.mockResolvedValueOnce("xai").mockResolvedValueOnce("api-key");
  await withLoginGateway(
    {
      catalog: () => choices,
      status: () => ({ status: "pending", step: keyStep }),
      answer: () =>
        ++answers === 1
          ? { status: "pending", step: keyStep, error: validationError }
          : { status: "connected", authProfileId: ACCOUNT_ID, links: [] },
    },
    async ({ port, url, requests }) => {
      mocks.password.mockImplementation(async () => {
        expectPersonalContext(url);
        return answers === 0 ? invalidKey : apiKey;
      });
      await modelsAccountsLoginCommand({ port, json: true }, output);
      expectRequests(requests, [
        ["users.self", {}],
        ["users.authConnect.catalog", { profileId: PROFILE_ID }],
        ["users.authConnect.start", { profileId: PROFILE_ID, provider: "xai", method: "api-key" }],
        ["users.authConnect.status", connectParams],
        ["users.authConnect.answer", { ...connectParams, stepId: "api-key", value: invalidKey }],
        ["users.authConnect.answer", { ...connectParams, stepId: "api-key", value: apiKey }],
      ]);
      expect(mocks.autocomplete.mock.calls).toMatchObject([
        [{ options: [{ value: "openai" }, { value: "xai" }] }],
        [{ options: [{ value: "api-key" }, { value: "device-code" }] }],
      ]);
      expect(mocks.password).toHaveBeenCalledTimes(2);
      expect(mocks.password).toHaveBeenCalledWith(
        expect.objectContaining({ output: process.stderr, signal: expect.any(AbortSignal) }),
      );
      expect(output.error).toHaveBeenCalledWith(validationError);
      expectJsonOutput({
        profileId: PROFILE_ID,
        provider: "xai",
        status: "connected",
        authProfileId: ACCOUNT_ID,
        links: [],
      });
      expect(printed()).not.toContain(apiKey);
      expect(printed()).not.toContain(invalidKey);
    },
  );
});

it("rejects an unavailable catalog selection before starting", async () => {
  await withGateway(
    () => undefined,
    async ({ port, requests }) => {
      await expect(login(port, { method: "missing" })).rejects.toThrow("Unknown sign-in method");
      expect(requests.map((request) => request.method)).toEqual([
        "users.self",
        "users.authConnect.catalog",
      ]);
      expectNoPrompt();
    },
  );
});

it("rejects non-TTY sign-in without consuming input", async () => {
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
  await expect(modelsAccountsLoginCommand({ provider: "openai" }, runtime())).rejects.toThrow(
    "requires an interactive terminal",
  );
  expectNoPrompt();
});

it("renders the latest device progress snapshot and opens each destination once without acknowledging the code", async () => {
  const redirectInput =
    "http://localhost:1455/auth/callback?code=synthetic-private-code&state=synthetic-state";
  mocks.password.mockResolvedValue(redirectInput);
  const verificationUrl = "https://auth.example/device";
  const code = "ABCD-1234";
  const progressUpdated = createDeferredCore();
  const continueToInput = createDeferredCore();
  const inputReady = createDeferredCore();
  const session = new WizardSession(async (prompter) => {
    const progress = prompter.progress("Starting provider sign-in");
    await prompter.openUrl?.(verificationUrl);
    await prompter.deviceCode?.({
      title: "Provider device sign-in",
      code,
      expiresInMinutes: 15,
      message: "Enter this one-time code on the provider's sign-in page.",
    });
    progress.update("Waiting for the initial provider poll");
    progress.update("Waiting for provider approval");
    progressUpdated.resolve();
    await continueToInput.promise;
    await prompter.openUrl?.(inputStep.externalUrl);
    const input = prompter.text({ message: inputStep.message, sensitive: true });
    inputReady.resolve();
    await input;
  });
  let polls = 0;
  let renderedProgress = "";
  let inputStepId: string | undefined;
  try {
    await withLoginGateway(
      {
        status: async () => {
          await progressUpdated.promise;
          polls += 1;
          if (polls === 3) {
            renderedProgress = output.error.mock.calls.map((args) => args.join(" ")).join("\n");
            continueToInput.resolve();
            await inputReady.promise;
          }
          const step = session.getCurrentStep();
          if (!step) {
            throw new Error("Expected the current WizardSession step.");
          }
          if (step.type === "text") {
            inputStepId = step.id;
          }
          return { status: "pending", step: sanitizeWizardStepForClient(step) };
        },
        answer: async ({ params }) => {
          if (typeof params.stepId !== "string") {
            throw new Error("Expected an exact wizard step ID.");
          }
          await session.answer(params.stepId, params.value);
          await session.whenSettled();
          return connected;
        },
      },
      async ({ port, requests }) => {
        await login(port, { json: true });
        expect(session.getStatus()).toBe("done");
        expect(inputStepId).toEqual(expect.any(String));
        expect(new Set(requests.map(({ socket }) => socket)).size).toBe(1);
        expect(
          requests
            .filter(({ method }) => method === "users.authConnect.answer")
            .map(({ params }) => params),
        ).toEqual([
          {
            ...connectParams,
            stepId: inputStepId,
            value: redirectInput,
          },
        ]);
        expect(mocks.openUrl.mock.calls).toEqual([[verificationUrl], [inputStep.externalUrl]]);
        expect(renderedProgress).toContain(verificationUrl);
        expect(renderedProgress).toContain(`Code: ${code}`);
        expect(renderedProgress).toContain("Code expires in 15 minutes.");
        expect(renderedProgress).toContain(
          "Enter this one-time code on the provider's sign-in page.",
        );
        expect(renderedProgress).toContain(DEVICE_CODE_PHISHING_WARNING);
        expect(renderedProgress).toContain("Waiting for provider approval");
        expect(renderedProgress).not.toContain("Waiting for the initial provider poll");
        expect(requests.some(({ method }) => method === "users.authConnect.cancel")).toBe(false);
        expectJsonOutput({
          profileId: PROFILE_ID,
          provider: "openai",
          ...connected,
        });
        expect(printed()).not.toContain("synthetic-private-code");
      },
    );
  } finally {
    session.cancel();
    continueToInput.resolve();
    await session.whenSettled();
  }
});

it("finishes from the authoritative failed status and closes the prompt", async () => {
  const result = { status: "failed", reason: "exchange" } satisfies UsersAuthConnectStatusResult;
  waitForPromptAbort();
  let polls = 0;
  await withLoginGateway(
    { status: () => (++polls === 1 ? { status: "pending", step: inputStep } : result) },
    async ({ port, requests }) => {
      const command = login(port, { json: true });
      await expect(command).rejects.toMatchObject({ code: 1 });
      expect(mocks.password.mock.calls[0]?.[0].signal?.aborted).toBe(true);
      expect(
        requests.some(
          ({ method }) =>
            method === "users.authConnect.answer" || method === "users.authConnect.cancel",
        ),
      ).toBe(false);
      expectJsonOutput({
        profileId: PROFILE_ID,
        provider: "openai",
        ...result,
      });
    },
  );
});

it("waits for exact cancellation acknowledgment before closing the initiating socket", async () => {
  mocks.password.mockResolvedValue(CANCEL_SYMBOL);
  const received = createDeferredCore<Request>();
  const acknowledged = createDeferredCore<UsersAuthConnectStatusResult>();
  await withLoginGateway(
    {
      status: () => ({ status: "pending", step: inputStep }),
      cancel: (request) => {
        received.resolve(request);
        return acknowledged.promise;
      },
    },
    async ({ port }) => {
      const command = expect(login(port)).rejects.toMatchObject({ code: 130 });
      const request = await received.promise;
      expect(request.params).toEqual(connectParams);
      expect(request.socket.readyState).toBe(WebSocket.OPEN);
      expect(output.log).not.toHaveBeenCalled();
      acknowledged.resolve({ status: "cancelled" });
      await command;
    },
  );
});

it("cancels a late start response after Ctrl-C instead of orphaning its operation id", async () => {
  const started = createDeferredCore();
  const response = createDeferredCore<UsersAuthConnectStartResult>();
  const onSignal = vi.spyOn(process, "once");
  await withLoginGateway(
    {
      start: () => {
        started.resolve();
        return response.promise;
      },
      cancel: () => ({ status: "cancelled" }),
    },
    async ({ port, requests }) => {
      const command = expect(login(port)).rejects.toMatchObject({ code: 130 });
      await started.promise;
      const interrupt = onSignal.mock.calls.find(([event]) => event === "SIGINT")?.[1];
      if (!interrupt) {
        throw new Error("Expected the command's signal handler.");
      }
      interrupt("SIGINT");
      response.resolve(startResult());
      await command;
      expect(requests.map(({ method }) => method)).toEqual([
        "users.self",
        "users.authConnect.catalog",
        "users.authConnect.start",
        "users.authConnect.cancel",
      ]);
      expect(requests.at(-1)?.params).toEqual(connectParams);
      expectNoPrompt();
    },
  );
});

it("stops on connection loss and never carries the operation to another socket", async () => {
  waitForPromptAbort();
  let polls = 0;
  await withLoginGateway(
    {
      status: ({ socket }) => {
        if (++polls === 1) {
          return { status: "pending", step: inputStep };
        }
        socket.close(1001, "gone");
        return undefined;
      },
    },
    async ({ port }) => {
      await expect(login(port)).rejects.toThrow("Could not confirm sign-in cancellation");
      expect(mocks.password.mock.calls[0]?.[0].signal?.aborted).toBe(true);
    },
  );
});
