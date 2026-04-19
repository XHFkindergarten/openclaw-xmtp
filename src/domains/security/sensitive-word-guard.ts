import { encodeText } from "@xmtp/node-sdk";
import type { AgentMiddleware } from "@xmtp/agent-sdk";
import { ContentFilter } from "./filter.js";

// TODO: 替换为后端 API 拉取
// 预期接口: GET /api/sensitive-words → { words: string[] }
const DEFAULT_SENSITIVE_WORDS = ["sb", "傻逼"];

export interface SensitiveWordGuardConfig {
  /** 敏感词列表，省略时使用内置占位列表 */
  words?: string[];
  /** 命中敏感词时的回复内容 */
  warningMessage?: string;
  /** 通过检查时的打招呼回复 */
  greetingMessage?: string;
  /** 命中时是否自动回警告（默认 true；混合模型：非法消息不进入 LLM，由 guard 直接回拒） */
  replyOnBlock?: boolean;
  /** 通过时是否自动回问候（默认 false；合法消息交由 LLM 生成回复，避免双响） */
  replyOnPass?: boolean;
}

/**
 * 敏感词门禁 Middleware。
 *
 * 注册方式：agent.use(new SensitiveWordGuard().middleware())
 *
 * 处理逻辑（混合模型）：
 *   - 非文本消息（GroupUpdated / ReadReceipt 等）：透传，不干预
 *   - 命中敏感词：log BLOCKED + 默认直接回拒（replyOnBlock=true），拦截（不调用 next）
 *   - 未命中：调用 next，log PASSED；默认不自动回复（replyOnPass=false），交由 LLM 生成
 */
export class SensitiveWordGuard {
  private readonly filter: ContentFilter;
  private readonly warningMessage: string;
  private readonly greetingMessage: string;
  private readonly replyOnBlock: boolean;
  private readonly replyOnPass: boolean;

  constructor(config: SensitiveWordGuardConfig = {}) {
    this.filter = new ContentFilter({
      blocklist: config.words ?? DEFAULT_SENSITIVE_WORDS,
    });
    this.warningMessage =
      config.warningMessage ??
      "⚠️ 您的消息包含不当用语，请规范用语后重新发送。";
    this.greetingMessage =
      config.greetingMessage ?? "👋 你好！已收到你的消息。";
    this.replyOnBlock = config.replyOnBlock ?? true;
    this.replyOnPass = config.replyOnPass ?? false;
  }

  middleware(): AgentMiddleware {
    return async (ctx, next) => {
      // 非文本内容（系统消息等）直接透传，不触发门禁
      if (typeof ctx.message.content !== "string") {
        await next();
        return;
      }

      const content = ctx.message.content;
      const result = this.filter.check(content);
      const from = ctx.message.senderInboxId.slice(0, 16) + "…";

      if (!result.allowed) {
        console.log(
          `[sensitive-word-guard] BLOCKED` +
            ` | from=${from}` +
            ` | reason="${result.reason}"` +
            ` | content="${content.slice(0, 60)}"`
        );
        if (this.replyOnBlock) {
          await ctx.conversation.send(encodeText(this.warningMessage));
        }
        return; // 拦截，不向后续 middleware 传递
      }

      await next(); // 通过检查，继续处理链

      console.log(
        `[sensitive-word-guard] PASSED` +
          ` | from=${from}` +
          ` | content="${content.slice(0, 60)}"`
      );
      if (this.replyOnPass) {
        await ctx.conversation.send(encodeText(this.greetingMessage));
      }
    };
  }
}
