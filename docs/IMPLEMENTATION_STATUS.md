# 实现现状与关键决策记录

> 本文档记录截至 2026-04-10 的实际实现状态、与原始设计的偏差、架构决策和关键上下文。
> 下一个 agent 接手前**必须通读**本文，再看 `TODO.md`。

---

## 一、当前实现状态（Phase 完成情况）

| Phase | 标题 | 状态 | 验收脚本 |
|-------|------|------|---------|
| 1 | 项目脚手架 & 测试钱包 | ✅ 完成 | `scripts/gen-wallets.ts` |
| 2 | XMTP 连接 & 身份注册 | ✅ 完成 | `scripts/test-connect.ts` / `scripts/debug-connect.ts` |
| 3 | Group 消息收发 | ✅ 完成 | `scripts/test-dm.ts` / `scripts/test-dm-structured.ts` |
| 4 | MessageDaemon 守护进程 | ✅ 完成 | `scripts/test-daemon.ts` |
| 5 | SessionQueue 并发队列 | ✅ 完成 | `scripts/test-queue.ts` + `test/queue.test.ts` |
| 6 | 安全层（filter + sandbox） | ✅ 完成 | `test/security.test.ts` + `test/filter.edge.test.ts` + `test/sandbox.edge.test.ts` |
| 7 | HTTP Bridge + CLI | ⛔ **已删除**（见下方架构决策） | — |
| 8 | E2E 集成测试 | 🔜 未开始 | — |

---

## 二、与原始 Roadmap 的重要偏差

### 2.1 HTTP Bridge / CLI 已删除

**原计划**：`src/bridge.ts`（HTTP 服务器）+ `src/cli.ts`（独立进程入口），让 OpenClaw 通过 HTTP 调用 daemon。

**实际决策**：通过阅读现有 OpenClaw extension（`~/.openclaw/extensions/openclaw-weixin/`）代码，确认 OpenClaw extension 是 **in-process 库**，与 daemon 同进程。HTTP bridge 没有必要，已删除。

**影响**：
- `src/bridge.ts` — 已删除
- `src/cli.ts` — 已删除
- `test/bridge.test.ts` — 已删除
- `src/index.ts` 中 BridgeServer 的 export — 已删除

### 2.2 ACPEnvelope / ActionType 类型已删除

**原计划**：`src/types.ts` 中定义 `ACPEnvelope`、`ActionType` enum（任务协议消息格式）。

**实际决策**：任务协议格式尚未由任务系统团队确定，提前定义会形成误导性约束，全部移除。当前 `src/types.ts` 只保留配置相关类型。

### 2.3 Group 命名规则变更：复合 key

**原计划**：`groupName = taskId`

**实际实现**：`groupName = "${taskId}::${peerAddress.toLowerCase()}"`

**原因**：在同一个 task 中，与不同 peer 的对话需要各自独立的 Group。单用 taskId 无法区分。`::` 作为分隔符（taskId 中不允许出现 `::`），peerAddress 统一小写防止大小写不一致。

**影响**：
- `MessagingToolkit.getOrOpenGroup()` 使用复合 key 作为 cache key 和 groupName
- `daemon.listGroups()` 解析 `::` 分隔符，`GroupInfo` 拆分成 `taskId` + `peerAddress` 两个字段
- `GroupListOptions.sortBy` 中 `"name"` 改为 `"taskId"`

### 2.4 OnMessageCallback 签名变更：接收 SandboxedMessage

**原计划**：`onMessage: (ctx: MessageContext, groupId: string) => void`

**实际实现**：`onMessage: (msg: SandboxedMessage, groupId: string) => void`

**原因**：OpenClaw gateway 是外部不可信代码，不应暴露原始 `MessageContext`（包含完整 conversation 对象、未截断 content 等）。SandboxedMessage 是经过截断和字段提取的最小安全集合。

