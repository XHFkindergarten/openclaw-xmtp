# A2A XMTP 通信模块 — 开发 Roadmap

> 本文档为 `openclaw-plugin-xmtp` 的逐步开发计划。每个 Phase 从底层到上层递进，所有步骤原子化，每步均包含可执行的验收方案。
>
> **前提**：上下游模块（身份模块、任务模块）暂未开发，XMTP 通信身份使用本地测试钱包模拟。

---

## 技术选型

| 组件 | 选择 | 说明 |
|------|------|------|
| 通信协议 | XMTP v3 | 去中心化端到端加密消息协议 |
| SDK | `@xmtp/agent-sdk@^2.3.0` | 官方 Agent SDK，@xmtp/node-sdk 的最佳实践封装 |
| 钱包库 | `viem@^2.37.6` | Agent SDK 内建依赖，提供 `createUser()`/`createSigner()` |
| 运行时 | Node.js >= 22 | Agent SDK 要求 |
| 语言 | TypeScript 5.9+ | strict 模式 |
| 测试框架 | Vitest | 单元测试 + 集成测试 |
| 本地存储 | SQLite（XMTP 内建） | 每个 Agent 独立 db 文件 |

> **注意**：原设计中提到的 ethers.js 已替换为 viem。Agent SDK 内建了 `createUser(key?)` 和 `createSigner(user)` 工具函数，基于 viem 的 `generatePrivateKey()` 和 `privateKeyToAccount()`，无需额外引入 ethers.js。

---

## 目标目录结构

```
openclaw-xmtp-plugin/
├── package.json
├── tsconfig.json
├── .gitignore
├── README.md
├── SKILL.md
├── DESIGN.md                          # 已有
├── MERMAID-DIAGRAMS.md                # 已有
├── config/
│   ├── test-wallets.json              # Phase 1 生成，gitignore（通过脚本按需生成）
│   ├── daemon.json                    # Phase 7 默认守护进程配置
│   └── sensitive-words.json           # Phase 6 内建基础敏感词表
├── data/                              # 运行时数据，gitignore
│   ├── alice/                         # 各 Agent 的 XMTP SQLite DB
│   ├── bob/
│   ├── carol/
│   ├── daemon.pid.json
│   ├── daemon-state.json
│   ├── queue-state.json
│   └── audit.jsonl
├── src/
│   ├── index.ts                       # 插件入口 register()
│   ├── types.ts                       # 共享类型定义
│   ├── daemon.ts                      # XMTP 守护进程
│   ├── messaging.ts                   # 消息收发工具
│   ├── queue.ts                       # 会话并发队列
│   ├── filter.ts                      # 内容过滤（敏感词 + 限流）
│   ├── prompt-sandbox.ts              # Prompt 注入防护
│   ├── recovery.ts                    # 离线消息恢复
│   ├── bridge.ts                      # Agent 桥接层
│   ├── skills.ts                      # OpenClaw Skill 定义
│   ├── cli.ts                         # CLI 入口
│   ├── middleware/
│   │   └── logging.ts
│   └── mocks/
│       ├── task-api.ts                # 模拟任务平台 API
│       └── identity.ts                # 模拟身份模块
├── test/
│   ├── queue.test.ts
│   ├── filter.test.ts
│   └── prompt-sandbox.test.ts
└── scripts/
    ├── helpers/
    │   └── wallet.ts                  # 钱包加载 & Signer 创建工具
    ├── gen-wallets.ts                 # 生成测试钱包
    ├── test-connect.ts                # Phase 2 验收
    ├── test-reconnect.ts              # Phase 2 验收
    ├── test-multi-identity.ts         # Phase 2 验收
    ├── test-dm.ts                     # Phase 3 验收
    ├── test-dm-structured.ts          # Phase 3 验收
    ├── test-daemon.ts                 # Phase 4 验收
    ├── test-queue.ts                  # Phase 5 验收
    ├── test-security.ts               # Phase 6 验收
    ├── test-http-api.ts               # Phase 7 验收
    ├── test-e2e-trade.ts              # Phase 8 验收
    ├── test-e2e-queue.ts              # Phase 8 验收
    └── test-e2e-security.ts           # Phase 8 验收
```

---

## Phase 1: 项目脚手架 & 测试钱包基础设施

**目标**：建立项目骨架、依赖、TypeScript 配置和可复用的测试钱包生成。不涉及 XMTP 网络调用。

### 任务清单

#### 1.1 初始化 npm 项目

创建 `package.json`：

```jsonc
{
  "name": "openclaw-plugin-xmtp",
  "version": "0.1.0",
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "tsc",
    "dev": "tsx watch src/cli.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@xmtp/agent-sdk": "^2.3.0"
  },
  "devDependencies": {
    "viem": "^2.37.6",
    "tsx": "^4.21.0",
    "typescript": "^5.9.3",
    "vitest": "^3.2.1",
    "@types/node": "^22.15.0"
  }
}
```

#### 1.2 TypeScript 配置

`tsconfig.json`：target ES2022, module NodeNext, strict 模式, `outDir: "./dist"`。

#### 1.3 创建 `src/types.ts`

定义所有共享类型：

