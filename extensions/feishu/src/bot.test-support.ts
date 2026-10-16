import type {
  ensureConfiguredBindingRouteReady,
  getSessionBindingService,
  resolveConfiguredBindingRoute,
} from "openclaw/plugin-sdk/conversation-runtime";
import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import type { ClawdbotConfig } from "../runtime-api.js";
import type { FeishuMessageEvent } from "./bot.js";

type FeishuConfig = NonNullable<NonNullable<ClawdbotConfig["channels"]>["feishu"]>;
type FeishuMessage = FeishuMessageEvent["message"];
type FeishuSender = FeishuMessageEvent["sender"];
type TestConfigBase = Record<string, unknown> & {
  channels?: Record<string, unknown>;
};
type FeishuSecretRefPolicyCase = {
  name: string;
  provider: string;
  defaultEnv?: string;
  providers: NonNullable<NonNullable<ClawdbotConfig["secrets"]>["providers"]>;
  configured: boolean;
};

export const FEISHU_SELECTED_SECRET_ENV = "FEISHU_SECRET_REF_SELECTED_TEST";
export const FEISHU_SIBLING_SECRET_ENV = "FEISHU_SECRET_REF_SIBLING_TEST";

export const feishuSecretRefPolicyCases: FeishuSecretRefPolicyCase[] = [
  {
    name: "unconfigured provider alias",
    provider: "unconfigured",
    providers: {},
    configured: false,
  },
  {
    name: "provider configured with a non-env source",
    provider: "corp-env",
    providers: { "corp-env": { source: "file", path: "/unused" } },
    configured: false,
  },
  {
    name: "provider allowlist excluding the selected credential",
    provider: "corp-env",
    defaultEnv: "corp-env",
    providers: { "corp-env": { source: "env", allowlist: [FEISHU_SIBLING_SECRET_ENV] } },
    configured: false,
  },
  {
    name: "configured env provider allowing the selected credential",
    provider: "corp-env",
    defaultEnv: "corp-env",
    providers: { "corp-env": { source: "env", allowlist: [FEISHU_SELECTED_SECRET_ENV] } },
    configured: true,
  },
  {
    name: "selected env default shadowing an exec provider",
    provider: "corp-env",
    defaultEnv: "corp-env",
    providers: { "corp-env": { source: "exec", command: "/unused" } },
    configured: true,
  },
];

export function createFeishuTestConfig(
  feishu: FeishuConfig,
  base: TestConfigBase = {},
): ClawdbotConfig {
  return { ...base, channels: { ...base.channels, feishu } } as ClawdbotConfig;
}

export function createFeishuSecretRefPolicyConfig({
  provider,
  providers,
  defaultEnv,
}: FeishuSecretRefPolicyCase): ClawdbotConfig {
  return createFeishuTestConfig(
    {
      accounts: {
        selected: {
          appId: "selected-app",
          appSecret: { source: "env", provider, id: FEISHU_SELECTED_SECRET_ENV },
        },
        sibling: {
          appId: "sibling-app",
          appSecret: { source: "env", provider: "sibling-env", id: FEISHU_SIBLING_SECRET_ENV },
        },
      },
    },
    {
      secrets: {
        defaults: defaultEnv ? { env: defaultEnv } : undefined,
        providers: {
          ...providers,
          "sibling-env": { source: "env", allowlist: [FEISHU_SIBLING_SECRET_ENV] },
        },
      },
    },
  );
}

