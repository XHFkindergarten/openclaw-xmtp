import type { AgentMiddleware } from "@xmtp/agent-sdk";

/**
 * 提示词注入特征检测（启发式正则层）。
 *
 * 当前策略：**全量观测，不拦截**。
 *   - 所有命中仅旁路到 ctx.message.__injectionFlags，供 llm-presentation 生成
 *     warning_flags 属性，以及后续日志/数据分析使用
 *   - 不做自动警告回复，不中断 middleware 链
 *
 * 选择冷启动全观测的理由：
 *   - 正则集扩到 30 条后，真实流量下哪些规则高精度、哪些高误报没有先验数据
 *   - 先攒命中样本，再按 flag-name 升档为 block，比一次性全部 block 更安全
 *   - 拦截与警告回复属于二次迭代，待 getStatus() 暴露命中计数后再引入
 *
 * 必须在 unicode-normalize 之后跑（否则零宽拆字可绕过正则）。
 */

// llm-presentation 使用 <incoming_message> / <body> 等 tag 包裹 body。escapeXml 已经防住
// 真正的闭合攻击，这条规则只用于审计"对方曾试图伪造我们的呈现层 tag"的意图。

const INJECTION_PATTERNS: Array<{ name: string; re: RegExp }> = [
  // ─── 指令覆盖类（source: LLM Guard BanSubstrings default、Rebuff heuristics） ───
  { name: "ignore-previous", re: /ignore\s+(?:all\s+|the\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|rules?|directions?)/i },
  { name: "ignore-previous-zh", re: /忽略(?:之前|以上|以前|所有|上面)(?:的)?(?:指令|提示|规则|命令|要求)/ },
  { name: "disregard-previous", re: /disregard\s+(?:all\s+|the\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|rules?)/i },
  { name: "forget-instructions", re: /forget\s+(?:everything|all|about|your\s+(?:previous\s+)?(?:instructions?|rules?|prompts?|training))/i },
  { name: "forget-instructions-zh", re: /忘记(?:你的|之前|以上|所有)(?:的)?(?:指令|提示|规则|设定|对话|训练)/ },
  { name: "override-instructions", re: /(?:override|bypass|supersede)\s+(?:your|the|all)\s+(?:instructions?|rules?|prompts?|restrictions?|safety|guidelines?)/i },
  { name: "new-instructions", re: /(?:new|updated|revised|the\s+real)\s+instructions?\s*[:：]/i },

  // ─── 系统提示泄露类（source: deepset/prompt-injections、r/ChatGPTJailbreak） ───
  { name: "reveal-system", re: /(?:reveal|show|print|dump|expose|display)\s+(?:your\s+|the\s+)?(?:system\s+prompt|initial\s+instructions|original\s+prompt)/i },
  { name: "reveal-system-zh", re: /(?:展示|显示|输出|打印|告诉我|泄露)(?:你的)?(?:系统提示|初始指令|原始提示|system prompt)/i },
  { name: "repeat-above", re: /repeat\s+(?:the\s+)?(?:above|text|words|prompt|instructions?)\s+(?:verbatim|exactly|word[\s-]for[\s-]word)/i },
  { name: "what-were-instructions", re: /what\s+(?:were|are|is)\s+(?:your|the)\s+(?:original\s+|initial\s+)?(?:instructions?|prompts?|rules?|guidelines?|system\s+message)/i },

  // ─── 角色劫持 / DAN 类（source: DAN corpus、jackhhao/jailbreak-classification） ───
  { name: "role-hijack", re: /you\s+are\s+now\s+(?:a|an)\s+\w+/i },
  { name: "role-hijack-zh", re: /(?:你现在是|你是|扮演|从现在起你是)(?:一个)?[^\s]{2,10}/ },
  { name: "dan-mode", re: /\b(?:DAN|developer\s+mode|god\s+mode|jailbreak\s+mode|admin\s+mode|root\s+mode|evil\s+mode)\b/i },
  { name: "pretend-roleplay", re: /pretend\s+(?:to\s+be|you(?:'re|\s+are)|that\s+you)/i },
  { name: "act-as-role", re: /\bact\s+as\s+(?:an?\s+)?(?:ai|assistant|model|admin|root|system|developer|hacker|expert|unrestricted)\b/i },
  { name: "no-restrictions", re: /without\s+(?:any\s+)?(?:restrictions?|filters?|limits?|limitations?|censorship|safety|ethics|moral)/i },
  { name: "uncensored", re: /\b(?:uncensored|unfiltered|unrestricted|no[\s-]?filter|no[\s-]?limit)\b/i },

  // ─── 敏感信息请求类 ───
  { name: "file-leak", re: /(?:read|open|cat|dump|print|show|expose)\s+(?:the\s+)?(?:\.env|\/etc\/|private\s+key|secret|credentials?)/i },
  { name: "file-leak-zh", re: /(?:读取|打开|输出|显示|告诉我|泄露)(?:\.env|环境变量|私钥|密钥|secret|token|凭证)/i },
  { name: "credential-request", re: /(?:what(?:'s|\s+is)|give\s+me|share|tell\s+me)\s+(?:your\s+|the\s+)?(?:api[\s-]?key|password|token|credential|secret)/i },

  // ─── 工具 / 代码执行劫持 ───
  { name: "tool-hijack", re: /call\s+(?:the\s+)?tool\s+\w+\s+with/i },
  { name: "exec-code", re: /(?:execute|run|eval(?:uate)?)\s+(?:this|the\s+following|this\s+piece\s+of)\s+(?:code|script|command|shell|payload)/i },
  { name: "exec-code-zh", re: /(?:执行|运行|跑一下)(?:这段|下面这段|以下)?(?:代码|脚本|命令|shell)/ },

  // ─── 场景诱导类（hypothetical framing、fictional wrapper） ───
  { name: "grandma-jailbreak", re: /(?:grandma|grandmother|奶奶|外婆|姥姥).{0,40}(?:used\s+to|would\s+(?:tell|say|read|recite)|讲|告诉|念)/i },
  { name: "fictional-story", re: /write\s+(?:a|an)\s+(?:story|fiction|novel|scenario|tale|dialogue|play)\s+(?:where|about|in\s+which|featuring)/i },

  // ─── 协议劫持（fake chat template / delimiter break） ───
  { name: "delimiter-break", re: /<\/?(?:incoming_message|untrusted_user_message|schema|sender|metadata|body)\b/i },
  { name: "fake-chat-tag", re: /<\|?(?:im_start|im_end|system|assistant|endoftext)\|?>/i },
  { name: "fake-chat-turn", re: /^#{1,3}\s*(?:system|user|assistant|instruction)\s*[:：]/im },
];

export function detectInjection(text: string): string[] {
  const flagged: string[] = [];
  for (const { name, re } of INJECTION_PATTERNS) {
    if (re.test(text)) flagged.push(name);
  }
  return flagged;
}

export interface InjectionDetectOptions {
  /** 是否启用检测；false 时 middleware 直接透传（不跑正则、不写 __injectionFlags）。默认 true */
  enabled?: boolean;
  /** 命中计数器：命中一个 flag 则对应 key 自增。daemon 注入，供 getStatus() 观测 */
  counter?: Map<string, number>;
}

export function createInjectionDetectMiddleware(
  options: InjectionDetectOptions = {}
): AgentMiddleware {
  const enabled = options.enabled ?? true;
  const counter = options.counter;
  return async (ctx, next) => {
    if (!enabled) {
      await next();
      return;
    }
    const content = ctx.message.content;
    if (typeof content === "string") {
      const flagged = detectInjection(content);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (ctx.message as any).__injectionFlags = flagged;
      if (flagged.length > 0) {
        console.log(
          `[injection-detect] flags=[${flagged.join(",")}] from=${ctx.message.senderInboxId.slice(0, 12)}…`
        );
        if (counter) {
          for (const f of flagged) {
            counter.set(f, (counter.get(f) ?? 0) + 1);
          }
        }
      }
    }
    await next();
  };
}

// 无计数、默认启用的快捷导出（recovery 离线重放场景不经过 middleware，但保留以防其他地方 import）
export const injectionDetectMiddleware: AgentMiddleware = createInjectionDetectMiddleware();