```typescript
// === 消息协议 ===
export enum ActionType {
  CreateTask = "create_task",
  TradeIntent = "trade_intent",
  Negotiate = "negotiate",
  AcceptProvider = "accept_provider",
  Deliver = "deliver",
  Complete = "complete",
  Reject = "reject",
  Reply = "reply",
  Notification = "notification",
  Rate = "rate",
  FileRef = "file_ref",
  QueryStatus = "query_status",
}

export interface ACPEnvelope {
  version: string;           // "1.0"
  type: ActionType;
  jobId: string;
  from: string;              // sender inboxId
  to: string;                // receiver inboxId
  timestamp: number;
  payload: Record<string, unknown>;
}

// === 配置 ===
export interface PluginConfig {
  env: "production" | "dev";
  gatewayHost?: string;
  dbDir: string;
  httpPort: number;
  sensitiveWordRefreshInterval: number;
}

export interface QueueConfig {
  maxConcurrentChats: number;  // 默认 1，最大 10
}

// === 测试钱包 ===
export interface AgentWallet {
  privateKey: `0x${string}`;
  address: string;
  dbEncryptionKey: `0x${string}`;
}

export interface TestWallets {
  [name: string]: AgentWallet;
}
```

#### 1.4 创建 `scripts/gen-wallets.ts`

- 使用 viem 的 `generatePrivateKey()` + `privateKeyToAccount()` 生成 3 个测试钱包（alice, bob, carol）
- 为每个钱包生成 `dbEncryptionKey`（32 字节随机 hex）
- 写入 `config/test-wallets.json`
- 幂等：文件已存在则跳过

#### 1.5 创建 `scripts/helpers/wallet.ts`

```typescript
import { readFileSync } from "node:fs";
import { createUser, createSigner } from "@xmtp/agent-sdk";
import type { AgentWallet, TestWallets } from "../../src/types.js";

export function loadTestWallets(): TestWallets {
  return JSON.parse(
    readFileSync("config/test-wallets.json", "utf-8")
  );
}

export function loadTestWallet(name: string): AgentWallet {
  const wallets = loadTestWallets();
  const wallet = wallets[name];
  if (!wallet) {
    throw new Error(`Test wallet "${name}" not found`);
  }
  return wallet;
}

export function createXmtpSigner(wallet: AgentWallet) {
  const user = createUser(wallet.privateKey);
  return createSigner(user);
}
```

> **注意**：`createUser` / `createSigner` 从 `@xmtp/agent-sdk` 主入口导出（SDK 通过 `export * from "./user/index"` 重导出）。如果 SDK 版本变更导致导出不可用，则直接使用 viem 的 `privateKeyToAccount()` 手工构造 Signer 接口。

#### 1.6 配置 `.gitignore`

```
node_modules/
dist/
data/
config/test-wallets.json
*.db3
*.db3-shm
*.db3-wal
.env
.context/
```

### 产出文件

- `package.json`
- `tsconfig.json`
- `.gitignore`
- `src/types.ts`
- `scripts/gen-wallets.ts`
- `scripts/helpers/wallet.ts`

### 验收方案

```bash
# 1. 安装依赖
pnpm install

# 2. 类型检查
npx tsc --noEmit
# 预期：无错误

# 3. 生成测试钱包
npx tsx scripts/gen-wallets.ts
# 预期：输出 "Generated 3 test wallets -> config/test-wallets.json"

# 4. 查看钱包
cat config/test-wallets.json
# 预期：JSON 包含 alice/bob/carol，各含 privateKey(0x+64hex), address(0x+40hex), dbEncryptionKey

# 5. 验证钱包加载 & Signer 创建
npx tsx -e "
  import { loadTestWallet, createXmtpSigner } from './scripts/helpers/wallet.js';
  const alice = loadTestWallet('alice');
  console.log('Alice address:', alice.address);
  const signer = createXmtpSigner(alice);
  const id = signer.getIdentifier();
  console.log('Identifier:', id.identifier, id.identifierKind);
"
# 预期：打印 alice 地址和 identifier（identifierKind 为 "Ethereum"）

# 6. 幂等测试
npx tsx scripts/gen-wallets.ts
# 预期：输出 "Wallets already exist, skipping"
```

### 依赖

无（基础阶段）

---

## Phase 2: XMTP 连接 & 身份注册

**目标**：验证测试钱包能连接 XMTP dev 网络、注册身份、获得 inboxId，验证 SQLite 持久化正常工作。

### 任务清单

#### 2.1 创建 `scripts/test-connect.ts`

- 加载 alice 钱包
- 调用 Agent.create，**注意 `dbPath` 必须传入函数或完整文件路径**（非目录）：
  ```typescript
  const agent = await Agent.create(signer, {
    env: "dev",
    dbPath: (inboxId) => { return `./data/alice/xmtp-${inboxId}.db3`; },
    dbEncryptionKey: hexToBytes(wallet.dbEncryptionKey),
  });
  ```
- 打印：钱包地址、`agent.client.inboxId`、`agent.client.installationId`
- 调用 `agent.stop()` 清理退出
- 确认 `data/alice/` 目录下生成了 `.db3` 文件

