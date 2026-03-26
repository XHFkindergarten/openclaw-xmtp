import type { ChannelPlugin } from "openclaw/plugin-sdk";

import {
  DEFAULT_STATE_DIR,
  DEFAULT_XMTP_ENV,
  XMTP_ACCOUNT_ID,
  XMTP_CHANNEL_ID,
  resolveXMTPChannelConfig,
} from "./config.js";
import { monitorXMTPProvider } from "./monitor.js";
import { getOrCreateXMTPService, inspectXMTPState } from "./service.js";

type ResolvedXMTPAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  stateDir: string;
  env: string;
  missing: string[];
};

function resolveAccount(cfg: Record<string, any> | undefined): ResolvedXMTPAccount {
  const channelCfg = resolveXMTPChannelConfig(cfg);
  const inspected = inspectXMTPState(channelCfg);
  return {
    accountId: XMTP_ACCOUNT_ID,
    enabled: true,
    configured: inspected.configured,
    stateDir: channelCfg.stateDir,
    env: channelCfg.env,
    missing: inspected.missing,
  };
}

export const xmtpPlugin: ChannelPlugin<ResolvedXMTPAccount> = {
  id: XMTP_CHANNEL_ID,
  meta: {
    id: XMTP_CHANNEL_ID,
    label: XMTP_CHANNEL_ID,
    selectionLabel: `${XMTP_CHANNEL_ID} (embedded sdk)`,
    docsPath: `/channels/${XMTP_CHANNEL_ID}`,
    docsLabel: XMTP_CHANNEL_ID,
    blurb: "Run XMTP directly inside the OpenClaw gateway lifecycle and dispatch inbound messages into OpenClaw.",
    order: 85,
  },
  configSchema: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  capabilities: {
    chatTypes: ["direct"],
    media: false,
  },
  messaging: {
    targetResolver: {
      looksLikeId: (raw: string) =>
        /^0x[a-fA-F0-9]{40}$/.test(raw) || /^[a-fA-F0-9]{64}$/.test(raw),
    },
  },
  reload: { configPrefixes: [`channels.${XMTP_CHANNEL_ID}`] },
  config: {
    listAccountIds: () => [XMTP_ACCOUNT_ID],
    resolveAccount: (cfg: Record<string, any>) => resolveAccount(cfg),
    isConfigured: (cfg: Record<string, any>) => resolveAccount(cfg).configured,
    describeAccount: (account: ResolvedXMTPAccount) => ({
      accountId: account.accountId,
      name: "Embedded XMTP Agent",
      enabled: account.enabled,
      configured: account.configured,
    }),
  },
  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 4000,
    sendText: async (ctx: { cfg: Record<string, any>; to: string; text: string }) => {
      const account = resolveAccount(ctx.cfg);
      const service = getOrCreateXMTPService({
        accountId: account.accountId,
        config: { stateDir: account.stateDir, env: account.env },
      });
      const result = await service.sendText(ctx.to, ctx.text);
      return { channel: XMTP_CHANNEL_ID, messageId: result.conversationId ?? `${Date.now()}` };
    },
  },
  status: {
    defaultRuntime: {
      accountId: XMTP_ACCOUNT_ID,
      lastError: null,
      lastInboundAt: null,
      lastOutboundAt: null,
      running: false,
      address: null,
      chatUrl: null,
    },
    collectStatusIssues: ({ account }: { account?: ResolvedXMTPAccount }) => {
      if (!account || account.configured) {
        return [];
      }
      return [
        {
          level: "error",
          message: `missing XMTP runtime state: ${account.missing.join(", ")}`,
        },
      ];
    },
    buildChannelSummary: ({ snapshot }: { snapshot: Record<string, any> }) => ({
      configured: snapshot.configured ?? true,
      running: snapshot.running ?? false,
      lastError: snapshot.lastError ?? null,
      lastInboundAt: snapshot.lastInboundAt ?? null,
      lastOutboundAt: snapshot.lastOutboundAt ?? null,
      address: snapshot.address ?? null,
      chatUrl: snapshot.chatUrl ?? null,
    }),
    buildAccountSnapshot: ({
      account,
      runtime,
    }: {
      account: ResolvedXMTPAccount;
      runtime: Record<string, any>;
    }) => ({
      ...runtime,
      accountId: account.accountId,
      name: "Embedded XMTP Agent",
      enabled: account.enabled,
      configured: account.configured,
      stateDir: account.stateDir,
      xmtpEnv: account.env,
    }),
  },
  gateway: {
    startAccount: async (ctx: {
      cfg: Record<string, any>;
      runtime?: { log?: (msg: string) => void; error?: (msg: string) => void };
      log?: { info?: (msg: string) => void; error?: (msg: string) => void };
      abortSignal?: AbortSignal;
      setStatus?: (next: Record<string, any>) => void;
    }) => {
      const account = resolveAccount(ctx.cfg);
      ctx.setStatus?.({
        accountId: account.accountId,
        running: false,
        lastStartAt: Date.now(),
        lastEventAt: Date.now(),
        configured: account.configured,
        stateDir: account.stateDir,
        xmtpEnv: account.env,
      });

      if (!account.configured) {
        ctx.setStatus?.({
          accountId: account.accountId,
          running: false,
          configured: false,
          lastError: `missing XMTP runtime state: ${account.missing.join(", ")}`,
        });
        throw new Error(
          `XMTP is not initialized in ${account.stateDir}; run 'XMTP_BASE_DIR=${account.stateDir} npx tsx src/cli.ts init' first`,
        );
      }

      ctx.log?.info?.(
        `[xmtp] starting embedded sdk (${account.env}, stateDir=${account.stateDir})`,
      );
      return monitorXMTPProvider({
        accountId: account.accountId,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        setStatus: ctx.setStatus,
      });
    },
  },
};

export const xmtpChannelDefaults = {
  stateDir: DEFAULT_STATE_DIR,
  env: DEFAULT_XMTP_ENV,
};
