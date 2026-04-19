import type { AgentMiddleware } from "@xmtp/agent-sdk";
import { MessagingToolkit } from "../messaging.js";

/**
 * 结构化 envelope 解析中间件。
 *
 * 必须位于 llm-presentation 之前，否则 content 会被 <incoming_message> 结构包裹，
 * 无法再 JSON.parse 取出 text/metadata。
 *
 * 作用：
 *   - 将 JSON envelope `{ text, metadata }` 拆分：content ← text；metadata 旁路到 ctx.message.__metadata
 *   - 非结构化内容（纯文本）透传，metadata 设为 {}
 */
declare module "@xmtp/agent-sdk" {
  // 扩展 DecodedMessage 运行时字段（仅内存旁路，不持久化）
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface MessageContext {}
}

export const structuredEnvelopeMiddleware: AgentMiddleware = async (ctx, next) => {
  const content = ctx.message.content;
  if (typeof content === "string") {
    const { text, metadata } = MessagingToolkit.parseStructured(content);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ctx.message as any).content = text;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ctx.message as any).__metadata = metadata;
  }
  await next();
};