#### 2.2 创建 `scripts/test-reconnect.ts`

- 再次加载 alice，使用相同 `dbPath` 创建 Agent
- 验证 inboxId 与首次运行一致（持久化生效）
- 打印对比结果

#### 2.3 创建 `scripts/test-multi-identity.ts`

- 同时加载三个钱包创建三个 Agent（各自独立 dbPath）
- 打印三个 inboxId，验证各不相同
- 停止所有 Agent

### 产出文件

- `scripts/test-connect.ts`
- `scripts/test-reconnect.ts`
- `scripts/test-multi-identity.ts`

### 验收方案

```bash
# 首次连接（XMTP 网络注册可能需要 5-10 秒）
npx tsx scripts/test-connect.ts
# 预期输出：
#   Alice address: 0x...
#   Inbox ID: <64位 hex>
#   Installation ID: <hex string>
#   DB files created: true

# 重连持久化测试
npx tsx scripts/test-reconnect.ts
# 预期输出：
#   inboxId matches: true
#   installationId matches: true

# 多身份测试
npx tsx scripts/test-multi-identity.ts
# 预期输出：三个不同的 inboxId

# 验证 SQLite 文件
ls -la data/alice/*.db3
# 预期：存在 .db3 文件
```

### 依赖

- Phase 1（项目脚手架、钱包生成）

---

## Phase 3: 1:1 DM 消息收发

**目标**：验证两个 Agent 之间的双向 DM 通信能力。这是所有 A2A 通信的原子单元。

### 任务清单

#### 3.1 创建 `scripts/test-dm.ts`

流程：
1. 加载 alice 和 bob 钱包，各自创建 Agent（dbPath 函数指向 `data/alice/`、`data/bob/`）
2. Alice 向 Bob 发起 DM：`await alice.createDmWithAddress(bobAddress)` （Agent SDK 方法，底层调用 `client.conversations.createDmWithIdentifier`）
3. Alice 发送文本：`await dm.sendText("Hello from Alice")` （**注意：不是 `send()`，SDK 方法为 `sendText()`**）
4. Bob 获取会话并读取消息：`const bobDm = await bob.client.conversations.createDm(aliceInboxId)` 然后 `await bobDm.sync()` + `await bobDm.messages()`
5. 验证 Bob 收到的消息内容和发送者正确（`message.senderInboxId` 匹配 alice 的 inboxId）
6. Bob 回复：`await bobDm.sendText("Hello back from Bob")`
7. Alice 同步（`await dm.sync()`）并验证收到回复
8. 所有测试脚本末尾调用 `process.exit(0)` 确保干净退出

#### 3.2 创建 `scripts/test-dm-structured.ts`

- 复用 3.1 的基础设施
- Alice 发送 JSON 编码的 `ACPEnvelope` 消息
- Bob 接收、解析 JSON、按 `ACPEnvelope` 类型验证结构
- 验证 XMTP text channel 能承载结构化协议消息

```typescript
const envelope: ACPEnvelope = {
  version: "1.0",
  type: ActionType.TradeIntent,
  jobId: "test-001",
  from: aliceInboxId,
  to: bobInboxId,
  timestamp: Date.now(),
  payload: { message: "I'm interested in your service", budget: 500 },
};
// 使用 "ACP:" 前缀区分协议消息和普通文本
await dm.sendText("ACP:" + JSON.stringify(envelope));
```

#### 3.3 创建 `src/messaging.ts`

消息收发工具类（内部缓存 conversation 对象，避免每次发送都创建 DM 的网络开销）：

```typescript
export class MessagingToolkit {
  // conversation 缓存：address -> Conversation
  private dmCache = new Map<string, Conversation>();

  constructor(private agent: Agent) {}

  // 获取或创建 DM（缓存 conversation 对象）
  private async getOrCreateDm(toAddress: string): Promise<Conversation>;

  // 发送文本消息
  async sendText(toAddress: string, content: string):
    Promise<{ conversationId: string; messageId: string }>;

  // 发送结构化消息（"ACP:" 前缀 + JSON）
  async sendEnvelope(toAddress: string, envelope: ACPEnvelope):
    Promise<{ conversationId: string; messageId: string }>;

  // 获取所有待回复消息（按会话分组）
  async getPendingMessages(options?: { since?: Date }):
    Promise<Map<string, DecodedMessage[]>>;

  // 获取指定对端的消息历史
  async getHistory(peerAddress: string, options?: { limit?: number }):
    Promise<DecodedMessage[]>;
}
```

> **协议消息格式约定**：所有 ACPEnvelope 消息以 `"ACP:"` 前缀标识，接收方通过前缀判断消息类型（而非对每条消息尝试 JSON.parse）。未来可迁移到自定义 XMTP Content Type（注册 `ContentTypeACPEnvelope` 编解码器）以获得更好的类型安全。

### 产出文件

- `scripts/test-dm.ts`
- `scripts/test-dm-structured.ts`
- `src/messaging.ts`

### 验收方案

