# MIGRATION.md

> 本文档为本仓库上传 GitHub 与同事其他模块合并前的"已知信息全集 + 开发细节快照"。
> 时间戳：2026-04-19。后接手者请从本文起读，再看 `IMPLEMENTATION_STATUS.md` / `REVIEW_CHECKLIST.md`。
>
> 本文档与既有 docs 的关系：
> - `DESIGN.md` / `IMPLEMENTATION_STATUS.md` 是历史快照（截至 2026-04-10）
> - `MIGRATION.md`（本文）记录 2026-04-10 之后的关键决策、SDK 调研结论与未完成事项
> - 若两者冲突，**以本文档为准**

---

## 0. 项目定位

**a2a-xmtp** 是一个 OpenClaw extension（in-process 库，与 host 同进程），把 XMTP 网络作为 A2A（Agent-to-Agent）通讯通道接入 OpenClaw。

- 入口：`src/index.ts`（`registerFull(api)` + `setRuntime`）
- 与 host 集成方式：通过 OpenClaw plugin SDK 的 `api.registerService` / `api.registerTool`，**无 HTTP bridge / 独立进程**
- 多账户：所有 onchainos 账户**无条件**建立 XMTP daemon（详见 §3.1）
- LLM 与 peer 的对话单元：**task**（taskId 作为业务侧主键，对应一组 XMTP group）

---

## 1. 顶层架构与术语

```
┌────────────────────────────────────────────────────────────────┐
│  OpenClaw host (main session)                                  │
│   └─ LLM (主对话)                                              │
│       ├─ tool: xmtp_send                  → 拉起 subagent 沟通 │
│       ├─ tool: xmtp_get_pending_list      → 拉新消息(自动 ack) │
│       └─ tool: xmtp_close_conversation    → 主动关闭席位        │
│                                                                │
│  OpenClaw subagent (a2a 谈判分身, 由 xmtp_send 触发 spawn)     │
│   └─ LLM                                                       │
│       ├─ tool: xmtp_send                  → 续发后续消息        │
│       ├─ tool: xmtp_get_pending_list      → 主动 PULL           │
│       └─ tool: xmtp_close_conversation                         │
│                                                                │
│  a2a-xmtp daemon (per onchainos account)                       │
│   ├─ XMTP @xmtp/agent-sdk middleware chain                     │
│   ├─ ConversationTracker (γ-语义席位管理)                       │
│   ├─ WatermarkStore (per-conversation BigInt ns)                │
│   ├─ ContentFilter (敏感词)                                     │
│   └─ MessagingToolkit (sendStructured)                          │
└────────────────────────────────────────────────────────────────┘
```

### 1.1 关键术语

| 术语 | 含义 |
|------|------|
| **task** | 业务侧"一次合作意图"，由 LLM 在 OpenClaw 中创建，得到 `taskId` |
| **peer** | 对手方 XMTP 钱包地址（小写），在 task 内最多同时活跃 `maxConcurrentPerTask` 个（默认 1） |
| **group** | XMTP 群（DM 也是 group），命名规则：`${taskId}::${peerAddress.toLowerCase()}` |
| **conversation_id** | XMTP `group.id`，稳定标识 |
| **席位 (seat)** | task 内对某 peer 的"已锁定回复对象"标记，由 ConversationTracker 管理 |
| **subagent** | OpenClaw 内置的 push-based 分身机制，**不是** "subsession" |
| **main session** | 用户与 LLM 直接交互的会话；非 subagent 的会话 |

### 1.2 conversation 命名约束

- group.name = `${taskId}::${peerAddress.toLowerCase()}`
- `::` 是分隔符，taskId 中**禁止**出现 `::`
- peerAddress 强制小写（避免大小写导致重复 group）

---

## 2. 已确认的架构决策（2026-04 增量）

### 2.1 PULL 模型 + 在线 push-reject（混合）

- **入站消息不主动推 LLM**。XMTP SDK 把消息持久化在 SQLite，daemon 中间件链只做：日志 / 解封装 / unicode 归一 / 注入检测 / 敏感词守卫 / LLM 呈现 / tracker 通知。
- LLM 通过 `xmtp_get_pending_list` 主动 PULL；返回时**自动推进 watermark**（LLM 不感知 ack 概念）。
- **唯一例外**：敏感词命中时 daemon 立即在群内回复警告（`replyOnBlock: true`），算"在线 push-reject"，但**不**触达 LLM。

