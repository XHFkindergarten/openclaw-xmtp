# Code Review Checklist

> 目的：对截至当前已实现的 `src/` 代码做一次整体审查，列出不合理 / 有缺陷 / 可优化的点，供逐项决策（修 / 延后 / 不改）。
>
> 使用方式：每一项自包含（定位 + 现状 + 为什么是问题 + 影响 + 建议方向）。在每一项末尾的 `决策:` 后面写下你选的选项即可。

**优先级建议的处理顺序**：P0（架构方向决策）→ P1（安全红线）→ P2（删死代码，能一键瘦身）→ P3→P4…

---

## P0 架构一致性（需方向性决策，最高优先级）

### P0-1 Pull 模型与 push 中间件链自相矛盾

**定位**：整个 `src/domains/xmtp/middleware/*` + `src/index.ts` 的 agent 构建段。

**现状**：项目 README / DESIGN 宣称 daemon 对消息无状态，由 LLM 主动调用 `xmtp_get_pending_list` 推进水位。但当前 `agent.use(...)` 链上挂着完整的 push 中间件：
- `loggingMiddleware`
- `unicodeNormalizeMiddleware`
- `structuredEnvelopeMiddleware`
- `injectionDetectMiddleware`
- `llmPresentationMiddleware`
- `sensitiveWordGuardMiddleware`

这些中间件在 XMTP 消息到达的 push 路径上执行并改写 `ctx.message.content`、写日志、发回复。

**为什么是问题**：
- 语义冲突：如果 daemon 无状态，那"消息到达时预处理"就该发生在 LLM 拉取时（pending list 响应合成阶段），而不是在流式 push 里。
- 可观测性错位：push 路径的日志量 ≠ 实际被 LLM 消费的量。
- 重复工作：SDK 流式消息 + daemon 水位同时存在，日志/指标来源双份。

**影响**：面向 LLM 的"按需渲染"失效；新同事理解架构时会迷惑；未来新增预处理步骤要在两条路径间选择。

**建议方向（二选一）**：
- (A) **真·Pull**：把 `llm-presentation` / `sensitive-word-guard` 等"面向 LLM 的"中间件从 `agent.use` 链移除，改到 `get_pending_list` 响应合成路径；push 链只保留最小的水位推进与必要审计。
- (B) **承认混合模型**：保留现状，但修改 DESIGN.md / README，把"stateless daemon"的说法改成"daemon 做轻量预处理 + LLM 拉取"，明确边界。

**决策: (B) 混合模型** — 理由：非法消息无需 LLM 决策，由 guard 直接 push 拒绝是合理的；合法消息才走 pull 路径交给 LLM。DESIGN.md 目前未出现 "stateless daemon" 字样（该措辞只存在于本 checklist），无需改 DESIGN；仅在 checklist 后续各项中把"pull 模型"前提改为"混合模型"。

---

### P0-2 `sensitive-word-guard` 默认 push 回发

**定位**：`src/domains/security/sensitive-word-guard.ts:48-49, 72, 85`

**现状**：`replyOnBlock` / `replyOnPass` 两个 flag 默认 `true`，命中敏感词 / 通过校验时都会主动 `ctx.conversation.send(...)`。

**为什么是问题**：在混合模型下"通过校验就自动回复"与 LLM 的回复策略冲突；`replyOnPass=true` 会导致 guard 抢先回执 + LLM 再回复一次的双响。

**影响**：真实用户会看到两条回复（guard 的 + LLM 的），或 guard 把一些本该给 LLM 的消息抢先"确认"掉。

**建议方向**：
- 默认 `replyOnPass=false`；`replyOnBlock` 保留为 `true`（混合模型下非法消息 push 拒绝是合理的）。

**决策: 已修复** — `sensitive-word-guard.ts:49` 的 `replyOnPass` 默认值改为 `false`，`replyOnBlock` 保持 `true`，类头部 JSDoc 同步对齐混合模型描述。`daemon.ts:124` 的显式 `{replyOnPass: false, replyOnBlock: true}` 现已冗余但保留不动（明示意图、无害）。

---

### P0-3 `llm-presentation` 在流式阶段改写 content

**定位**：`src/domains/xmtp/middleware/llm-presentation.ts:108-109` — `msg.content = applyLlmPresentation(...)`

**现状**：中间件在消息到达时就把 content 改写成 `<message>...</message>` 的 XML 结构，下游（无论是 tool 返回还是别处）拿到的都是改写后的值。

