import type { Agent } from "@xmtp/agent-sdk";
import { MessagingToolkit } from "./messaging.js";
import { applyNormalize } from "./middleware/unicode-normalize.js";
import { detectInjection } from "./middleware/injection-detect.js";
import {
  applyLlmPresentation,
  InboxEthAddressCache,
} from "./middleware/llm-presentation.js";

/**
 * PULL 时点 / 启动恢复时点共用的 "raw DB message → LLM 可消费形态" 渲染管线。
 *
 * 与 daemon.start() 注册的在线 middleware 链严格同序：
 *   parseStructured → applyNormalize → detectInjection → applyLlmPresentation
 *
 * 在线 middleware 修改 ctx.message.content 仅在 in-flight handler 内可见，
 * 不会落到 XMTP DB；所以重启 / PULL 都必须重跑这条链。LlmRenderer 是这条
 * 链的唯一可信副本——recovery.ts 与 get_pending_list tool 都从这里调用，
 * 避免双轨漂移。
 */

type Group = Awaited<ReturnType<Agent["client"]["conversations"]["listGroups"]>>[number];
type DecodedMessage = Awaited<ReturnType<Group["messages"]>>[number];

export interface RenderedMessage {
  conversationId: string;
  messageId: string;
  sentAtNs: bigint;
  senderInboxId: string;
  bodyXml: string;
  rawText: string;
  metadata: Record<string, unknown>;
  injectionFlags: string[];
}

export class LlmRenderer {
  private ethCache: InboxEthAddressCache;

  constructor(agent: Agent) {
    this.ethCache = new InboxEthAddressCache(agent);
  }

  async renderOne(
    m: DecodedMessage,
    conversationId: string
  ): Promise<RenderedMessage | null> {
    if (typeof m.content !== "string") return null;

    const { text, metadata } = MessagingToolkit.parseStructured(m.content);
    const { text: normalized } = applyNormalize(text);
    const flags = detectInjection(normalized);
    const senderEthAddress = await this.ethCache.resolve(m.senderInboxId);
    const bodyXml = applyLlmPresentation({
      body: normalized,
      senderInboxId: m.senderInboxId,
      senderEthAddress,
      identity: "unverified",
      metadata,
      flags,
    });

    return {
      conversationId,
      messageId: m.id,
      sentAtNs: BigInt(m.sentAtNs),
      senderInboxId: m.senderInboxId,
      bodyXml,
      rawText: normalized,
      metadata,
      injectionFlags: flags,
    };
  }
}