**理由**：subagent 与 daemon 同进程；LLM crash 通常 daemon 也跟着崩；daemon 崩之前 watermark 已 sync 落盘。"已 PULL 但未消费"窗口的丢消息风险可接受。

### 2.2 γ-语义席位（ConversationTracker）

文件：`src/domains/daemon/conversation-tracker.ts`

- **席位粒度**：按 `taskId` 分桶，每桶最多 `maxConcurrentPerTask` 个活跃 peer（默认 1）
- **占用时点**：LLM 发出**首次回复**时（由 `daemon.sendMessage` 调 `tryAcquire`）
  → 即"daemon 收到消息"本身**不**占席位；LLM 拉取后决定回复才占
- **释放**：`xmtp_close_conversation` 主动 / `idle` 超时 / `response-timeout` 超时
- **两类超时**（默认均 10 min）：
  - `idleTimeoutMs`：双方都沉默
  - `responseTimeoutMs`：peer 已发新 inbound 但 LLM 超时未回
- **幂等性**：同 (task, peer) 重复 `tryAcquire` 返回 true 并刷新 idle timer
- **CloseReason**：`"manual" | "idle" | "response-timeout"`

### 2.3 双发可接受

主流程：main → `xmtp_send` → 触发 subagent spawn → subagent 续发；
若 subagent 在 spawn 后误将"首条消息"再发一次，导致 XMTP 双发，**视为可接受**，不算异常。

实现侧：subagent 的 `xmtp_send` 不做去重（不引入额外 dedup 状态）。

### 2.4 LLM-facing 文本一律英文

所有注入到 LLM 上下文的文本（tool description / parameter description / extraSystemPrompt / 错误回执）**必须英文**。
中文只用于：
- 内部代码注释
- 面向开发者的 docs（如本文档）
- 终端日志

### 2.5 账户过滤已移除

旧逻辑：判断 `XmtpClient.hasBeenInitialized` 决定连不连。
新逻辑：onchainos 拉到的所有账户**无条件**建立 XMTP 连接。
- 见 `src/bootstrap/init-xmtp-install.ts`
- `XmtpClient.hasBeenInitialized` 暂保留为 dead code（未删，便于回退）

### 2.6 dataDir 一致性不变量

`ensureStartupInit` 决定 dataDir 优先级：
`user.dbBaseDir > resolvedDataDir > hostStateDir > EXTENSION_ROOT/data`

**关键**：daemon 启动后，**不允许**再用 fallback 路径加载 watermark — 否则会读到空 watermark 导致历史消息全量重放。

---

## 3. Tool 全集（注册状态 / 参数 / 行为）

### 3.1 已注册 ✅

| Tool 名 | 文件 | 用途 | 触发场景 |
|---------|------|------|---------|
| `xmtp_close_conversation` | `src/routing/close-conversation-tool.ts` | 关闭席位 | LLM 主动结束 |
| `xmtp_get_pending_list` | `src/routing/get-pending-list-tool.ts` | PULL 新消息 | LLM 主动拉 |
| `xmtp_send` | `src/routing/send-tool.ts` | 发送消息 + 拉起 subagent | LLM 主动发 |

### 3.2 `xmtp_send` 实现要点（NEW，本会话新增）

文件：`src/routing/send-tool.ts`

- **签名**：
  ```ts
  buildSendTool(
    getDaemons: () => Iterable<DaemonForSend>,
    getRuntime: () => PluginRuntime | null
  )
  ```
- **参数**：
  ```ts
  {
    content?: string;          // 等价于 text
    contentType?: "text";      // 当前仅支持 text
    payload: {
      peerAddress: string;     // 0x-prefixed
      taskId: string;
      [k: string]: unknown;    // 业务侧扩展字段
    };
  }
  ```
- **校验**：`contentType === "text"` / `peerAddress` 0x 前缀 / `taskId` 必填
- **envelope**：`text = content ?? ""`，`metadata = payload \ {peerAddress, taskId}`
- **branch 检测**：`isSubagentSessionKey(ctx.sessionKey)`
  - import 路径：`openclaw/plugin-sdk/routing`（**不是** `/core`，core 不 re-export）