**SandboxedMessage 字段**：
```typescript
interface SandboxedMessage {
  content: string;        // 截断后的文本（最长 4000 字符）
  senderInboxId: string;  // 发送方 XMTP inbox ID
  conversationId: string; // Group ID（XMTP 内部）
  sentAt: Date;           // 消息时间
}
```

### 2.5 SessionQueue 改为泛型

**原计划**：`SessionQueue` 绑定 `MessageContext` 类型。

**实际实现**：`SessionQueue<T>` 泛型，daemon 中实例化为 `SessionQueue<SandboxedMessage>`。

**原因**：解耦对 XMTP 类型的依赖，使 queue 可独立测试（无需 mock XMTP）。

---

## 三、OpenClaw Extension 架构（重要新信息）

通过阅读 `~/.openclaw/extensions/openclaw-weixin/` 源码，确认 OpenClaw extension 的工作模型：

```
OpenClaw 加载 extension（in-process, not subprocess）
  │
  ├── register(api: OpenClawPluginApi)
  │     └── api.runtime 注入：
  │           - api.runtime.channel.dispatchInbound(msgContext)  ← 向 OpenClaw 推入站消息
  │           - api.runtime.channel.replyFromConfig()
  │           - api.runtime.channel.media.saveMediaBuffer()
  │
  ├── ChannelPlugin.gateway.startAccount(ctx: ChannelGatewayContext)
  │     → 启动 MessageDaemon
  │     → onMessage: (msg: SandboxedMessage) =>
  │           ctx.runtime.channel.dispatchInbound(toXmtpMsgContext(msg))
  │
  └── ChannelPlugin.outbound.sendText(ctx: OutboundContext)
        → daemon.sendMessage(taskId, encodeText(ctx.text), peerAddress)
```

**入站 MsgContext 需要的字段**（参考 weixin 实现）：
```typescript
interface XmtpMsgContext {
  Body: string;                    // msg.content
  From: string;                    // msg.senderInboxId
  To: string;                      // taskId 或 conversationId
  AccountId: string;               // agent 钱包地址
  OriginatingChannel: string;      // "openclaw-xmtp"
  MessageSid: string;              // 唯一消息标识
  Timestamp: number;               // ms
  Provider: string;                // "openclaw-xmtp"
  ChatType: "direct" | "group";
}
```

**待实现**：`src/adapter.ts`（SandboxedMessage → XmtpMsgContext 的映射），以及 extension 入口 `index.ts`（ChannelPlugin 注册），由 OpenClaw extension 负责人实现。

---

## 四、当前文件结构（实际状态）

```
src/
├── index.ts           # 公共入口，re-export 所有核心类型和类
├── types.ts           # 配置类型（PluginConfig, QueueConfig, AgentWallet, TestWallets）
├── daemon.ts          # MessageDaemon（核心守护进程）
├── messaging.ts       # MessagingToolkit（XMTP Group 收发）
├── queue.ts           # SessionQueue<T>（泛型并发队列）
├── filter.ts          # ContentFilter（内容过滤，blocklist + maxLength）
├── prompt-sandbox.ts  # sandboxMessage()（沙箱隔离）
├── recovery.ts        # RecoveryManager（离线消息恢复，48h 窗口）
└── middleware/
    └── logging.ts     # loggingMiddleware（XMTP agent 中间件）

test/
├── queue.test.ts       # SessionQueue 基础单元测试
├── queue.edge.test.ts  # SessionQueue 边界场景
├── security.test.ts    # ContentFilter + sandboxMessage 基础测试
├── filter.edge.test.ts # ContentFilter 边界场景（子串匹配行为文档化）
└── sandbox.edge.test.ts # sandboxMessage 边界场景

scripts/
├── helpers/wallet.ts          # 钱包加载 & Signer 创建工具
├── gen-wallets.ts             # 生成测试钱包
├── debug-connect.ts           # XMTP 连接逐步调试脚本
├── test-connect.ts            # Phase 2 验收
├── test-dm.ts                 # Phase 3 验收（Group 消息）
├── test-dm-structured.ts      # Phase 3 验收（结构化 JSON 消息）
├── test-daemon.ts             # Phase 4 验收（守护进程 + 离线恢复）
└── test-queue.ts              # Phase 5 验收（集成场景）

docs/
├── DESIGN.md                  # 原始技术设计文档 v4（部分内容已过时，见本文）
├── DEVELOPMENT_ROAD.md        # 开发 Roadmap（Phase 1-8，部分已过时，见本文）
├── LARK_CONTEXT.md            # 飞书原始需求文档汇编
├── MERMAID-DIAGRAMS.md        # 架构时序图
├── WORKAROUNDS.md             # 临时绕过：Nix 编译的 .node 二进制路径问题
└── IMPLEMENTATION_STATUS.md   # ← 本文（最新实现状态）

TODO.md                        # 已知 bug、外部依赖缺口、设计待确认事项
```

