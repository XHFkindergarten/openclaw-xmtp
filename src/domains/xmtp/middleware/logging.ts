import type { AgentMiddleware } from "@xmtp/agent-sdk";

export const loggingMiddleware: AgentMiddleware = async (ctx, next) => {
  const content = ctx.message.content;
  const text = typeof content === "string" ? content : "[non-text]";
  const preview = text.length > 60 ? text.slice(0, 60) + "…" : text;
  const ts = new Date(Number(ctx.message.sentAtNs / 1_000_000n)).toISOString();
  console.log(
    `[msg] from=${ctx.message.senderInboxId.slice(0, 12)}… ` +
    `conv=${ctx.conversation.id.slice(0, 12)}… ` +
    `len=${text.length} ts=${ts} preview="${preview}"`
  );
  await next();
};
