import type { ChannelAccountSnapshot, PluginRuntime } from "openclaw/plugin-sdk";

import { resolveXMTPChannelConfig, XMTP_CHANNEL_ID } from "./config.js";
import { buildXMTPMessageKey, xmtpMessageToMsgContext, type XMTPInboundMessage } from "./inbound.js";
import { buildXMTPKnowledgeSystemPrompt, XMTP_ROUTING_DM_SCOPE } from "./prompt.js";
import { waitForXMTPRuntime } from "./runtime.js";
import { getOrCreateXMTPService, releaseXMTPService, type XMTPServiceConfig } from "./service.js";
import {
  loadCursorState,
  saveCursorState,
  shouldProcessMessage,
  updateCursorState,
} from "./state.js";

export type MonitorXMTPProviderOpts = {
  accountId: string;
  config: Record<string, any>;
  runtime?: { log?: (msg: string) => void; error?: (msg: string) => void };
  abortSignal?: AbortSignal;
  setStatus?: (next: ChannelAccountSnapshot) => void;
};

export async function monitorXMTPProvider(opts: MonitorXMTPProviderOpts): Promise<void> {
  const channelRuntime = (await waitForXMTPRuntime()).channel as PluginRuntime["channel"];
  const channelCfg = resolveXMTPChannelConfig(opts.config);
  const log = opts.runtime?.log ?? (() => {});
  const errLog = opts.runtime?.error ?? ((message: string) => log(message));
  let cursor = loadCursorState(channelCfg.stateDir, opts.accountId);

  const service = getOrCreateXMTPService({
    accountId: opts.accountId,
    config: channelCfg,
    log,
    errLog,
  });
  const status = service.getStatus();
  opts.setStatus?.({
    accountId: opts.accountId,
    running: true,
    lastStartAt: Date.now(),
    lastEventAt: Date.now(),
    address: status.address ?? null,
    chatUrl: status.chatUrl ?? null,
    stateDir: channelCfg.stateDir,
    xmtpEnv: channelCfg.env,
  });

  log(`[xmtp] monitor started (embedded sdk, account=${opts.accountId}, env=${channelCfg.env})`);

  try {
    await service.start({
      abortSignal: opts.abortSignal,
      onMessage: async (message) => {
        const key = buildXMTPMessageKey(message);
        if (!shouldProcessMessage(cursor, key, message.timestamp)) {
          log(
            `[xmtp] skipping message conv=${message.conversationId} from=${message.from} ts=${message.timestamp} reason=cursor`,
          );
          return;
        }

        await processOneXMTPMessage(message, {
          accountId: opts.accountId,
          config: opts.config,
          channelRuntime,
          serviceConfig: channelCfg,
          log,
          errLog,
        });

        cursor = updateCursorState(cursor, key, message.timestamp);
        saveCursorState(channelCfg.stateDir, opts.accountId, cursor);

        const now = Date.now();
        const nextStatus = service.getStatus();
        opts.setStatus?.({
          accountId: opts.accountId,
          running: true,
          lastEventAt: now,
          lastInboundAt: now,
          address: nextStatus.address ?? null,
          chatUrl: nextStatus.chatUrl ?? null,
          stateDir: channelCfg.stateDir,
          xmtpEnv: channelCfg.env,
        });
      },
    });
  } finally {
    releaseXMTPService(opts.accountId, channelCfg);
  }
}

