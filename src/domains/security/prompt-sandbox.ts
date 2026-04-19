import type { MessageContext } from "@xmtp/agent-sdk";

export interface SandboxedMessage {
  content: string;
  senderInboxId: string;
  conversationId: string;
  conversationName: string;
  sentAt: Date;
  /** 解析自结构化 envelope（sendStructured）的 metadata；纯文本消息为 {}。 */
  metadata: Record<string, unknown>;
}

export interface PromptSandboxConfig {
  /**
   * Hard cap on content length passed to the handler.
   * Content is truncated (not rejected) at this limit. Default: 4000.
   */
  maxContentLength?: number;
}

/**
 * Extracts a safe, bounded representation of a MessageContext.
 * Only string content passes through; non-text payloads become "[non-text]".
 * Truncates content at maxContentLength to prevent token flooding upstream.
 */
export function sandboxMessage(
  ctx: MessageContext,
  config: PromptSandboxConfig = {}
): SandboxedMessage {
  const maxLen = config.maxContentLength ?? 4_000;

  const raw = ctx.message.content;
  let content = typeof raw === "string" ? raw : "[non-text]";
  if (content.length > maxLen) {
    content = content.slice(0, maxLen) + "…[truncated]";
  }

  const conv = ctx.conversation;
  const conversationName = ctx.isGroup() ? (conv as import("@xmtp/node-sdk").Group).name : "";

  // 从 structuredEnvelopeMiddleware 的旁路字段读取 metadata；未经该中间件则为 {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const metadata = ((ctx.message as any).__metadata as Record<string, unknown>) ?? {};

  return {
    content,
    senderInboxId: ctx.message.senderInboxId,
    conversationId: conv.id,
    conversationName,
    sentAt: new Date(Number(ctx.message.sentAtNs / 1_000_000n)),
    metadata,
  };
}