- **main 分支**：
  1. `tracker.tryAcquire(taskId, peerAddress)` → 若返回 false，向 LLM 返回 "seat occupied" 文本
  2. `daemon.getMessaging().sendStructured(...)` 发首条
  3. `buildAgentSessionKey({ agentId: ctx.agentId ?? "main", channel: "a2a-xmtp", accountId: ctx.agentAccountId ?? null, peer: { kind: "direct", id: encodePeerId(peerAddress, { taskId }) }, dmScope: "per-account-channel-peer" })`
  4. `runtime.subagent.run({ sessionKey, deliver: false, idempotencyKey, extraSystemPrompt })` 拉起谈判 subagent
- **sub 分支**：
  1. `tracker.tryAcquire(...)`（幂等，重置 idle timer）
  2. `daemon.getMessaging().sendStructured(...)` 续发
  3. **不**再调 `subagent.run`
- **idempotencyKey**：
  ```
  xmtp_send:${taskId}:${peer}:${sha256(content + stableStringify(payload)).slice(0,16)}
  ```
  使用 **stableStringify**（key 排序），保证同 logical payload 跨调用产生相同 key。
- **extraSystemPrompt**（英文）：描述 a2a 谈判 subagent 角色 + 可用 tools (xmtp_get_pending_list, xmtp_send, xmtp_close_conversation) + "wait for reply, do not echo"

### 3.3 待重构 / 待新增（未完成）

#### 3.3.1 `xmtp_get_pending_list`（重构）
- **当前**：`{ conversation_id, max_messages? }` 单 conv 拉取
- **目标**：`{ xmtpAddress: string, taskId: string }`（**移除** `since` / `limit`）
  - 通过 `daemon.getAgent().address === xmtpAddress` 找 daemon
  - list 该 daemon 下所有 group.name 以 `${taskId}::` 开头者
  - **按 conversation 分组**返回
  - 信誉打分排序：暂跳过

#### 3.3.2 `xmtp_close_conversation`（重构）
- **当前**：`{ taskId, peerAddress }` 均必填，`ctx: any`
- **目标**：
  - sub 分支：**无参**（从 sessionKey 解析 taskId/peer）
  - main 分支：`{ agentId?: string, taskId?: string }`
- **附带 cleanup**：清 groupCache / 调 `runtime.subagent.deleteSession` / 重构 `recovery.taskGroupMap` 支持「单 task 多 peer」

#### 3.3.3 `xmtp_report_to_parent`（新增 / Path R2）
- 由 subagent 调用，把谈判结果回传 main session
- 实现：`runtime.subagent.run({ sessionKey: parentSessionKey, deliver: true })`
- 触发时机的开放问题见 §6

---

## 4. OpenClaw SDK 集成关键发现

### 4.1 PluginRuntime.subagent API（Path A，已选）

```ts
runtime.subagent.run({
  sessionKey: childSessionKey,    // 通过 buildAgentSessionKey 构造
  deliver: false | true,          // false=首次拉起，true=回传父
  idempotencyKey: string,         // 防 retry 双发
  extraSystemPrompt?: string,
})
runtime.subagent.waitForRun(...)
runtime.subagent.getSessionMessages(...)
runtime.subagent.deleteSession(...)
```

### 4.2 Path B：`spawnSubagentDirect`（未选）

- 文件：`openclaw/dist/plugin-sdk/src/agents/subagent-spawn.d.ts`
- 内部 API，参数更丰富（`mode: "run"|"session"` / `cleanup` / `attachments` / 返回 `childSessionKey`）
- **唯一**触发 push-based auto-announce 的路径（见 4.4）
- 当前用 PluginRuntime.subagent.run，所以 subagent → main 的回传**不会自动**发生，需要靠 `xmtp_report_to_parent`（Path R2）显式触发

### 4.3 Tool ctx：`OpenClawPluginToolContext`

字段（用到的）：
- `sessionKey: string`
- `agentId?: string`
- `agentAccountId?: string`