export function createFeishuTestEvent(params: {
  messageId: string;
  sender?: FeishuSender;
  senderOpenId?: string;
  senderUserId?: string;
  senderType?: FeishuSender["sender_type"];
  chatId?: string;
  chatType?: FeishuMessage["chat_type"];
  messageType?: FeishuMessage["message_type"];
  text?: string;
  content?: string;
  message?: Partial<FeishuMessage>;
}): FeishuMessageEvent {
  return {
    sender: params.sender ?? {
      sender_id: {
        open_id: params.senderOpenId ?? "ou-attacker",
        ...(params.senderUserId ? { user_id: params.senderUserId } : {}),
      },
      ...(params.senderType ? { sender_type: params.senderType } : {}),
    },
    message: {
      message_id: params.messageId,
      chat_id: params.chatId ?? "oc-dm",
      chat_type: params.chatType ?? "p2p",
      message_type: params.messageType ?? "text",
      ...params.message,
      content:
        params.content ??
        params.message?.content ??
        JSON.stringify({ text: params.text ?? "hello" }),
    },
  };
}

export function createFeishuTestRoute(
  overrides: Partial<ResolvedAgentRoute> = {},
): ResolvedAgentRoute {
  return {
    agentId: "main",
    channel: "feishu",
    accountId: "default",
    sessionKey: "agent:main:feishu:dm:ou-attacker",
    mainSessionKey: "agent:main:main",
    lastRoutePolicy: "session",
    matchedBy: "default",
    ...overrides,
  };
}

type ConfiguredBindingRoute = ReturnType<typeof resolveConfiguredBindingRoute>;
type BoundConversation = ReturnType<
  ReturnType<typeof getSessionBindingService>["resolveByConversation"]
>;
type BindingReadiness = Awaited<ReturnType<typeof ensureConfiguredBindingRouteReady>>;

export function createConfiguredFeishuRoute(): NonNullable<ConfiguredBindingRoute> {
  type Resolution = NonNullable<ConfiguredBindingRoute["bindingResolution"]>;
  const conversationId = "ou_sender_1";
  const sessionKey = "agent:codex:acp:binding:feishu:default:abc123";
  const conversation = () => ({ channel: "feishu", accountId: "default", conversationId });
  const target = () => ({ conversationId });
  const record = (): Resolution["record"] => ({
    bindingId: "config:acp:feishu:default:ou_sender_1",
    targetSessionKey: sessionKey,
    targetKind: "session",
    conversation: conversation(),
    status: "active",
    boundAt: 0,
    metadata: { source: "config" },
  });
  const statefulTarget = (): Resolution["statefulTarget"] => ({
    kind: "stateful",
    driverId: "acp",
    sessionKey,
    agentId: "codex",
  });
  const materialize = () => ({ record: record(), statefulTarget: statefulTarget() });
  return {
    bindingResolution: {
      conversation: conversation(),
      compiledBinding: {
        channel: "feishu",
        accountPattern: "default",
        binding: {
          type: "acp",
          agentId: "codex",
          match: {
            channel: "feishu",
            accountId: "default",
            peer: { kind: "direct", id: conversationId },
          },
        },
        bindingConversationId: conversationId,
        target: target(),
        agentId: "codex",
        provider: {
          compileConfiguredBinding: target,
          matchInboundConversation: target,
        },
        targetFactory: { driverId: "acp", materialize },
      },
      match: target(),
      ...materialize(),
    },
    route: createFeishuTestRoute({
      agentId: "codex",
      sessionKey,
      mainSessionKey: "agent:codex:main",
      matchedBy: "binding.channel",
    }),
  };
}

export function createConfiguredBindingReadiness(ok: boolean, error?: string): BindingReadiness {
  return (ok ? { ok: true } : { ok: false, error: error ?? "unknown error" }) as BindingReadiness;
}

export function createBoundConversation(): NonNullable<BoundConversation> {
  return {
    bindingId: "default:oc_group_chat:topic:om_topic_root",
    targetSessionKey: "agent:codex:acp:binding:feishu:default:feedface",
    targetKind: "session",
    conversation: {
      channel: "feishu",
      accountId: "default",
      conversationId: "oc_group_chat:topic:om_topic_root",
      parentConversationId: "oc_group_chat",
    },
    status: "active",
    boundAt: 0,
  };
}