**为什么是问题**：
- "给 LLM 看"的渲染被固化到了上游，所有下游路径无法拿到原文。
- 如果未来要支持"按不同模型差异化渲染"，已经没有原文可用。

**影响**：耦合过早；渲染逻辑无法按消费者切换。

**建议方向**：保留原文（不 in-place 改写），在 `get_pending_list` 返回时做渲染。

**决策: 保留现状** — 暂时不是问题；未来如需"按模型差异化渲染"再迁移。

---

### P0-4 `daemon` 并非完全无状态（与宣称冲突）

**定位**：`src/routing/close-conversation-tool.ts` + `src/domains/daemon/conversation-tracker.ts`

**现状**：`close_conversation` 工具的作用是释放 daemon 内存里 `conversation-tracker` 的 seat；说明 daemon 里确实持有会话生命周期状态。tracker 的 seat + idle 超时语义源自 push 模型的并发节流。

**为什么是问题**：与"daemon stateless"的宣称不一致。而且在 pull 模型下，没人"占着 seat"在处理消息，tracker 的价值存疑。

**用户澄清（2026-04-17）**：tracker 是必要的 — 需要控制"同一 task scope 下同时沟通的会话数"（默认 1），daemon 因此有状态；`close_conversation` 工具即 LLM 认为沟通结束时释放席位的入口。但原实现存在三处与意图不一致：
1. 席位池是**全局**的，不是 per-task（导致 task A 会阻塞 task B）；
2. 席位占用时点是"入站消息到达 middleware 时"，与"LLM 在沟通中"的语义不符；
3. 缺少 LLM 响应超时兜底（只有 idle 超时，无法应对"peer 一直发 LLM 一直不回"）。

**决策: 已按 γ 语义 + per-task 桶重写** — 详见实施记录：

**实施记录**：
- `src/domains/daemon/conversation-tracker.ts` 整体重写：
  - 数据结构 `activeByTask: Map<taskId, Map<peer, entry>>`，`maxConcurrentPerTask` 默认 1
  - 新 API：`tryAcquire(taskId, peer)` / `touchReply(taskId, peer)` / `notifyInbound(taskId, peer)` / `close(taskId, peer, reason)` / `activeCount(taskId?)` / `activePeers(taskId)`
  - 两个独立超时：`idleTimeoutMs`（双方沉默）、`responseTimeoutMs`（peer 已发 inbound 但 LLM 未回），均默认 10 min
  - 删除原 `submit` / `chain` / `waiters` 机制（γ 下不需要，顺带消解了发现 4/5）
  - 删除 `ConversationTracker.keyOf`（外部未再使用）
- `src/domains/daemon/daemon.ts`：
  - `sendMessage` 前置 `tryAcquire`（拒绝则 throw 带活跃 peer 列表），成功后 `touchReply`
  - middleware 链末端新增极简 middleware 调 `notifyInbound`，从 `ctx.conversation.name` 拆 `${taskId}::${peer}`
  - `closeConversation(taskId, peer)` 直接调新 `tracker.close(taskId, peer, "manual")`
  - `getStatus().activeSubagents` 改为 `tracker.activeCount()`（跨所有 task 的总数）
- 验证：`pnpm typecheck` 通过；`pnpm test` 结果 36 pass / 14 fail，14 fail 全部是预先存在的 sandboxMessage `ctx.isGroup is not a function`，与本次改动无关。

**未处理（发现 4、5 之外的遗留）**：
- 中间件链触发 `notifyInbound` 前会先走 sensitive-word-guard → 被 guard 拦截的消息不会触发 notifyInbound。这是合理的（非法消息本就不应推进 response timer），但需要意识到。
- group.name 不符合 `${taskId}::${peer}` 格式时 notifyInbound 静默跳过 —— 对非本 SDK 创建的 group 安全。

---

### P0-5 `recovery.rebuild` 当前是空操作但每次启动都调用

**定位**：`src/domains/daemon/recovery.ts` + `src/domains/daemon/daemon.ts` 的 `start()`

**现状**：`fetchActiveTasks()` 直接 `return []`（TODO 占位），`getTaskGroupMap()` 永远返回空 Map；`daemon.start()` 每次都调用 `rebuild()`。

**为什么是问题**：死循环意义的存在 — 代码占位但无行为，既误导又要维护。

**建议方向**：
- 若恢复机制短期不做 → 删除 `rebuild()` 调用 + 整个 `recovery.ts`，等要做时重新引入。
- 若近期要做 → 写 TODO 细化预期行为、写 issue 追踪，否则就删。