判分支：`isSubagentSessionKey(ctx.sessionKey)`（from `openclaw/plugin-sdk/routing`）
深度：`getSubagentDepth(ctx.sessionKey)`
解析：`parseAgentSessionKey(ctx.sessionKey)`

### 4.4 Push-based auto-announce 存在但条件受限

- 文件：`openclaw/dist/plugin-sdk/src/agents/subagent-spawn-accepted-note.d.ts`
- 描述：`SUBAGENT_SPAWN_ACCEPTED_NOTE` — "Auto-announce is push-based. After spawning children, do NOT call sessions_list / sleep / poll. Wait for completion events to arrive as user messages..."
- 触发条件：**只**在 `spawnSubagentDirect` 路径下生效；`PluginRuntime.subagent.run` 不触发
- 结论：本项目走 `runtime.subagent.run`，因此不依赖 auto-announce，需要 Path R2 自实现回传

### 4.5 sessionKey 构造

```ts
buildAgentSessionKey({
  agentId,                        // ctx.agentId ?? "main"
  channel: "a2a-xmtp",
  accountId,                      // ctx.agentAccountId ?? null
  peer: {
    kind: "direct",
    id: encodePeerId(peerAddress, { taskId }),  // "0xADDR?taskId=xxx"
  },
  dmScope: "per-account-channel-peer",
})
```

`encodePeerId` / `decodePeerId` 在 `src/routing/peer-id.ts`，用 URLSearchParams 把 taskId 嵌入 peer.id（host 不原生支持 taskId 维度）。

---

## 5. 本次 session 代码改动清单

| 改动 | 文件 | 性质 |
|------|------|------|
| 移除账户过滤 | `src/bootstrap/init-xmtp-install.ts` | 重写头注释 + 删 `shouldConnect` 检查 |
| 新增 `xmtp_send` tool | `src/routing/send-tool.ts` | 新建文件 |
| 在 daemon 暴露 `getMessaging()` | `src/domains/daemon/daemon.ts` | 新增 getter |
| 注册 `xmtp_send` | `src/index.ts` | `registerFull` 增一项 |
| 在 `setRuntime` 捕获 runtime 引用 | `src/index.ts` | 闭包传给 `buildSendTool` |
| ConversationTracker 留 TODO | `src/domains/daemon/conversation-tracker.ts` | `notifyInbound` + `armIdleTimer` 各加一段 TODO 注释 |

### 5.1 Tracker TODO 详情

```ts
// notifyInbound 内 setTimeout(...) 上方
// TODO: 依赖上游"任务阶段/对手方状态"的判断上线后，在此加分支：
//   - 若当前任务尚处于「未锁定对手方」阶段 → 超时仍 close（释放席位供其他 peer 试探）
//   - 若已锁定对手方（进入长任务执行） → skip close，保持会话挂起
// 上游数据结构未提供前，保持现状：直接 close。

// armIdleTimer 函数体首行
// TODO: （同上，idle 维度的对应分支）
```

不删 timer，仅加 TODO，是因为上游"任务阶段 / 对手方状态"数据结构尚未提供。

### 5.2 typecheck 状态

最近一次 `pnpm typecheck` exit=0。

---

## 6. 待办（按优先级）

### P0 — 阻塞合并 / 上线

1. **`xmtp_get_pending_list` 重构**：参数改 `{ xmtpAddress, taskId }`，按 conv 分组返回
2. **`xmtp_close_conversation` 重构**：sub 分支无参，main 分支 `{ agentId?, taskId? }`，加 cleanup 链
3. **新增 `xmtp_report_to_parent`（Path R2）**：subagent → main 回传
4. **inbound → subagent 唤醒触发器**：用户明确说"不是我们的工作"，但需要确认对接方式 / 接口契约
5. **close cleanup 完整链路**：groupCache 清 / `subagent.deleteSession` 调 / `recovery.taskGroupMap` 支持单 task 多 peer

### P1 — 健壮性

6. timer 触发的 close 没有通知链回 subagent / main（peer 知道但 LLM 不知道席位关了）
7. main session close 需要 integrate `runtime.subagent.deleteSession`
8. zod 化所有 tool 入参校验（见 REVIEW_CHECKLIST P1-1）
9. `xmtp_send` sub 分支无去重 → 双发（已确认可接受，但建议加日志可观测）