```bash
# 基础 DM 测试
npx tsx scripts/test-dm.ts
# 预期输出：
#   Alice -> Bob: "Hello from Alice" ✓ sent
#   Bob received: "Hello from Alice" from alice-inboxId ✓
#   Bob -> Alice: "Hello back from Bob" ✓ sent
#   Alice received: "Hello back from Bob" from bob-inboxId ✓
#   All assertions passed

# 结构化消息测试
npx tsx scripts/test-dm-structured.ts
# 预期输出：
#   Sent ACPEnvelope { type: "trade_intent", jobId: "test-001" }
#   Bob received and parsed: ✓
#   Envelope type matches: trade_intent ✓
#   Payload integrity: ✓
```

### 依赖

- Phase 2（XMTP 连接验证通过）

---

## Phase 4: 消息流订阅 & 守护进程基础

**目标**：构建守护进程的核心消息流监听循环，实现事件驱动处理和心跳。这是 XMTP 长连接的基础。

### 任务清单

#### 4.1 创建 `src/daemon.ts`（MessageDaemon）

```typescript
export class MessageDaemon {
  private agent: Agent;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private messageCount = 0;
  private startedAt: Date;

  constructor(private config: DaemonConfig) {}

  // 启动守护进程
  async start(): Promise<void>;
  // 停止守护进程
  async stop(): Promise<void>;
  // 获取状态
  getStatus(): DaemonStatus;
}
```

核心职责：
- 调用 `agent.start()` 开启流式消息监听
- 注册 `agent.on('text', handler)` 路由收到的消息
- 心跳定时器：每 30 秒日志输出（uptime、消息计数）
- PID 文件管理：启动时写 `data/daemon.pid.json`，停止时删除
- SIGINT/SIGTERM 优雅关闭
- 自定义事件回调：`onMessage(ctx: MessageContext)` — 从 ctx 中提取：
  - `ctx.message.senderInboxId`（注意：获取 address 需要 `await ctx.getSenderAddress()`）
  - `ctx.message.content`（消息内容）
  - `ctx.conversation.id`（会话 ID）
  - `ctx.message.sentAtNs`（纳秒时间戳）

#### 4.2 创建 `scripts/test-daemon.ts`

- 启动 alice 的守护进程
- 延时后用 bob 的 Agent 向 alice 发送消息
- 验证守护进程通过 onMessage 回调收到消息
- 停止守护进程，检查 PID 文件已清理

#### 4.3 实现中间件管道

利用 Agent SDK 内建的 `agent.use(middleware)` 模式：

- `src/middleware/logging.ts` — 记录每条收到的消息（sender, conversationId, content 长度, 时间戳）
- 集成 SDK 内建的 `PerformanceMonitor` 中间件（CPU/内存/事件循环监控，用于守护进程健康检查）

> **注意**：SDK 已内建 self-filter（`Agent.#processMessage` 中 `filter.fromSelf()` 会自动跳过自身消息），**无需**自定义 self-filter 中间件。

#### 4.4 实现离线消息恢复 `src/recovery.ts`

守护进程启动时（`agent.start()` 之前）：
1. 调用 `agent.client.conversations.list()` 获取所有会话
2. 对每个会话调用 `conv.messages()` 获取消息
3. 筛选未回复消息：使用 **messageId 水位标记**（而非时间戳，避免纳秒精度和时钟漂移问题），记录最后处理的 messageId，恢复时获取该 ID 之后的所有消息
4. 通过同一个 `onMessage` 回调投递恢复的消息
5. 更新 `data/daemon-state.json` 中的 `lastProcessedMessageId`

核心设计：
- **幂等安全**：基于「自己最后发言之后对方的消息」判断未回复
- **崩溃友好**：SIGKILL 导致内存全丢也能完整恢复
- **后端为准**：已完成/取消的任务对应的 XMTP 会话不会被恢复（当任务模块就绪后接入）

### 产出文件

- `src/daemon.ts`
- `src/middleware/logging.ts`
- `src/recovery.ts`
- `scripts/test-daemon.ts`

### 验收方案

```bash
# 守护进程启停测试
npx tsx scripts/test-daemon.ts
# 预期输出：
#   Daemon started | address: 0x... | env: dev
#   Heartbeat: alive | uptime: 0s | messages: 0
#   Bob -> Alice: "Test message from bob"
#   [daemon] Message received from bob-inboxId in conv-xxx
#   Daemon stopping...
#   PID file cleaned: true

# 离线恢复测试（在 test-daemon.ts 中包含）：
#   [recovery] Found 1 offline message(s) since last shutdown
#   [recovery] Recovered: conv-xxx | from: bob | content length: 24

# PID 文件生命周期（整合在 test-daemon.ts 内部验证）：
# 脚本内部通过子进程 spawn + 信号发送 + 文件存在性检查实现
# 不使用手动 shell 后台 + sleep 的不可靠方式
```

### 依赖

- Phase 3（DM 消息收发验证通过）

---

## Phase 5: 会话并发队列管理

**目标**：实现优先级队列，管理 Agent 的并发沟通会话。

### 任务清单

#### 5.1 创建 `src/queue.ts`（SessionQueue）