**决策:**

---

### P0-6 同时存在两套"水位"读取

**定位**：`src/domains/xmtp/messaging.ts:94-113` `getPendingMessages` vs `src/domains/daemon/watermark-store.ts` + `get-pending-list-tool`

**现状**：`messaging.getPendingMessages(options?)` 遍历所有 group 读 `sentAfterNs` 之后的消息；另一套是 daemon 的 `watermark-store` + `get_pending_list` 工具。

**为什么是问题**：两套机制各自独立推进，互不同步 → 容易出现"两个水位不一致"的经典故障。

**建议方向**：确认 `messaging.getPendingMessages` / `getHistory` 是否仍有调用方，没有就删；有就合并到 watermark-store 统一口径。

**决策:**

---

## P1 安全红线（建议优先修）

### P1-1 LLM 直调工具的入参无 zod 校验

**定位**：
- `src/routing/close-conversation-tool.ts:17-19`（`AnyAgentTool = any`、`OpenClawPluginToolContext = any`、eslint-disable）
- `src/routing/get-pending-list-tool.ts` 同样 `any` + eslint-disable

**现状**：工具参数 `{taskId, peerAddress}` / `{taskId, conversationId, limit}` 直接由 LLM 产生并下传 daemon，没有 zod schema 校验格式（`peerAddress` 应是 `0x` + 40 hex；`taskId` 应是某个 UUID / 白名单等）。

**为什么是问题**：LLM 是不受信来源。一个 prompt injection 可能诱导 LLM 传入畸形地址或跨任务 id → 命中意外的 daemon 状态。

**影响**：安全边界失守；`close_conversation` 可能错误释放其他会话 seat；`get_pending_list` 可能读到非本任务的消息。

**建议方向**：用 zod 定义两个工具的参数 schema（地址 `^0x[a-fA-F0-9]{40}$`、taskId 白名单或 regex），在 handler 入口 `.parse()`，失败返回结构化 error。

**决策:**

---

### P1-2 敏感内容片段写入日志

**定位**：`src/domains/security/sensitive-word-guard.ts:69`；另 `logging.ts:8-12`、`injection-detect.ts:99`、`prompt-sandbox` 相关位置

**现状**：
```ts
// sensitive-word-guard.ts:69
console.log(`[sensitive-word] BLOCKED: ${content.slice(0, 60)}`);
```
以及 `logging.ts` 中间件整体就是把 `ctx.message` 打印出来。

**为什么是问题**：PII / 合规风险。被 guard 命中的消息往往包含敏感词本身；日志可能进采集管道。

**建议方向**：
- 命中时只记录长度 + hash + flag，不写原文。
- 默认关闭 `logging.ts`，只在调试模式启用。

**决策:**

---

### P1-3 DB 加密 key 读取静默降级为明文

**定位**：`src/domains/xmtp/xmtp.ts:109-130` `readDbEncryptionKey`

**现状**：`.env` 文件读取 / 解析出错时返回 `undefined`，XMTP client 会以**明文**方式打开本地 DB，无任何告警。

**为什么是问题**：本意是要加密，一个文件权限错误或格式错误就悄悄变明文，运维不会发现。

**影响**：本地 DB 里的消息、密钥元数据可能以明文落盘。

**建议方向**：
- 生产模式下 key 缺失 → throw；只有显式 `ALLOW_UNENCRYPTED_DB=1` 时才允许降级。
- 用标准 dotenv 库替换自写解析（见 I-4）。

**决策:**

---

### P1-4 peer address / conversation id 无运行时校验

**定位**：`src/routing/peer-id.ts:33-40` `decodePeerId`；`src/routing/close-conversation-tool.ts`

**现状**：`decodePeerId` 接收任意 string，`.slice(0, qIdx) as 0x${string}` 仅做类型断言，未校验 `0x` 前缀和 40 hex。下游代码信赖这个类型假设。

**为什么是问题**：类型安全靠运行时校验落地；断言等于零检查。

**建议方向**：加一个 `isEvmAddress(s)` 运行时函数，`decodePeerId` 失败返回 `null`。

**决策:**

---

### P1-5 `onchainos` 的 `execFile` 存在未来的命令注入面

**定位**：`src/domains/onchainos/onchainos.ts:76-83`

**现状**：`execFile(this.binaryPath, args)`，`binaryPath` 默认 `"onchainos"`（依赖 PATH 解析）。此外 `JSON.parse(stdout)` 无 stdout 大小限制。

