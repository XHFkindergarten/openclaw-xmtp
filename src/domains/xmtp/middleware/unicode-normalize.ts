import type { AgentMiddleware } from "@xmtp/agent-sdk";

/**
 * Unicode 归一化 + 去除隐形字符。
 *
 * 为什么要在所有其它内容过滤之前跑：
 *   攻击者可以用零宽空格 / bidi override 把敏感词拆开绕过字面匹配。
 *   例如 "傻\u200B逼" 在 includes("傻逼") 上不成立。必须先归一化，
 *   后续的 sensitive-word / injection-detect 才能拿到稳定的输入。
 *
 * 这一层不做标注、不做包装，职责单一。
 */

const INVISIBLE_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

export interface NormalizeResult {
  text: string;
  strippedInvisible: number;
}

export function applyNormalize(raw: string): NormalizeResult {
  const normalized = raw.normalize("NFC");
  const stripped = normalized.replace(INVISIBLE_RE, "");
  return { text: stripped, strippedInvisible: normalized.length - stripped.length };
}

export const unicodeNormalizeMiddleware: AgentMiddleware = async (ctx, next) => {
  const content = ctx.message.content;
  if (typeof content === "string") {
    const { text, strippedInvisible } = applyNormalize(content);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ctx.message as any).content = text;
    if (strippedInvisible > 0) {
      console.log(
        `[normalize] stripped=${strippedInvisible} from=${ctx.message.senderInboxId.slice(0, 12)}…`
      );
    }
  }
  await next();
};