```typescript
export interface QueueEntry {
  conversationId: string;
  senderAddress: string;
  senderInboxId: string;
  agentId?: string;
  reputationScore: number;     // 默认 50，待信誉模块接入
  taskId: string;
  receivedAt: Date;
  messages: ACPEnvelope[];
}

export class SessionQueue {
  private active: Map<string, QueueEntry>;       // conversationId -> entry
  private waiting: QueueEntry[];                  // 按优先级排序

  constructor(private config: QueueConfig) {}

  // 入队：空闲则直接激活，否则进等待队列
  enqueue(entry: QueueEntry): { status: "activated" | "queued"; position?: number };
  // 出队：结束会话，提升下一个等待者
  dequeue(conversationId: string): { nextActivated?: QueueEntry };
  // 查询位置（0=活跃，1+=等待）
  getPosition(conversationId: string): number;
  // 队列统计
  getStats(): QueueStats;
  // 持久化到文件（崩溃恢复用）
  persist(): void;
  // 从文件恢复
  static restore(config: QueueConfig): SessionQueue;
}
```

排序规则：
- 信誉分 **降序**（高分优先）
- 同分内按 `receivedAt` **升序**（先到先得）

持久化：每次状态变更通过**原子写入**保存到 `data/queue-state.json`（先写临时文件再 `rename`，避免崩溃时文件损坏）。恢复时以文件为准重建内存状态。

#### 5.2 创建 `test/queue.test.ts`

必须覆盖的用例：
- 空队列入队 → 立即激活
- 活跃槽满 → 进入等待
- 出队 → 提升信誉最高的等待者
- 同信誉 FIFO
- `maxConcurrent=3` 允许 3 个并行会话
- 持久化 save/restore 往返一致
- 边界：队列空时 dequeue 无报错

#### 5.3 集成队列到守护进程

修改 `src/daemon.ts`：
- 收到消息时检查队列
  - 发送者有活跃会话 → 直接路由
  - 发送者无会话 → 入队，有空槽则激活
  - 无空槽 → 加入等待，回复 "您的请求已排队，当前位置 N"
- 会话结束时 → 出队，通知下一位 "轮到您了"

#### 5.4 创建 `scripts/test-queue.ts`

集成测试：
- Alice 作为守护进程（`maxConcurrent=1`）
- Bob 发送消息 → 获得活跃会话
- Carol 发送消息 → 进入排队（position 1）
- 模拟 Bob 会话结束 → Carol 被提升
- 验证 Carol 收到通知

### 产出文件

- `src/queue.ts`
- `test/queue.test.ts`
- `scripts/test-queue.ts`
- 修改 `src/daemon.ts`

### 验收方案

```bash
# 单元测试
npx vitest run test/queue.test.ts
# 预期：全部 7+ 用例通过

# 集成测试
npx tsx scripts/test-queue.ts
# 预期输出：
#   Bob -> Alice: trade_intent | queue result: activated
#   Carol -> Alice: trade_intent | queue result: queued (position 1)
#   Carol received: "Your request is in queue (position 1)"
#   Closing Bob's session...
#   Carol promoted to active
#   Carol received: "Your session is now active"
#   Final stats: active=1, waiting=0

# 高并发测试
npx tsx scripts/test-queue.ts --max-concurrent 3
# 预期：bob, carol, dave 都获得活跃会话
```

### 依赖

- Phase 4（守护进程基础）

---

## Phase 6: 安全层 — 内容过滤 & Prompt 防护

**目标**：实现两层同步安全防护：敏感词/限流过滤 和 Prompt 注入防御。

### 任务清单

#### 6.1 创建 `src/filter.ts`（ContentFilter）

```typescript
export interface FilterResult {
  passed: boolean;
  code?: string;
  reason?: string;
  hitWords?: string[];
}

export class ContentFilter {
  // 初始化，加载敏感词表
  async init(refreshInterval?: number): Promise<void>;
  // 检查消息内容
  check(content: string, context?: FilterContext): FilterResult;
  // 热更新敏感词表
  updateWordList(words: string[]): void;
  // 销毁（清理定时器）
  destroy(): void;
}
```

功能维度：
1. **敏感词过滤**：从 `config/sensitive-words.json` 加载，支持热更新
2. **限流**：
   - 每 agent-pair：最多 10 条/分钟
   - 每 taskId：最多 50 条/小时
   - 每 agent 每日：最多 500 条
   - 全局：最多 1000 条/小时
3. **消息大小检查**：上限 50KB
4. **重放检测**：60 秒窗口内按 messageId 去重
5. **安全事件日志**：命中事件写入 `data/audit.jsonl`（时间戳、命中词、agentId、taskId，不含消息明文）

#### 6.2 创建 `src/prompt-sandbox.ts`（PromptSandbox）

出站消息清洗：
- 剥离系统路径（`/Users/xxx`, `/home/xxx`）
- 剥离私钥模式（`0x` + 64 hex）
- 剥离 API Key 模式（`sk-...`, `xoxb-...`）
- 剥离环境变量引用

入站上下文组装（技术设计中的三层纵深防御）：
- 结构隔离：`[PEER_MESSAGE]` 标签包裹
- 结构化 token 转义
- 长度截断（>4000 字符）