**为什么是问题**：
- 依赖 PATH：当前环境受信，但一旦 `binaryPath` 被配置化（配置来自用户输入 / 外部 JSON）就是命令注入入口。
- stdout 无上限：恶意进程可能通过大 stdout 触发内存爆炸。

**当前风险**：**实际生产路径不通**（`getAgentIdentity` 等都 throw Not implemented，生产走的是 `TestOnChainOSClient`），所以现在不会触发；但结构已埋。

**建议方向**：
- `binaryPath` 必须绝对路径 + 文件存在性检查；不接受 PATH 查找。
- 给 `execFile` 加 `maxBuffer` 限制（Node 默认 1MB 已有，但要确认当前没覆盖）。
- 或者短期直接删掉真实 client 实现，只留 `TestOnChainOSClient`，等要上线时再写。

**决策:**

---

### P1-6 `escapeXml` 仅处理 `& < >`，未处理引号

**定位**：`src/domains/xmtp/middleware/llm-presentation.ts:48-50`

**现状**：`escapeXml` 只转义三个字符；输出里存在 `warning_flags="..."` 这种 XML 属性位。

**为什么是问题**：当前填入属性位的 `flags` 值来自静态正则列表（安全），但模板是扩展点，未来放任何外部字符串到属性位都会有 XML 注入 → LLM 指令混淆。

**建议方向**：一次补齐 `"` `'`，或直接用成熟库（但不必引入重依赖，手补两字符即可）。

**决策:**

---

## P2 死代码 / 孤儿模块（删除即净收益）

### P2-1 `queue.ts` + 对应测试完全未被引用

**定位**：
- `src/domains/daemon/queue.ts`（`SessionQueue<T>`）
- `test/queue.test.ts`
- `test/queue.edge.test.ts`

**现状**：用 grep 验证，`SessionQueue` 在 `src/` 内无引用；`conversation-tracker.ts` 的文档注释里提到了 SessionQueue 的存在，但没有 import。是 push 模型时代的残留。

**为什么是问题**：死代码维护成本；还造成 I-1 的 `QueueConfig` 三份定义冲突。

**建议方向**：删文件 + 删对应两个测试文件。如果要保守，可先 `git mv` 到 `archive/` 下过渡一个 release。

**决策:**

---

### P2-2 两个 bootstrap demo 脚本在生产入口之外

**定位**：
- `src/bootstrap/xmtp-group-demo.ts`
- `src/bootstrap/xmtp-sensitive-word-demo.ts`

**现状**：都是顶层 `await` 的脚本，`index.ts` 未 import，`package.json` scripts 未引用，`openclaw.extensions` 入口也没有。只能 `tsx` 手动跑。各 ~180 行，重复维护 `log` / `separator` / `sleep` 等工具函数。

**为什么是问题**：既不在构建链路里（易腐烂），又放在 `src/` 会被 tsc 扫进去（如果 tsconfig include 了 `src/**`）。

**建议方向**：移到 `scripts/` 或 `examples/` 目录，统一用一份 `shared-utils.ts`；或如果用途已过就删。

**决策:**

---

### P2-3 真实 `OnChainOSClient` 全是 `throw "Not implemented"`

**定位**：`src/domains/onchainos/onchainos.ts:149-180`

**现状**：`getAgentIdentity` / `getXmtpAddress` / `getAllAccounts` 全部抛 "Not implemented"；生产路径用 `init-xmtp-install.ts:11,41,61` 里的 `TestOnChainOSClient` 替代。

**为什么是问题**：生产类是"只有类名的占位"，但 `execFile` / `JSON.parse` 等外壳已经写了，徒增攻击面（见 P1-5）。

**建议方向**：
- 短期：删掉 `OnChainOSClient` 的实体代码（保留 interface），只留 `TestOnChainOSClient`；或
- 加上 README 注明"真实 client 待实现，当前走 test"，确保切换 flag 存在。

**决策:**

---

### P2-4 `injection-detect` 的默认导出实例

**定位**：`src/domains/xmtp/middleware/injection-detect.ts:113`

**现状**：`export const injectionDetectMiddleware = createInjectionDetectMiddleware()`；daemon 构建中间件时用的是工厂 `createInjectionDetectMiddleware`。

**为什么是问题**：默认实例无引用（需 grep 确认全仓库），存在就容易被误用。

**建议方向**：grep 仓库全局，无引用则删。