---

## 五、关键运行时行为

### 消息处理管道（daemon 收到消息时）

```
XMTP stream → agent.on("message")
  → messageCount++
  → recovery.markProcessed()
  → sandboxMessage()              # 提取 SandboxedMessage，非文本→"[non-text]"，超长截断
  → ContentFilter.check()         # blocklist + maxLength 检查
      → denied: log + drop
      → allowed: SessionQueue.enqueue(conversationId, sandboxedMsg, onMessage)
                   → per-taskId 串行 + 跨 task 并发（max = config.queue.maxConcurrentChats）
```

### Group 索引规则

- `groupName = "${taskId}::${peerAddress.toLowerCase()}"`
- cache key = groupName
- `listGroups()` 过滤 name 中不含 `::` 的 group（非本 SDK 创建）
- `GroupInfo.taskId` + `GroupInfo.peerAddress` 由 name 解析得出

### 离线消息恢复（daemon.start() 时）

1. `conversations.sync()` 拉取所有 group
2. 每个 group 读取近 48h 消息（`sentAfterNs`）
3. 从 `data/daemon-state.json` 读 `lastMessageId` 水位
4. 跳过水位之前的消息，跳过自身发送的消息
5. ⚠️ 已知问题：若 `lastMessageId` 超出 48h 窗口，离线消息会被静默跳过（见 TODO.md）

---

## 六、本地开发快速启动

```bash
# 安装依赖（postinstall 自动 patch XMTP 二进制，见 docs/WORKAROUNDS.md）
pnpm install

# 类型检查
pnpm typecheck

# 单元测试（不需要网络）
pnpm test

# 生成测试钱包（首次，幂等）
npx tsx scripts/gen-wallets.ts

# 验收 Phase 2（需要 XMTP dev 网络）
npx tsx scripts/test-connect.ts

# 验收 Phase 4（需要两个 Agent + XMTP dev 网络）
npx tsx scripts/test-daemon.ts
```

---

## 七、下一步工作建议

1. **E2E 测试（Phase 8）**：跑 `scripts/test-daemon.ts` 验证完整链路，需要稳定的 XMTP dev 网络和两个测试钱包。

2. **Recovery Bug 修复**：`lastMessageId` 超出 48h 窗口时所有离线消息被跳过（见 TODO.md）。

3. **getOrOpenGroup 竞态修复**：并发调用可能创建重复 Group（见 TODO.md）。

4. **daemon.start() 幂等守卫**：第二次调用会注册重复事件监听器（见 TODO.md）。

5. **自身消息过滤确认**：`agent.on("message")` 是否已排除自发消息，需查 `@xmtp/agent-sdk` 实现（见 TODO.md）。

6. **OpenClaw 适配层**（由 extension 负责人实现）：`src/adapter.ts` + extension `index.ts`，将本 SDK 包装成 ChannelPlugin。
