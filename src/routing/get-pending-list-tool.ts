/**
 * xmtp_get_pending_list agent tool factory。
 *
 * 触发场景：
 *   - LLM PULL 入口。给定 conversationId,返回水位之后的新消息(已渲染成
 *     <incoming_message> XML 形态),并自动推进水位。
 *
 * 自动 ack 设计：
 *   - 调用即推进。LLM 不需要显式 ack,水位概念对 LLM 完全透明
 *   - 代价:LLM 处理崩溃在"已 PULL 但未消费"窗口里 → 这批消息丢
 *   - 选择理由:OpenClaw subagent 与 daemon 同进程,LLM crash 通常 daemon 也跟着崩;
 *     而 daemon 崩之前 watermark 已经 sync 落盘
 *
 * filter 双层:在线 sensitive-word 负责"对外回警告"(及时性),
 *           PULL 时 ContentFilter.check 负责"对 LLM 屏蔽"(语义干净)。
 *           被 filter 跳过的消息不会出现在返回值,也不会让 LLM 感知。
 *           但水位仍前进到 raw 集合的最后一条,避免下次 PULL 反复扫到。
 */

import type { Agent } from "@xmtp/agent-sdk";
import type { ContentFilter } from "../domains/security/filter.js";
import type { LlmRenderer } from "../domains/xmtp/render-for-llm.js";
import type { WatermarkStore } from "../domains/daemon/watermark-store.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAgentTool = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OpenClawPluginToolContext = any;

export interface DaemonForPull {
  agent: Agent;
  renderer: LlmRenderer;
  filter: ContentFilter;
  watermarks: WatermarkStore;
}

const DEFAULT_MAX = 20;
const HARD_MAX = 50;

interface ReturnedMessage {
  message_id: string;
  sent_at_ns: string;
  sender_inbox_id: string;
  body_xml: string;
}

interface ToolResult {
  conversation_id: string;
  messages: ReturnedMessage[];
  advanced_to_ns: string | null;
  skipped_count: number;
}

export function buildGetPendingListTool(
  getDaemons: () => Iterable<DaemonForPull>
): (ctx: OpenClawPluginToolContext) => AnyAgentTool {
  return (_ctx) => ({
    name: "xmtp_get_pending_list",
    label: "Get Pending XMTP Messages",
    description:
      "Fetch new XMTP messages in a given conversation since the last pull. " +
      "Automatically advances the read watermark; messages returned will not " +
      "appear in subsequent calls. Returns messages already rendered as " +
      "<incoming_message> XML envelopes (untrusted, with sender + metadata).",
    parameters: {
      type: "object",
      properties: {
        conversation_id: {
          type: "string",
          description: "XMTP group.id (the stable conversation identifier)",
        },
        max_messages: {
          type: "number",
          description: `Maximum messages to return (default ${DEFAULT_MAX}, hard cap ${HARD_MAX})`,
        },
      },
      required: ["conversation_id"],
    },
    execute: async (
      _toolCallId: string,
      params: { conversation_id: string; max_messages?: number }
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details: ToolResult }> => {
      const limit = Math.min(
        Math.max(params.max_messages ?? DEFAULT_MAX, 1),
        HARD_MAX
      );

      const daemon = await findDaemonForConversation(getDaemons(), params.conversation_id);
      if (!daemon) {
        const empty: ToolResult = {
          conversation_id: params.conversation_id,
          messages: [],
          advanced_to_ns: null,
          skipped_count: 0,
        };
        return {
          content: [{ type: "text", text: `No conversation matched id=${params.conversation_id}` }],
          details: empty,
        };
      }

      const { agent, renderer, filter, watermarks } = daemon;
      const group = await agent.client.conversations.getConversationById(params.conversation_id);
      if (!group) {
        const empty: ToolResult = {
          conversation_id: params.conversation_id,
          messages: [],
          advanced_to_ns: null,
          skipped_count: 0,
        };
        return {
          content: [{ type: "text", text: `Conversation ${params.conversation_id} not found` }],
          details: empty,
        };
      }

      await group.sync();

      const watermark = watermarks.get(params.conversation_id);
      const myInboxId = agent.client.inboxId;

      // sortBy 0 = SentAt, direction 0 = Ascending(都是 const enum,直接用字面量);
      // excludeSenderInboxIds 服务端就把自己发的过滤掉,省一次内存遍历。
      const raws = await group.messages({
        sentAfterNs: watermark > 0n ? watermark : undefined,
        limit,
        sortBy: 0,
        direction: 0,
        excludeSenderInboxIds: [myInboxId],
      });

      const allowed: ReturnedMessage[] = [];
      let skipped = 0;
      let maxSeenNs: bigint = watermark;

      for (const m of raws) {
        if (m.sentAtNs > maxSeenNs) maxSeenNs = m.sentAtNs;

        const rendered = await renderer.renderOne(m, params.conversation_id);
        if (!rendered) {
          skipped++;
          continue;
        }
        const filterResult = filter.check(rendered.rawText);
        if (!filterResult.allowed) {
          skipped++;
          continue;
        }
        allowed.push({
          message_id: rendered.messageId,
          sent_at_ns: rendered.sentAtNs.toString(),
          sender_inbox_id: rendered.senderInboxId,
          body_xml: rendered.bodyXml,
        });
      }

      // 自动 ack:推进到 raw 集合见到的最大 sentAtNs(含被 filter 跳过的)
      let advancedToNs: string | null = null;
      if (maxSeenNs > watermark) {
        watermarks.ack(params.conversation_id, maxSeenNs);
        advancedToNs = maxSeenNs.toString();
      }

      const result: ToolResult = {
        conversation_id: params.conversation_id,
        messages: allowed,
        advanced_to_ns: advancedToNs,
        skipped_count: skipped,
      };

      const summary = `Pulled ${allowed.length} message(s) from ${params.conversation_id}` +
        (skipped > 0 ? ` (${skipped} skipped by filter)` : "") +
        (advancedToNs ? ` | watermark → ${advancedToNs}` : "");
      return { content: [{ type: "text", text: summary }], details: result };
    },
  });
}

async function findDaemonForConversation(
  daemons: Iterable<DaemonForPull>,
  conversationId: string
): Promise<DaemonForPull | null> {
  for (const d of daemons) {
    const conv = await d.agent.client.conversations.getConversationById(conversationId);
    if (conv) return d;
  }
  return null;
}