**决策:**

---

### P2-5 `messaging.ts` 的 `getPendingMessages` / `getHistory` 可能无调用方

**定位**：`src/domains/xmtp/messaging.ts:94-123`

**现状**：两个方法像是旧 push 模型下的"本地 catch-up"逻辑，与 daemon 的 watermark-store 重叠（同 P0-6）。

**建议方向**：grep 调用方：
- 若无 → 删。
- 若有 → 合并到 watermark-store 的口径下，或在注释里明确它是另一层级的 API。

**决策:**

---

## P3 日志规范

### P3-1 domain 层大量 `console.*` 绕过 pluginLogger

**定位**（已确认）：
- `src/domains/daemon/daemon.ts`（多处）
- `src/domains/daemon/conversation-tracker.ts:78, 94`
- `src/domains/daemon/queue.ts:44`（若保留）
- `src/domains/security/sensitive-word-guard.ts:65, 79`
- `src/domains/xmtp/middleware/unicode-normalize.ts:34`
- `src/domains/xmtp/middleware/injection-detect.ts:98`
- `src/domains/xmtp/middleware/logging.ts:8`
- `src/bootstrap/init-xmtp-install.ts:38`

**现状**：`src/index.ts:35-40` 定义了 `pluginLogger` / `getLogger` 抽象，但 domain 代码全部直写 `console.*`。

**为什么是问题**：
- 插件宿主（OpenClaw gateway）要统一收集日志时，这些 `console.*` 绕过宿主管道。
- 换 logger（比如换 pino / winston）要改一大堆文件。

**建议方向**：在需要日志的模块里从 `./logger` 引入 `getLogger()`；或在模块顶层注入 logger 作为参数。

**决策:**

---

### P3-2 `src/index.ts:44` 残留的调试 `console.log`

**定位**：`src/index.ts:44`（注释标记 `TODO: 发布前删除`）。

**现状**：模块顶层有一个探针 `console.log`，之前调试用，注释承诺会删未删。

**建议方向**：直接删。

**决策:**

---

### P3-3 `index.ts:224` 中途的 `console.log`

**现状**：`registerFull` 里某一步直接 `console.log`，未走 logger。

**建议方向**：走 logger。

**决策:**

---

## P4 硬编码值

### P4-1 `"alice"` 默认账户散落多处

**定位**：
- `src/index.ts:55`（zod schema 默认值）
- `src/bootstrap/init-xmtp-install.ts:35`
- 两个 demo 脚本

**为什么是问题**：项目要上线前必须清掉"alice"；散落越多越容易漏。

**建议方向**：
- 配置必填，无默认值（zod schema `z.string().min(1)`）；
- 让 `init-xmtp-install` 从配置拿，取不到就 throw。

**决策:**

---

### P4-2 文件/目录字面量散落

**定位**：
- `src/bootstrap/init-xmtp-install.ts:36, 68-69`（`"data"`, `"daemon.pid.json"`, `"watermarks.json"`）
- `src/domains/xmtp/xmtp.ts:56`（`xmtp-${inboxId}.db3`）

**建议方向**：抽到 `src/constants.ts` 或每个模块顶部常量。

**决策:**

---

### P4-3 敏感词词典硬编码

**定位**：`src/domains/security/sensitive-word-guard.ts:7` `DEFAULT_SENSITIVE_WORDS = ["sb", "傻逼"]`；`:44-47` 中文 BLOCK/PASS 文案硬编码。

**现状**：TODO 承认后端词典接口未接入；文案未 i18n。

**建议方向**：
- 词典至少移到 `config/sensitive-words.json`；上线前接后端接口。
- 文案抽到 i18n 字典。

**决策:**

---

### P4-4 长度限制不统一

**定位**：`src/domains/security/filter.ts:24`（`maxLength ?? 8_000`）与 `src/domains/security/prompt-sandbox.ts:30`（`maxLen ?? 4_000`）

**为什么是问题**：两个相邻模块里的"最大长度"一个 8000 一个 4000，没文档说明为什么差一倍。

**建议方向**：抽到 `constants.ts`；各自需要不同值就显式说明。

**决策:**

---

### P4-5 其他字面量

- `src/domains/daemon/conversation-tracker.ts:48` idle 超时 `10 * 60 * 1000` 未命名。
- `src/domains/xmtp/middleware/llm-presentation.ts:39-46` `SCHEMA_TEXT` 大段中文模板嵌在 TS 里。
- `src/domains/xmtp/render-for-llm.ts` 硬编码 `identity: "unverified"`，没有提升为 verified 的路径。