```typescript
export class PromptSandbox {
  // 系统启动时的安全提示词
  buildBootstrapPrompt(ctx: BootstrapContext): string;
  // 包裹对方消息，隔离数据与指令
  wrapPeerMessage(rawContent: string, meta: PeerMeta): string;
  // 清洗出站消息
  sanitizeOutbound(content: string): { sanitized: string; redacted: boolean };
  // 上下文压缩恢复后的安全提示
  buildCompactPrompt(preserved: ConversationSummary): string;
}
```

#### 6.3 创建单元测试

`test/filter.test.ts`：
- 干净消息通过
- 含敏感词消息被拦截，返回 hitWords
- 限流：第 11 条消息被拦截
- 大消息（>50KB）被拦截
- 重放检测：相同 messageId 被拦截
- 热更新生效
- 审计日志正确写入

`test/prompt-sandbox.test.ts`：
- 系统路径被剥离
- 私钥被剥离
- API Key 被剥离
- 干净消息不变
- `[PEER_MESSAGE]` 包裹正确
- 转义注入尝试（如 `[/PEER_MESSAGE]`）

#### 6.4 集成到守护进程中间件管道

中间件执行顺序：
```
收到消息 → 重放检测 → 大小检查 → 限流 → 敏感词过滤 → Prompt 包裹 → 路由到 Agent
Agent 回复 → 出站清洗 → 发送到 XMTP
```

#### 6.5 创建 `scripts/test-security.ts`

端到端安全测试：
- Bob 发送含敏感词的消息 → 被拦截，审计日志记录
- Bob 连发 11 条消息 → 第 11 条被限流拦截
- Bob 发送 51KB 消息 → 被大小检查拦截
- Alice 回复中包含系统路径 → 出站清洗

### 产出文件

- `src/filter.ts`
- `src/prompt-sandbox.ts`
- `test/filter.test.ts`
- `test/prompt-sandbox.test.ts`
- `config/sensitive-words.json`
- `scripts/test-security.ts`

### 验收方案

```bash
# 单元测试
npx vitest run test/filter.test.ts
npx vitest run test/prompt-sandbox.test.ts
# 预期：全部通过

# 集成安全测试
npx tsx scripts/test-security.ts
# 预期输出：
#   [test] Sensitive word: BLOCKED ✓ | hitWord: "xxx"
#   [test] Audit log written ✓
#   [test] Rate limit (11th msg): BLOCKED ✓
#   [test] Oversized (51KB): BLOCKED ✓
#   [test] Outbound path leak: SANITIZED ✓ | "/Users/oker/secret" -> "[REDACTED_PATH]"
#   All 5 security tests passed
```

### 依赖

- Phase 4（守护进程 + 中间件管道）

---

## Phase 7: HTTP API & CLI 工具

**目标**：构建 HTTP 接口供外部集成，CLI 供开发者调试，以及连接守护进程到 OpenClaw 的桥接层。

### 任务清单

#### 7.1 守护进程添加 HTTP 服务

使用 Node.js 原生 `http` 模块（无需额外依赖）：

| 端点 | 方法 | 说明 |
|------|------|------|
| `/send` | POST | 发送消息（to, content, taskId?） |
| `/inbox` | GET | 查询收到的消息（from?, since?） |
| `/status` | GET | 守护进程状态 |
| `/queue` | GET | 当前队列状态 |
| `/history` | GET | 会话历史（peer?, taskId?） |
| `/stop` | POST | 优雅关闭 |

默认端口：`18790`（可配置）。

**认证**：启动时生成随机 Bearer token 并写入 `data/auth-token.txt`，所有请求需携带 `Authorization: Bearer <token>` 头。CLI 自动读取此文件。

#### 7.2 创建 `src/bridge.ts`（AgentBridge）

Agent 桥接层抽象：

```typescript
export abstract class AgentBridge {
  abstract sendToAgent(envelope: ACPEnvelope): Promise<ACPEnvelope | null>;
  abstract onAgentResponse(callback: (envelope: ACPEnvelope) => void): void;
}

// 具体实现：
export class HttpBridge extends AgentBridge { /* HTTP 回调 */ }
export class MockBridge extends AgentBridge { /* 开发阶段模拟 Agent 决策 */ }
```

开发阶段使用 `MockBridge`，按预设规则自动回复：
- 收到 `trade_intent` → 回复 `negotiate`
- 收到 `deliver` → 回复 `complete`
- 其他 → 回复 `reply` 确认

#### 7.3 创建 `src/index.ts`（插件入口）

```typescript
export async function createPlugin(config: PluginConfig) {
  const filter = new ContentFilter();
  const queue = new SessionQueue(config.queue);
  const daemon = new MessageDaemon(config);

  await filter.init(config.sensitiveWordRefreshInterval);
  await daemon.start();

  return {
    daemon,
    filter,
    queue,
    async stop() {
      filter.destroy();
      await daemon.stop();
    },
  };
}
```

#### 7.4 创建 `src/cli.ts`

CLI 命令列表：