async function processOneXMTPMessage(
  message: XMTPInboundMessage,
  deps: {
    accountId: string;
    config: Record<string, any>;
    channelRuntime: PluginRuntime["channel"];
    serviceConfig: XMTPServiceConfig;
    log: (msg: string) => void;
    errLog: (msg: string) => void;
  },
): Promise<void> {
  const ctx = xmtpMessageToMsgContext(message, deps.accountId);
  ctx.GroupSystemPrompt = buildXMTPKnowledgeSystemPrompt(deps.serviceConfig);
  deps.log(
    `[xmtp] inbound conv=${message.conversationId} from=${message.from} ts=${message.timestamp} body=${previewText(message.content)}`,
  );
  deps.log(
    `[xmtp] prompt conv=${message.conversationId} promptChars=${ctx.GroupSystemPrompt.length}`,
  );

  const route = deps.channelRuntime.routing.resolveAgentRoute({
    cfg: {
      ...deps.config,
      session: {
        ...deps.config.session,
        dmScope: XMTP_ROUTING_DM_SCOPE,
      },
    },
    channel: XMTP_CHANNEL_ID,
    accountId: deps.accountId,
    peer: { kind: "direct", id: ctx.To },
  });
  deps.log(
    `[xmtp] route conv=${message.conversationId} agent=${route.agentId ?? "(none)"} session=${route.sessionKey ?? "(none)"} main=${route.mainSessionKey ?? "(none)"}`,
  );
  ctx.SessionKey = route.sessionKey;

  const storePath = deps.channelRuntime.session.resolveStorePath(deps.config.session?.store, {
    agentId: route.agentId,
  });
  const finalized = deps.channelRuntime.reply.finalizeInboundContext(
    ctx as Parameters<typeof deps.channelRuntime.reply.finalizeInboundContext>[0],
  );

  await deps.channelRuntime.session.recordInboundSession({
    storePath,
    sessionKey: route.sessionKey,
    ctx: finalized as Parameters<typeof deps.channelRuntime.session.recordInboundSession>[0]["ctx"],
    updateLastRoute: {
      sessionKey: route.mainSessionKey,
      channel: XMTP_CHANNEL_ID,
      to: ctx.To,
      accountId: deps.accountId,
    },
    onRecordError: (err: unknown) => deps.errLog(`[xmtp] recordInboundSession: ${String(err)}`),
  });
  deps.log(
    `[xmtp] recorded conv=${message.conversationId} store=${storePath} session=${route.sessionKey ?? "(none)"}`,
  );

  const { dispatcher, replyOptions, markDispatchIdle } =
    deps.channelRuntime.reply.createReplyDispatcherWithTyping({
      humanDelay: deps.channelRuntime.reply.resolveHumanDelayConfig(deps.config, route.agentId),
      typingCallbacks: {
        start: async () => {},
        stop: async () => {},
        onStartError: () => {},
        onStopError: () => {},
      },
      deliver: async (payload: { text?: string }) => {
        const text = (payload.text ?? "").trim();
        if (!text) {
          deps.log(`[xmtp] deliver skipped conv=${message.conversationId} reason=empty-text`);
          return;
        }

        deps.log(
          `[xmtp] deliver start conv=${message.conversationId} to=${ctx.To} text=${previewText(text)}`,
        );
        const service = getOrCreateXMTPService({
          accountId: deps.accountId,
          config: deps.serviceConfig,
          log: deps.log,
          errLog: deps.errLog,
        });
        await service.sendText(ctx.To, text);
        deps.log(`[xmtp] deliver ok conv=${message.conversationId} to=${ctx.To}`);
      },
      onError: (err: unknown, info: { kind: string }) => {
        deps.errLog(`[xmtp] reply ${info.kind}: ${String(err)}`);
      },
    });

  try {
    deps.log(`[xmtp] dispatch start conv=${message.conversationId}`);
    await deps.channelRuntime.reply.withReplyDispatcher({
      dispatcher,
      run: () =>
        deps.channelRuntime.reply.dispatchReplyFromConfig({
          ctx: finalized,
          cfg: deps.config,
          dispatcher,
          replyOptions,
        }),
    });
    deps.log(`[xmtp] dispatch ok conv=${message.conversationId}`);
  } catch (err) {
    deps.errLog(`[xmtp] dispatch failed conv=${message.conversationId}: ${String(err)}`);
    throw err;
  } finally {
    markDispatchIdle();
  }
}

function previewText(text: string, limit = 80): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) {
    return JSON.stringify(normalized);
  }
  return JSON.stringify(`${normalized.slice(0, limit)}...`);
}