**建议方向**：命名常量 + 把 SCHEMA_TEXT 挪到资源文件；identity 增加 resolver 入口。

**决策:**

---

## P5 类型安全

### P5-1 中间件靠 `(ctx.message as any).__xxx` 挂 sideband 字段

**定位**：
- `src/domains/security/prompt-sandbox.ts:42-43`
- `src/domains/xmtp/middleware/structured-envelope.ts:24-27`
- `src/domains/xmtp/middleware/unicode-normalize.ts:31-32`
- `src/domains/xmtp/middleware/llm-presentation.ts:108-109`
- `src/domains/xmtp/middleware/injection-detect.ts:95-96`

**现状**：多个中间件向 `ctx.message` 挂 `__metadata` / `__injectionFlags` / `__sandboxed` 等；在 `structured-envelope.ts:14-18` 做了一个 `declare module` 尝试增广，但**其中 `interface MessageContext {}` 是空对象**，等于没做增广。

**为什么是问题**：TypeScript 完全失去对这些字段的感知；类型安全退化到 JS。

**建议方向**：
- 用独立的 `WeakMap<Message, Metadata>` 代替 in-place 挂字段；或
- 正确填充 module augmentation（声明实际字段）；或
- 把这些派生数据收到一个 `ctx.state` 对象里。

**决策:**

---

### P5-2 工具定义全用 `any`

见 P1-1（同一根因），已在安全红线列。

---

### P5-3 `index.ts` 多处 `as any`

**定位**：
- `src/index.ts:58-59`（`cfg as any` 钻外层 `channels["a2a-xmtp"].config`）
- `src/index.ts:210-211`（`const entry: any = defineChannelPluginEntry(...)`）

**建议方向**：外层信封也写一个 zod schema；`entry` 用 SDK 的具体类型。

**决策:**

---

### P5-4 其他类型假设

- `src/domains/onchainos/onchainos.ts:124` `as Identifier` 绕开枚举。
- `src/domains/xmtp/xmtp.ts:125` `hexToBytes(value as 0x${string})` 未先校验。
- `src/routing/peer-id.ts:34` 同 P1-4。

**决策:**

---

## P6 性能

### P6-1 无界缓存

**定位**：
- `src/domains/xmtp/messaging.ts:12` `groupCache = new Map<string, Group>()` 无淘汰。
- `src/domains/xmtp/middleware/llm-presentation.ts:79` `InboxEthAddressCache` 无大小/TTL；**负结果（RPC 失败）被永久缓存**（见 G-6）。

**为什么是问题**：长期运行 daemon 场景下内存只增不减；负缓存会导致瞬态 RPC 失败永久标记失败。

**建议方向**：LRU（lru-cache 或手写）+ TTL；负结果用更短 TTL。

**决策:**

---

### P6-2 `messaging.getOrOpenGroup` 每次 miss 都做重 RPC + 线性查找

**定位**：`src/domains/xmtp/messaging.ts:26-39`

**现状**：`groupCache` miss → `conversations.sync()` + `listGroups()` + `.find(g => g.name === groupName)` 线性扫描全部群。

**建议方向**：
- 按 group id 建索引，用 name→id 的二级映射。
- `conversations.sync()` 只在首次或 stale 时触发，不是每次 miss。

**决策:**

---

### P6-3 `messaging.getPendingMessages` 串行 + 无上限

**定位**：`src/domains/xmtp/messaging.ts:97-112`

**现状**：遍历所有 group，逐个 `group.sync()` + `group.messages()`，完全串行。

**建议方向**：若此方法仍保留（见 P2-5），改用 `Promise.all` 且加并发上限（比如 p-limit）。

**决策:**

---

### P6-4 `findDaemonForConversation` O(n) 扫描 + 双次 `getConversationById`

**定位**：`src/routing/get-pending-list-tool.ts`

**现状**：
- 工具入口对每次调用线性扫所有 daemon 找谁拥有该 conversation。
- 先在 `findDaemonForConversation` 内调一次 `getConversationById`，命中后主流程又调一次。

**建议方向**：
- 建 `conversationId → daemon` 的反向索引（在 install 时注册即可）。
- 把 `getConversationById` 的结果从 find 函数返回，避免第二次。

**决策:**

---

### P6-5 `conversation-tracker` 链式 promise 无界增长