```
openclaw-xmtp daemon start     # 启动守护进程
openclaw-xmtp daemon stop      # 停止守护进程
openclaw-xmtp status           # 查看状态
openclaw-xmtp send <to> <msg>  # 发送消息
openclaw-xmtp inbox            # 查看收件箱
openclaw-xmtp history <peer>   # 查看历史
openclaw-xmtp queue            # 查看队列
openclaw-xmtp filter status    # 过滤器状态
openclaw-xmtp filter update    # 更新敏感词表
```

全局选项：`--json`（JSON 输出）, `--config <path>`, `--env <dev|production>`

#### 7.5 创建 `scripts/test-http-api.ts`

启动守护进程后遍历所有 HTTP 端点。

### 产出文件

- `src/index.ts`
- `src/bridge.ts`
- `src/cli.ts`
- `config/daemon.json`
- `scripts/test-http-api.ts`

### 验收方案

```bash
# 启动守护进程
npx tsx src/cli.ts daemon start

# 查看状态
npx tsx src/cli.ts status --json
# 预期：{ "running": true, "address": "0x...", "uptime": N, "queue": {...} }

# 发送消息
npx tsx src/cli.ts send <bob-address> "Hello via CLI"
# 预期：{ "ok": true, "conversationId": "..." }

# 查看收件箱
npx tsx src/cli.ts inbox --json
# 预期：消息数组

# HTTP API 直接调用
curl http://127.0.0.1:18790/status
# 预期：JSON 状态响应

curl -X POST http://127.0.0.1:18790/send \
  -H "Content-Type: application/json" \
  -d '{"to": "<bob-address>", "content": "Hello via HTTP"}'
# 预期：{ "ok": true, "conversationId": "..." }

# 停止守护进程
npx tsx src/cli.ts daemon stop
# 预期：{ "ok": true }

# 自动化 API 测试
npx tsx scripts/test-http-api.ts
# 预期：全部端点测试通过
```

### 依赖

- Phase 5（队列管理）
- Phase 6（安全过滤）

---

## Phase 8: 端到端集成 & OpenClaw Skill 定义

**目标**：将所有模块整合为完整的 `openclaw-plugin-xmtp`，编写 Skill 定义，模拟完整的交易沟通流程。

### 任务清单

#### 8.1 创建 `src/skills.ts`

OpenClaw Skill 注册（技术设计 Section 7）：

```typescript
export function registerSkills(api: PluginAPI, daemon: MessageDaemon) {
  api.registerSkill("xmtp_get_pending", { ... });
  api.registerSkill("xmtp_send", { ... });
  api.registerSkill("xmtp_get_messages", { ... });
  api.registerSkill("xmtp_accept", { ... });
  api.registerSkill("xmtp_close", { ... });
  api.registerSkill("xmtp_upload", { ... });
  api.registerSkill("xmtp_queue_status", { ... });
}
```

> 由于 OpenClaw Gateway 尚未就绪，此阶段先定义接口和 mock 注册，实际 hook 绑定待联调时启用。

#### 8.2 创建 Mock 上下游模块

- `src/mocks/task-api.ts` — 模拟任务平台 API（返回硬编码任务数据）
- `src/mocks/identity.ts` — 模拟身份模块（返回测试钱包信息）
- 所有 mock 显式标记 `// TODO: Replace with real API when available`

#### 8.3 创建 `scripts/test-e2e-trade.ts`

模拟完整托管交易流程（alice=Requestor, bob=Provider）：

```
Phase 1: Alice 创建任务（mock）
Phase 2: Bob 发送 trade_intent
Phase 3: 队列分配 Bob 进入活跃会话
Phase 4: Alice（MockBridge）回复 negotiate（400 USDC）
Phase 5: Bob 发送 accept
Phase 6: Alice 发送 accept_provider
Phase 7: Bob 发送 deliver（含 IPFS hash）
Phase 8: Alice 发送 complete
Phase 9: 双方收到完成通知
```

验证：审计日志完整、队列状态流转正确、所有消息过滤器正常工作。

#### 8.4 创建 `scripts/test-e2e-queue.ts`

多 Provider 排队测试：
- Alice（maxConcurrent=1）
- Bob（信誉 85）、Carol（信誉 92）、Dave（信誉 78）同时发送 trade_intent
- 预期：Carol（最高分）→ 活跃 → 结束 → Bob 提升 → 结束 → Dave 提升

#### 8.5 创建 `scripts/test-e2e-security.ts`

安全全面测试：
- 重放攻击
- 消息轰炸（超限流）
- 敏感词
- 超大消息
- 出站路径泄漏
- 出站私钥泄漏

#### 8.6 创建 `SKILL.md` & `README.md`

- SKILL.md：OpenClaw Skill 定义文件
- README.md：快速开始、架构图、CLI 参考、API 参考

### 产出文件

- `src/skills.ts`
- `src/mocks/task-api.ts`
- `src/mocks/identity.ts`
- `SKILL.md`
- `README.md`
- `scripts/test-e2e-trade.ts`
- `scripts/test-e2e-queue.ts`
- `scripts/test-e2e-security.ts`

### 验收方案