### P2 — 待外部信号

10. **Tracker 超时分支**（§5.1）：等上游数据结构定稿后实现「未锁定 peer 才超时关」
11. `maxConcurrentPerTask=1` 与"意向阶段一 task 多 peer"冲突 — 用户已明示**延后**

### 历史遗留（来自 REVIEW_CHECKLIST.md）
- P0-5 `recovery.rebuild`
- P0-6 dual watermarks
- 其余见 `docs/REVIEW_CHECKLIST.md`

---

## 7. 待与同事对齐的开放问题

1. **结果回传 trigger**：subagent 谈判完成后，由 LLM 主动调 `xmtp_report_to_parent`，还是 `xmtp_close_conversation` 自动代办？
2. **中途进度汇报**：long-running 任务期间是否需要中间态汇报？接口怎么设计？
3. **main session deliver-to-user 机制**：`runtime.subagent.run({ deliver: true })` 是否足够触达终端用户？是否还要传 `directOrigin`？
4. **inbound → subagent 唤醒**：上游谁负责？走 host event bus 还是 daemon 直接调 `runtime.subagent.run({ sessionKey: subagentKey, deliver: true, additionalContext })`？
5. **task 阶段 / 对手方状态**数据结构（影响 §5.1 TODO 兑现）

---

## 7.5 可能在同事代码中找到答案的问题（合并前**先翻同事仓库**再问）

> 以下问题本仓库无法独立确定，但很可能同事的业务模块已经有约定/实现。
> 合并代码时**先 grep / 通读**同事相关模块，能查到答案的就不必再开会问。

### 7.5.1 task 模型与生命周期

- **taskId 生成规则**：UUID？业务主键？是否需要带 namespace？
- **task 创建入口**：哪个模块负责 `createTask`？返回什么 metadata？
- **task 状态机**：是否定义了 `intent / negotiating / locked / executing / settled / closed` 之类的阶段？
  - 直接关系到 §5.1 tracker TODO 的"未锁定 peer / 已锁定"判断字段
- **task 与 agentId 的关系**：一个 agentId 可同时持有多少 task？task 是否归属固定 agentId？

### 7.5.2 provider list / 意向阶段语义

- 之前对话提到"获取 provider list"步骤——这个 list 由谁产出？接口契约？
- "意向阶段一 task 多 peer 同时沟通"是否已在同事侧实现？如果已实现，应当反推 §2.2 `maxConcurrentPerTask=1` 默认值 / §3.3.2 close 清理粒度

### 7.5.3 payload 扩展字段约定

- `xmtp_send.payload` 当前**允许任意扩展**，校验只到 `peerAddress + taskId`
- 同事的业务侧是否定义了固定字段集（如 `intent` / `priceQuote` / `signedOffer`）？要不要 zod schema 化？
- 这些字段是否需要在 daemon 中间件链做额外校验/签名验证？

### 7.5.4 inbound → subagent 唤醒接口

- 同事是否暴露了 host event bus / push hook，让 daemon 在 `notifyInbound` 时触发 subagent 重新跑？
- 如果没有，daemon 是否被允许直接调用 `runtime.subagent.run({ sessionKey: knownSubagentKey, deliver: true, additionalContext })`？
- 唤醒载荷：是带原始 incoming_message XML，还是 inbound 计数 + "go pull"指令？

### 7.5.5 信誉打分系统

- 同事是否已有 reputation / scoring 模块？
- 若有，`xmtp_get_pending_list` 重构后的"按 conv 分组返回"应否同时返回 score，便于 LLM 排序？

### 7.5.6 已提及但本仓库未实现的 tools

用户在前文给过完整 tool list：`xmtp_get_pending_list / xmtp_start_conversation / xmtp_send / xmtp_close_conversation / xmtp_upload / xmtp_history_messages / xmtp_openclaw_query_parent_session / xmtp_openclaw_session_send`。

本仓库目前只实现 3 个（见 §3.1）。**需确认**以下哪些由同事负责：