**定位**：`src/domains/daemon/conversation-tracker.ts:75-80`

**现状**：同一会话的消息持续到达，`existing.chain = existing.chain.then(...)` 无界追加；即使已 resolve 的 promise 在链保留期间依然可达。

**建议方向**：改成"当前 handler 完成后置空 chain"的模式；或引入 queue + worker。

**决策:**

---

### P6-6 注入检测正则数量 + 回溯风险

**定位**：`src/domains/xmtp/middleware/injection-detect.ts:67-73`（执行处）、`:22-65`（规则定义）

**现状**：~30 条正则线性 `.test()`，部分模式（如 `role-hijack-zh`）使用 `[^\s]{2,10}`，存在回溯风险。

**建议方向**：
- 合并成少量 regex（用 `|` 联合）。
- 或者用 Aho-Corasick 替代 regex（纯关键词匹配部分）。
- 逐条加单元测试确认性能与命中率。

**决策:**

---

## P7 错误处理

### P7-1 `init-xmtp-install.ts` 无 try/catch → 一个 install 失败中断整轮

**定位**：`src/bootstrap/init-xmtp-install.ts`

**现状**：`client.connect()` / `daemon.start()` 任何一个 throw 都会冒泡出去，后续 install 永远不执行；且已启动的 install 没有 rollback。

**建议方向**：用 `Promise.allSettled` 或显式 try/catch 包每个 install，失败 install 记录告警但不影响其他，并且尝试 stop 已启动的部分。

**决策:**

---

### P7-2 `close-conversation-tool` 命中第一个 daemon 就 break

**定位**：`src/routing/close-conversation-tool.ts:45-60`

**现状**：多 daemon 场景下，taskId 冲突只会释放第一个命中，其余 daemon 的 seat 永远不释放且无日志。

**建议方向**：
- 明确"taskId 全局唯一"作为契约（在 install 时检查冲突），或
- 改成遍历所有匹配的 daemon 全部释放。

**决策:**

---

### P7-3 `parseStructured` 空 catch 静默回退

**定位**：`src/domains/xmtp/messaging.ts:82-92`

**现状**：
```ts
try { return JSON.parse(raw) } catch {}
return { text: raw }
```
空 catch 吞掉错误，malformed JSON 就当普通文本。

**建议方向**：至少 `logger.debug('parseStructured failed', err)`；若 `raw.startsWith("{")` 为真却解析失败，应 warn 级别。

**决策:**

---

### P7-4 `llm-presentation.InboxEthAddressCache.resolve` 错误永久缓存空串

**定位**：`src/domains/xmtp/middleware/llm-presentation.ts:93-96`

**现状**：catch 所有错误 → 缓存空字符串 → 同一 inboxId 之后永远解析为空。

**影响**：瞬态 RPC 抖动导致某用户地址永久丢失。

**建议方向**：catch 分支不写缓存；或只缓存短 TTL；或区分"已知不存在"和"解析失败"两种 state。

**决策:**

---

### P7-5 其他静默 catch

- `src/domains/xmtp/xmtp.ts:96-100` `readdirSync` 失败 → 返回 `false`；权限错误和"从未初始化"不可区分。
- `src/domains/xmtp/middleware/llm-presentation.ts:117-123` identityResolver 错误 `/* keep default */` 静默。
- `src/domains/daemon/daemon.ts:134` `agent.errors.use` 的 `next()` 吞 middleware 异常（这是我们故意为之，用于避免 SDK 自关停，见 WORKAROUNDS.md）— 但需要在 logger 留痕 + 计数，便于监控"吞了多少次异常"。

**决策:**

---

### P7-6 `watermark-store` schema mismatch 直接 throw，无迁移路径

**定位**：`src/domains/daemon/watermark-store.ts`

**现状**：`SCHEMA_VERSION=1`；未来 bump 到 2 时，老用户的 `watermarks.json` 会导致 daemon 启动失败。

**建议方向**：加一个极简的 `migrate(version, raw) → newRaw` 管线；或在首次读到不匹配版本时备份旧文件 + 从 0 开始。

**决策:**

---

## P8 可维护性 / 重复定义

### I-1 `QueueConfig` 三份定义

**定位**：
- `src/types.ts`（`QueueConfig` with `maxConcurrentChats`）
- `src/domains/daemon/queue.ts:1-3`（独立 `QueueConfig`，字段不同）
- `src/domains/daemon/conversation-tracker.ts` 的 `ConversationTrackerConfig`（`maxConcurrent`）