```bash
# 完整交易流程
npx tsx scripts/test-e2e-trade.ts
# 预期输出：
#   Phase 1: Task created (mock) | taskId: test-task-001
#   Phase 2: Bob->Alice trade_intent ✓
#   Phase 3: Queue: Bob activated ✓
#   Phase 4: Alice->Bob negotiate (400 USDC) ✓
#   Phase 5: Bob->Alice accept ✓
#   Phase 6: Alice->Bob accept_provider ✓
#   Phase 7: Bob->Alice deliver (IPFS: QmXxx...) ✓
#   Phase 8: Alice->Bob complete ✓
#   Phase 9: Completion notification ✓
#   All 9 phases passed | Audit entries: 12

# 队列集成测试
npx tsx scripts/test-e2e-queue.ts
# 预期输出：
#   Carol (rep 92) -> active ✓
#   Bob (rep 85) -> waiting (pos 1) ✓
#   Dave (rep 78) -> waiting (pos 2) ✓
#   Carol done -> Bob promoted ✓
#   Bob done -> Dave promoted ✓

# 安全全面测试
npx tsx scripts/test-e2e-security.ts
# 预期输出：6/6 security tests passed

# 全量测试
npx vitest run
# 预期：全部单元测试 + 集成测试通过

# 类型检查
npx tsc --noEmit
# 预期：无错误
```

### 依赖

- Phase 7（HTTP API、CLI、Bridge）

---

## 各阶段依赖关系

```
Phase 1 (脚手架)
  └─> Phase 2 (连接)
        └─> Phase 3 (DM 消息)
              └─> Phase 4 (守护进程)
                    ├─> Phase 5 (队列)      ← 可并行开发
                    └─> Phase 6 (安全)      ← 可并行开发
                          └─> Phase 7 (HTTP/CLI) [依赖 Phase 5 + 6]
                                └─> Phase 8 (端到端集成)
```

> **并行优化**：Phase 5（队列）和 Phase 6（安全）互不依赖，可分配给不同开发者并行实现，缩短总工期。

## 风险与缓解

| 风险 | 缓解措施 |
|------|----------|
| XMTP dev 网络不稳定 | 所有测试脚本设 30s 超时 + 清晰错误消息。Agent SDK 内建指数退避重连。 |
| SQLite 锁竞争 | 每个 Agent 使用独立 dbPath。绝不跨进程共享 SQLite 文件。 |
| Installation 上限（每钱包 10 个） | **复用同一 .db3 文件才复用 installation**（相同密钥 ≠ 相同 installation）。所有测试脚本使用固定 dbPath 函数指向 `data/<name>/` 目录。禁止随意删除 .db3 文件。 |
| Agent SDK API 变更 | 锁定 `@xmtp/agent-sdk@^2.3.0`。本地有 SDK 源码 (`/Users/oker/a2a/xmtp-js/`) 可参考。 |
| 上游模块联调延迟 | 所有上游依赖通过 Mock 隔离，mock 接口与真实 API 规格一致。 |

## 当前版本范围说明

本 Roadmap 涵盖 **1:1 DM 通信**的完整链路。以下能力列为后续迭代：

| 能力 | 说明 | 计划迭代 |
|------|------|----------|
| Group 对话 | SDK 支持 `createGroupWithAddresses()`，用于多方协调/仲裁 | v0.2 |
| Consent 管理 | XMTP 三态联系人管理（Allowed/Unknown/Denied），首次联系授权流程 | v0.2 |
| 自定义 Content Type | 注册 `ContentTypeACPEnvelope` 编解码器替代 JSON-over-text | v0.2 |
| 附件/文件传输 | SDK 提供 `AttachmentUtil` + `sendRemoteAttachment()`，用于交付物传输 | v0.2 |
| ENS 域名解析 | SDK 提供 `createNameResolver()`，支持域名通信 | v0.3 |

---

## 参考资料

- 技术设计文档：`./DESIGN.md`
- XMTP Agent SDK 源码：`/Users/oker/a2a/xmtp-js/sdks/agent-sdk/`
- XMTP Demo 项目：`/Users/oker/a2a/xmtp-demo1/`
- XMTP 官方文档：https://docs.xmtp.org/agents/get-started/build-an-agent
- @xmtp/agent-sdk NPM：https://www.npmjs.com/package/@xmtp/agent-sdk

---

## 附录：Codex 审查记录

本文档经 OpenAI Codex 全面审查（交叉参照 SDK 源码），发现 25 项问题（5 P1 / 14 P2 / 6 P3）。以下 P1 已全部修复：

| # | 原问题 | 修复 |
|---|--------|------|
| 1 | `newDm()` API 不存在 | 改为 `createDmWithAddress()` |
| 2 | `dm.send()` 不存在 | 改为 `sendText()` |
| 3 | `dbPath` 传目录会报错 | 改为函数 `(inboxId) => path.db3` |
| 14 | Bob 获取会话方式不明确 | 补充 `createDm(inboxId)` + `sync()` 流程 |
| 24 | JSON-over-text 无类型标记 | 增加 `"ACP:"` 前缀 + 后续 Content Type 迁移计划 |

其他重要修正：移除冗余 self-filter、修复 Installation 限制说明、添加 HTTP 认证、改用 messageId 水位恢复、队列原子写入、Consent/Group 列入后续迭代。
