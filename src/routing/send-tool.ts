/**
 * xmtp_send agent tool factory。
 *
 * 语义：main agent 在 main session 里调用 xmtp_send 向对手方发起一轮 A2A 通信，
 *   - main 分支：获取 tracker 席位 → 发送结构化消息 → 为本 (taskId, peerAddress)
 *     拉起 subagent（deliver=false），把后续谈判全权交给子会话。
 *   - sub 分支：subagent 自己调用 xmtp_send 继续对话，只刷新席位 + 发送，不再派生子会话。
 *
 * 参数：
 *   - content?: 人类可读文本（可选，envelope.text）
 *   - contentType?: 目前只支持 'text'
 *   - payload: 结构化业务数据（required）
 *       payload.peerAddress: 对手方 EVM 地址（必须，0x 开头）
 *       payload.taskId: 任务 ID（main 分支必须；sub 分支也从 payload 取）
 *       其余字段进 metadata
 *
 * 分叉判据：isSubagentSessionKey(ctx.sessionKey)。
 */

import { createHash } from "node:crypto";
import {
  buildAgentSessionKey,
  type OpenClawPluginToolContext,
  type PluginRuntime,
} from "openclaw/plugin-sdk/core";
import { isSubagentSessionKey } from "openclaw/plugin-sdk/routing";

import type { MessagingToolkit } from "../domains/xmtp/messaging.js";
import type { ConversationTracker } from "../domains/daemon/conversation-tracker.js";
import { encodePeerId } from "./peer-id.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAgentTool = any;

export interface DaemonForSend {
  getTracker(): ConversationTracker;
  getMessaging(): MessagingToolkit;
}

type EthAddress = `0x${string}`;

interface SendParams {
  content?: string;
  contentType?: string;
  payload: Record<string, unknown>;
}

interface SendDetails {
  ok: boolean;
  error?: string;
  conversationId?: string;
  messageId?: string;
  childSessionKey?: string;
  taskId?: string;
  peerAddress?: string;
  activePeers?: string[];
}