**建议方向**：
- 删 `queue.ts`（P2-1）后剩两份，合并成一份。
- `types.ts` 保留权威定义，tracker 的专用扩展去 extend 它。

**决策:**

---

### I-2 会话 key 构造逻辑重复

**定位**：
- `src/domains/daemon/conversation-tracker.ts:51-53` `keyOf(taskId, peer) → ${taskId}::${peer.toLowerCase()}`
- `src/domains/xmtp/messaging.ts:16-18` 同样构造
- `src/routing/peer-id.ts` 另一种编码 `0xADDR?taskId=xxx`

**建议方向**：抽 `src/routing/keys.ts`，统一 `conversationKey(taskId, peer)` 与 `decodePeerId`。

**决策:**

---

### I-3 demo 脚本重复工具函数

**定位**：`src/bootstrap/xmtp-group-demo.ts` 与 `xmtp-sensitive-word-demo.ts` 各自定义 `log` / `separator` / `sleep`。

**建议方向**：若保留 demo（见 P2-2），抽 `shared.ts`；若删则一起删。

**决策:**

---

### I-4 `xmtp.ts` 自写 `.env` 解析

**定位**：`src/domains/xmtp/xmtp.ts:109-130`

**现状**：自己实现 `parseEnv`，未处理引号、转义、多行、注释。

**建议方向**：用 `dotenv`（已是 Node 生态事实标准），或直接依赖 `process.env`（宿主已注入）。

**决策:**

---

### I-5 `parseStructured` 用 `startsWith("{")` 判 JSON

**定位**：`src/domains/xmtp/messaging.ts:82`

**现状**：首字符判断，首空白或数组 `[` 都会漏掉。

**建议方向**：`try { JSON.parse } catch`（已经有 try 了，直接去掉 startsWith 的前置判断即可）。

**决策:**

---

### I-6 `conversation-tracker` 链式 promise 返回值 vs 存储值

**定位**：`src/domains/daemon/conversation-tracker.ts:75-80`

**现状**：先给 `existing.chain` 赋值再 `return existing.chain`；虽然 JS 的赋值语义让两者最终一致，但表达不清晰，维护时容易被重构成错位一拍的版本。

**建议方向**：
```ts
const next = existing.chain.then(...);
existing.chain = next;
return next;
```

**决策:**

---

### I-7 `daemon.ts` 已 360+ 行，单文件继续增长

**建议方向**：拆成 `daemon-lifecycle.ts`（start/stop/signal）、`daemon-pidfile.ts`、`daemon-middleware-setup.ts` 等；但这是后置优化，不紧急。

**决策:**

---

### I-8 `index.ts` 的 `_runtimeRefKeepalive` workaround

**定位**：`src/index.ts`（已在 WORKAROUNDS.md 里记录过）

**现状**：为防止 GC 回收某个 runtime 引用，故意保一个模块级变量。

**建议方向**：定位真实持有者，把引用绑在生命周期对象上（比如 `daemonService` 内）；把 workaround 删掉。

**决策:**

---

### I-9 `daemon.ts` SIGINT/SIGTERM 与 `service.stop` 重叠

**定位**：`src/domains/daemon/daemon.ts` 的 `start()` 末尾

**现状**：既注册进程信号，又实现 `stop()` 供宿主 `service.stop` 调用 → 两条停机路径。

**建议方向**：留一条 — 如果 daemon 由宿主生命周期管理（现在是），删信号 handler；如果独立进程模式要保留，至少加上幂等保护（已有 `this.stopping` promise 保护，基本 OK，但概念上仍然杂糅）。

**决策:**

---

## P9 其他注意项（非 bug，但值得意识到）

- **render-for-llm 的 `identity: "unverified"` 永远不变** — 表示现在还没验证路径接入，是否阻塞上线？
- **`llm-presentation.SCHEMA_TEXT` 大段中文** — 非英语环境/模型可能表现不佳；需要时可切到英文。
- **`injection-detect` 的正则命中可能误伤** — 如 `/role-hijack-zh/` 可能匹配 "你是好人" 这类正常问候；需评估误伤率。
- **测试覆盖** — `test/` 目录里 14 个测试在之前的 session 里被确认预先失败（`ctx.isGroup is not a function`），不是我们引入的；但仍然是一个技术债。

---

## 汇总决策模板

> 建议你把每项的 `决策:` 填成 `修 / 延后 / 不改 / 讨论` 四选一；我会按填好的表逐项执行。