| Tool | 状态 | 同事是否在做？ |
|------|------|----------------|
| `xmtp_start_conversation` | 未实现 | ❓ 与 `xmtp_send` 首发是否冗余？ |
| `xmtp_upload` | 未实现 | ❓ 文件附件流程？XMTP remote attachment？ |
| `xmtp_history_messages` | 未实现 | ❓ 与 `xmtp_get_pending_list` 边界 — 一个看 watermark 后 / 一个看任意区间？ |
| `xmtp_openclaw_query_parent_session` | 未实现 | ❓ subagent → main 反查上下文，与 `xmtp_report_to_parent`(Path R2) 重叠？ |
| `xmtp_openclaw_session_send` | 未实现 | ❓ 是否就是 Path R2 的另一种命名？ |

→ 与同事**强烈建议先对齐 tool 拆分边界**再实施 §3.3，避免重复造轮子。

### 7.5.7 recovery / 持久化结构

- `recovery.taskGroupMap` 当前结构 = `Map<taskId, conversationId>`（单值），需重构为 `Map<taskId, Set<peerAddress>>` 才能支撑「单 task 多 peer」
- 同事是否已有自己的"task ↔ XMTP group"持久化层？若有，本仓库应**直接迁出** recovery，复用同事的真相源
- watermark 的 sync 频率是否需要与同事的 task 持久化对齐为同一事务？

### 7.5.8 directOrigin / DeliveryContext

- `runSubagentAnnounceFlow` / `deliverSubagentAnnouncement` 接收 `directOrigin` / `completionDirectOrigin` / `requesterOrigin`
- 同事的业务模块是否在产出 task 时已构造好 `DeliveryContext`？若有，Path R2 可直接复用
- 影响 §7 第 3 个开放问题（main session deliver-to-user 机制）

### 7.5.9 agentId fallback 是否合理

- `xmtp_send` 当前 `agentId: ctx.agentId ?? "main"` —— `"main"` 字面量是猜测的兜底
- 同事侧是否对 main session 的 agentId 有约定（如 `"root"` / `"user"` / 真实 agent UUID）？错的字面量会导致 `buildAgentSessionKey` 拼出无法路由的 sessionKey

### 7.5.10 sensitive-word 词表与策略

- 当前 `ContentFilter` 词表是本仓库内置最小集
- 同事是否有合规/风控模块统一管理词表？若有，应改为运行期注入而非编译期常量

---

## 8. 仓库导览（关键路径）

```
src/
├── index.ts                              # 入口：registerFull / setRuntime
├── bootstrap/
│   └── init-xmtp-install.ts              # XMTP daemon 启动 (无账户过滤)
├── domains/
│   ├── daemon/
│   │   ├── daemon.ts                     # MessageDaemon（getMessaging() 已暴露）
│   │   ├── conversation-tracker.ts       # γ-语义席位 + 两 TODO
│   │   └── watermark-store.ts            # per-conv BigInt ns
│   ├── security/
│   │   └── filter.ts                     # 敏感词
│   └── xmtp/
│       └── render-for-llm.ts             # incoming_message XML 渲染
└── routing/
    ├── peer-id.ts                        # encode/decode peer.id (?taskId=)
    ├── send-tool.ts                      # NEW: xmtp_send (main/sub 两分支)
    ├── get-pending-list-tool.ts          # PULL（待重构 §3.3.1）
    └── close-conversation-tool.ts        # 关闭（待重构 §3.3.2）

docs/
├── DESIGN.md                             # 历史设计
├── IMPLEMENTATION_STATUS.md              # 截至 2026-04-10 状态
├── DEVELOPMENT_ROAD.md
├── MERMAID-DIAGRAMS.md
├── REVIEW_CHECKLIST.md                   # P0/P1 历史 checklist
├── WORKAROUNDS.md
├── LARK_CONTEXT.md
└── MIGRATION.md                          # 本文（2026-04-19 增量）
```

---

## 9. 给接手者的最短路径

1. 通读本文 §1 / §2 / §3
2. 看 `src/routing/send-tool.ts` 理解 main/sub 分支模型
3. 看 `src/domains/daemon/conversation-tracker.ts` 理解 γ-语义
4. 看 §6 P0 列表，挑一个开工
5. 启动验证：`pnpm typecheck && pnpm test`，或在 OpenClaw host 内 `registerFull` 后跑 e2e