function isEthAddress(value: unknown): value is EthAddress {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function stableStringify(obj: Record<string, unknown>): string {
  const keys = Object.keys(obj).sort();
  const sorted: Record<string, unknown> = {};
  for (const k of keys) sorted[k] = obj[k];
  return JSON.stringify(sorted);
}

export function buildSendTool(
  getDaemons: () => Iterable<DaemonForSend>,
  getRuntime: () => PluginRuntime | null
): (ctx: OpenClawPluginToolContext) => AnyAgentTool {
  return (ctx) => ({
    name: "xmtp_send",
    label: "Send XMTP Message",
    description:
      "Send a structured XMTP message to a counterparty agent (A2A). " +
      "Required payload field: peerAddress (0x-prefixed EVM address). " +
      "Optional content is human-readable text; payload carries structured data. " +
      "When called from the main session, automatically spawns a negotiation " +
      "subagent for the (taskId, peerAddress) pair; when called from within " +
      "that subagent, just sends the follow-up message.",
    parameters: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "Human-readable text body (optional)",
        },
        contentType: {
          type: "string",
          description: "Content type; currently only 'text' is supported",
        },
        payload: {
          type: "object",
          description:
            "Structured business payload. Must include peerAddress (0x-prefixed). " +
            "taskId may be supplied here as fallback when not inferable from session.",
        },
      },
      required: ["payload"],
    },
    execute: async (
      _toolCallId: string,
      params: SendParams
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details: SendDetails }> => {
      const contentType = params.contentType ?? "text";
      if (contentType !== "text") {
        const msg = `Unsupported contentType: ${contentType} (only 'text' is supported)`;
        return {
          content: [{ type: "text", text: msg }],
          details: { ok: false, error: msg },
        };
      }

      const payload = params.payload;
      if (!payload || typeof payload !== "object") {
        const msg = "payload is required and must be an object";
        return { content: [{ type: "text", text: msg }], details: { ok: false, error: msg } };
      }

      const peerAddressRaw = (payload as Record<string, unknown>).peerAddress;
      if (!isEthAddress(peerAddressRaw)) {
        const msg = "payload.peerAddress is required and must be a 0x-prefixed EVM address";
        return { content: [{ type: "text", text: msg }], details: { ok: false, error: msg } };
      }
      const peerAddress: EthAddress = peerAddressRaw;

      const taskIdRaw = (payload as Record<string, unknown>).taskId;
      const taskId = typeof taskIdRaw === "string" && taskIdRaw.length > 0 ? taskIdRaw : null;
      if (!taskId) {
        const msg = "payload.taskId is required";
        return { content: [{ type: "text", text: msg }], details: { ok: false, error: msg } };
      }

      // 找到第一个 daemon（与 close-conversation-tool 相同模式；多钱包场景未来按 accountId 精定位）
      const daemon = getDaemons()[Symbol.iterator]().next().value as DaemonForSend | undefined;
      if (!daemon) {
        const msg = "No active XMTP daemon available";
        return { content: [{ type: "text", text: msg }], details: { ok: false, error: msg } };
      }

      const tracker = daemon.getTracker();
      if (!tracker.tryAcquire(taskId, peerAddress)) {
        const peers = tracker.activePeers(taskId);
        const msg =
          `Cannot acquire conversation seat for task=${taskId} peer=${peerAddress}; ` +
          `active peers: ${peers.join(",") || "(none)"}. Call xmtp_close_conversation first.`;
        return {
          content: [{ type: "text", text: msg }],
          details: { ok: false, error: msg, taskId, peerAddress, activePeers: peers },
        };
      }

      // 剥除保留字段，剩下的全部塞进 metadata
      const { peerAddress: _p, taskId: _t, ...otherPayload } = payload as Record<string, unknown>;
      void _p;
      void _t;
      const text = params.content ?? "";

      let conversationId: string;
      let messageId: string;
      try {
        const result = await daemon.getMessaging().sendStructured(
          taskId,
          { text, metadata: otherPayload },
          peerAddress
        );
        conversationId = result.conversationId;
        messageId = result.messageId;
      } catch (err) {
        const msg = `Failed to send XMTP message: ${String(err)}`;
        return {
          content: [{ type: "text", text: msg }],
          details: { ok: false, error: msg, taskId, peerAddress },
        };
      }

      // 刷新 idle timer / 清 response timer
      tracker.touchReply(taskId, peerAddress);

      const isSub = isSubagentSessionKey(ctx.sessionKey);
      if (isSub) {
        // sub 分支：不再派生 subagent，直接返回
        return {
          content: [{ type: "text", text: "sent" }],
          details: { ok: true, conversationId, messageId, taskId, peerAddress },
        };
      }

      // main 分支：派生 subagent 接管后续 A2A 协商
      const runtime = getRuntime();
      if (!runtime) {
        const msg = "Plugin runtime not ready; cannot spawn subagent";
        return {
          content: [{ type: "text", text: msg }],
          details: { ok: false, error: msg, taskId, peerAddress, conversationId, messageId },
        };
      }

      const childSessionKey = buildAgentSessionKey({
        agentId: ctx.agentId ?? "main",
        channel: "a2a-xmtp",
        accountId: ctx.agentAccountId ?? null,
        peer: { kind: "direct", id: encodePeerId(peerAddress, { taskId }) },
        dmScope: "per-account-channel-peer",
      });

      const payloadJson = stableStringify(otherPayload);
      const digest = createHash("sha256")
        .update(`${text}${payloadJson}`)
        .digest("hex")
        .slice(0, 16);
      const idempotencyKey = `xmtp_send:${taskId}:${peerAddress}:${digest}`;

      const childMessage =
        `[XMTP outbound] task=${taskId} peer=${peerAddress}\n` +
        `Content: ${text}\n` +
        `Payload: ${payloadJson}`;

      const extraSystemPrompt =
        `You are an A2A negotiation subagent for task=${taskId}, peer=${peerAddress}.\n` +
        `Your parent session has delegated the full A2A conversation to you.\n` +
        `The initial outbound message has already been delivered via XMTP; you are now waiting for the counterparty reply.\n` +
        `Available tools:\n` +
        `  - xmtp_get_pending_list: pull new inbound messages for this conversation.\n` +
        `  - xmtp_send: send follow-up structured messages to the counterparty.\n` +
        `  - close_conversation: release the seat once the deal is finished or abandoned.\n` +
        `Do not echo the outbound message; wait for the reply before acting.`;

      try {
        await runtime.subagent.run({
          sessionKey: childSessionKey,
          message: childMessage,
          extraSystemPrompt,
          deliver: false,
          idempotencyKey,
        });
      } catch (err) {
        const msg = `Message sent but subagent spawn failed: ${String(err)}`;
        return {
          content: [{ type: "text", text: msg }],
          details: {
            ok: false,
            error: msg,
            conversationId,
            messageId,
            childSessionKey,
            taskId,
            peerAddress,
          },
        };
      }

      return {
        content: [{ type: "text", text: "sent" }],
        details: {
          ok: true,
          conversationId,
          messageId,
          childSessionKey,
          taskId,
          peerAddress,
        },
      };
    },
  });
}
