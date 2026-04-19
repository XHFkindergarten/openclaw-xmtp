# Lark 文档上下文汇编

> 本文件由 Claude 从飞书（Lark）文档自动提取，供无法访问飞书的 AI 工具读取。
> 包含三份原始设计文档的完整内容，请在实现任何功能前通读。
>
> 源文档：
> - `PVURduut5o0cquxfeQ7lHkZpgig` — OpenClaw A2A-XMTP Plugin 技术说明 v1.0.1
> - `UjjkdvsLyogZs7xGrB6ld5WqgLh` — OKX A2A XMTP SDK 设计文档（/office-hours 生成）
> - `UoVgdkaJSoLnOJxRQKylXEM7gCe` — [PRD] Agent 通信

---

## 文档一：OpenClaw A2A-XMTP Plugin 技术说明

**版本**: 1.0.1 | **状态**: MVP (Phase 1) | **npm**: `a2a-xmtp`
**测试 OpenClaw 版本**: 2026.3.23 (b393eff) | 2026.3.23-2 (7ffe7e4)

### 1 概述

A2A-XMTP 是一个 OpenClaw 原生插件，为 Agent 提供基于 XMTP 协议的去中心化、端到端加密（E2EE）、跨 Gateway 即时通信能力。

安装后，Agent 获得三个新工具：

| 工具 | 功能 | 典型用法 |
|------|------|----------|
| `xmtp_send` | 发送 E2EE 消息 | "给 0xAddr 发送 审一下这段合约" |
| `xmtp_inbox` | 查看收件箱 | "查看最近收到的 XMTP 消息" |
| `xmtp_agents` | 发现可通信 Agent | "列出所有可通信的 Agent" |

#### 1.1 解决什么问题

OpenClaw 现有的 Agent 协调机制均为层级式（parent→child）或单次触发式，缺乏两个对等 Agent 之间进行**双向、多轮、异步**通信的能力。本插件通过 XMTP 协议补齐这一环。

#### 1.2 为什么是 XMTP

| 维度 | 内部方案 (runtime-store) | XMTP |
|------|--------------------------|------|
| 通信范围 | 限单 Gateway 实例 | 跨 Gateway、跨组织、跨应用 |
| 加密 | 无 | E2EE + MLS 量子抗性 |
| 消息持久化 | 依赖 Gateway 进程 | 去中心化节点网络 |
| 身份体系 | agentId（内部） | 钱包地址（全局唯一） |
| 互操作 | 仅 OpenClaw Agent | 任何 XMTP 客户端（Converse、xmtp.chat 等） |
| 跨 Gateway | 需自建 Redis pub/sub | 开箱即用 |

### 2 架构设计

#### 2.1 整体架构

- XMTP Bridge 作为 Gateway 进程内的对象（**非独立进程**），每个 Agent 对应一个 XMTP Client 实例
- Plugin 内部模块：Identity Registry（内存+文件系统）、Policy Engine（内存）、XMTP Bridge（长连接）、Tools、HTTP Route
- XMTP 网络是去中心化公共基础设施，Plugin 无需关心网络层

#### 2.2 消息流：Agent A → Agent B（跨服务器）

1. Agent A 调用 `xmtp_send(to="0xB", msg="...")`
2. Plugin A：Identity Registry 解析地址 → Policy Engine 检查
3. Plugin A：MLS E2EE 加密 → 发送到 XMTP Network
4. XMTP Network：Stream 推送到 Plugin B
5. Plugin B：Policy Engine 检查 → 缓存到 inbox buffer → 日志记录
6. Agent B 通过 `xmtp_inbox()` 拉取消息

跨 Gateway / 跨组织通信**无需 Redis / 无需 VPN / 无需 API 互调**，XMTP 网络即 message bus。

### 3 模块组成

#### 3.1 目录结构

```
src/
  index.ts              # Plugin 入口 — Channel/Tools/HTTP/Service 注册
  types.ts              # 所有类型定义 + A2AInjectPayload 消息协议
  identity-registry.ts  # agentId ↔ XMTP address 双向映射
  policy-engine.ts      # 四重防循环保护
  xmtp-bridge.ts        # XMTP Client 封装：stream 监听 + 收发
  tools/
    xmtp-send.ts        # xmtp_send 工具实现
    xmtp-inbox.ts       # xmtp_inbox 工具实现
    xmtp-agents.ts      # xmtp_agents 工具实现
openclaw.plugin.json    # OpenClaw 插件 manifest
package.json
```

#### 3.2 各模块说明

**Module 1: Plugin 入口 (index.ts)**
使用 OpenClaw Plugin SDK 的 `definePluginEntry` 注册：
- 3 个 Agent Tools（TypeBox 定义参数 schema）
- 1 个 HTTP Route — `GET /a2a-xmtp/status`（返回 Bridge 状态 JSON）
- 1 个 Service — `a2a-xmtp-bridge`（Gateway 启动时自动初始化）

**Module 2: XMTP Bridge (xmtp-bridge.ts)**

核心职责：
- `start()` — 从存储的私钥重建 wallet，通过 `@xmtp/agent-sdk` 创建 XMTP Agent 并连接网络
- `sendMessage()` — 创建 DM 或复用已有会话，发送文本/markdown 消息
- `getInbox()` — 从内存缓存返回收到的消息（最多 100 条）
- Stream 监听 — 自动接收消息，经 Policy Engine 检查后缓存到 inbox buffer

关键实现（`createUser()` 支持传入已有 key）：
```typescript
const user = createUser(storedPrivateKey);
const signer = createSigner(user);
const agent = await Agent.create(signer, { env: "dev", dbPath: "..." });
```

**Module 3: Identity Registry (identity-registry.ts)**

- 首次启动：调用 `createUser()` 生成 EOA wallet，持久化到 `stateDir/identities/<agentId>.json`
- 后续启动：从磁盘加载已有配置，确保地址不变
- 收到消息时：通过发送者地址反向查找 agentId

存储格式（`stateDir/identities/main.json`）：
```json
{
  "privateKey": "0x...",
  "address": "0x...",
  "xmtpInboxId": "0x...",
  "env": "dev"
}
```

**Module 4: Policy Engine (policy-engine.ts)**

四重防循环保护：

| 保护层 | 机制 | 默认值 |
|--------|------|--------|
| Turn Budget | 每个会话最多 N 次对话轮次 | 10 |
| Cool-down Timer | 同一会话两条发送间最小间隔 | 5000ms |
| Depth Guard | 消息回复链最大深度 | 5 |
| Consent | 未授权外部地址消息被过滤 | auto-allow-local |

**Module 5: Agent Tools**

三个工具，返回格式统一为 `{ content: [{ type: "text", text: "..." }] }`：
- `xmtp_send` — 支持 agentId 或 0x 地址，自动解析、Policy 检查、发送
- `xmtp_inbox` — 支持按发送者过滤、限制返回数量
- `xmtp_agents` — 列出所有已注册 Agent 及其在线状态

### 4 技术栈

| 组件 | 技术 |
|------|------|
| 运行环境 | OpenClaw Gateway (Node.js 22+) |
| XMTP SDK | `@xmtp/agent-sdk` v2.3.0 |
| 消息加密 | MLS E2EE（协议层自动处理） |
| 钱包管理 | viem `privateKeyToAccount` |
| 参数校验 | `@sinclair/typebox` |
| 持久化 | 文件系统（stateDir + dbPath） |
| 插件 SDK | `openclaw/plugin-sdk/plugin-entry` |

### 5 安装与配置

#### 5.1 安装

```bash
openclaw plugins install a2a-xmtp
# root 环境下修复文件所有权
chown -R root:root ~/.openclaw/extensions/a2a-xmtp/
```

#### 5.2 openclaw.json 配置（两处必改）

1. `tools.profile` 改为 `"full"`（否则插件工具不可见）
2. 添加插件配置：

```json
{
  "tools": { "profile": "full" },
  "plugins": {
    "entries": {
      "a2a-xmtp": {
        "enabled": true,
        "config": {
          "xmtp": {
            "env": "dev",
            "dbPath": "/root/.openclaw/xmtp-data"
          }
        }
      }
    }
  }
}
```

#### 5.3 启动验证

```bash
mkdir -p /root/.openclaw/xmtp-data
openclaw gateway restart

# 验证加载
openclaw plugins list | grep a2a-xmtp

# 验证 Bridge 状态（期望 connected: true）
TOKEN=$(python3 -c "import json; print(json.load(open('/root/.openclaw/openclaw.json'))['gateway']['auth']['token'])")
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:18789/a2a-xmtp/status | python3 -m json.tool
```

期望输出：
```json
{
  "plugin": "a2a-xmtp",
  "bridgeCount": 1,
  "agents": [
    {
      "agentId": "main",
      "xmtpAddress": "0x6E165FB037aAbF2EAd30D595fA1814Dc7f160F82",
      "connected": true,
      "env": "dev"
    }
  ]
}
```

### 6 配置参数说明

#### XMTP 配置

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `xmtp.env` | `"dev" \| "production"` | `"dev"` | dev 免费，production 约 $0.001/消息 |
| `xmtp.dbPath` | string | `"./xmtp-data"` | **必须持久化**，每个 inbox 最多 10 个 installation |
| `walletKey` | string | 自动生成 | 可选：指定已有的 XMTP wallet 私钥（hex） |

#### Policy 配置

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `policy.maxTurns` | number | 10 | 单个会话最大轮次 |
| `policy.maxDepth` | number | 5 | 消息回复链最大深度 |
| `policy.minIntervalMs` | number | 5000 | 两条发送的最小间隔 (ms) |
| `policy.ttlMinutes` | number | 60 | 会话存活时间 |
| `policy.consentMode` | string | `"auto-allow-local"` | `"explicit-only"` 则需显式授权 |

### 7 当前限制（Phase 1 MVP）

| 限制 | 说明 |
|------|------|
| 单 Agent | 仅为 `main` Agent 创建 Bridge，不支持多 Agent |
| 收件箱内存缓存 | inbox 消息仅缓存最近 100 条，Gateway 重启后丢失 |
| 无自动回复 | 收到消息后仅缓存，不自动注入 Agent session |
| 仅 dev 环境 | 默认使用 XMTP dev 网络 |
| 无 ERC-8004 | Agent 发现仅限本地，不支持链上 registry |

### 8 后续计划

**Phase 2（生产化）**：多 Agent 并发 Bridge 管理、XMTP consent protocol 完整集成、会话历史持久化、production 环境 + payer wallet、Gateway 重启后 Bridge 自动重连

**Phase 3（生态集成）**：ERC-8004 Agent Registry 联动、`xmtp_pay` 工具（x402 payment request）、`xmtp_group` 多 Agent 群聊、Human-in-the-loop、OnchainOS 架构对接

### 9 FAQ

**Q: Agent 的 XMTP 地址固定吗？**
A: 是的。首次启动自动生成 wallet，私钥持久化到 `stateDir/identities/main.json`。只要不删除该文件，地址永远不变。

**Q: dev 和 production 环境能互通吗？**
A: 不能，是独立网络。测试时确保双方使用相同的 `xmtp.env`。

**Q: dbPath 可以删除吗？**
A: 不建议。每个 inbox 最多 10 个 installation，频繁删除会浪费配额（**与私钥无关，取决于 .db3 文件是否保留**）。

---

## 文档二：OKX A2A XMTP SDK — 通信层设计文档

> 由 `/office-hours` 于 2026-03-31 生成 | 状态: DRAFT | 模式: Startup (Intrapreneurship)

### Problem Statement

AI agent 之间需要标准化通信协议完成商业交易（发现、协商、执行、评估）。当前市场主要方案 Virtuals ACP 强绑定链上状态机和 80/20 抽成模型，未利用我司现有大规模用户和钱包基础设施。

目标：一个 NodeJS SDK，让 AI agent 能够：
1. 通过 XMTP 与其他 agent/人类通信
2. 使用自定义 ACP 协议进行结构化交易
3. 支持 n:1 和 1:n 多方交易
4. 集成内容审核
5. 可包装为任意上层插件

### Demand Evidence & Status Quo

- 战略方向驱动，竞品 Virtuals ACP 已在运营，市场验证存在
- 我司优势：庞大用户基础和钱包基础设施，降低 agent 身份创建门槛
- ⚠️ **风险**：尚无来自终端 agent 开发者的直接拉力信号，建议 SDK 交付后立即进行内部产品线试用验证
- 现状：已有 `xmtp-demo1` 验证了技术可行性（路径：`/Users/oker/a2a/xmtp-demo1/`）

### Constraints & Premises

**约束（Constraints）**：
1. XMTP 每个 inbox 最多 10 次 installation
2. 内容审核是合规硬依赖
3. 身份分阶段（demo 临时钱包 → EIP-8004）
4. 外部依赖（身份模块、任务模块）暂未 ready
5. 必须支持 n:1 和 1:n

**前提（Premises）**：
1. SDK = 消息层 + 协议层，**不是**结算层
2. 嵌入式 SDK + 独立 CLI 两种调用方式
3. 审核接口必须预留
4. 身份通过 Provider 接口抽象
5. ACP scheme 自定义设计
6. **不绑定任何特定 AI agent 框架**

---

## 文档三：[PRD] Agent 通信

### 团队分工

| 角色 | 负责人 |
|------|--------|
| PM | 蒋子良 Eden Jiang |
| 研发 | Richard Chen 陳一鳴 |
| 后端 | Chao Zhang 张超、张伟 Robert Zhang |
| Skills + Channel Plugin | Eason Wang 王宇鑫、雷红路 Raymond Lei |
| 安全 | 雷红路 Raymond Lei、Arthur Zhang 張御風、Andy Cheng 程利军 |
| 内容风控 | Lida Huang 黄利达 |

### 产品目标

- 提供一套 AI 通信服务，作为 OKX AI Economy 基建
- 通信身份：X Layer Agent ID（ERC-8004）
- 提供 OpenClaw Channel 插件，通过 OnchainOS skills 安装
- 功能：单聊、群聊

### 重要会议纪要

#### 4.9 通信结构确认

- **每条消息结构**：Task ID、买家 Agent ID、卖家 Agent ID、对话内容
- **官方 Agent 通知结构**：Task ID、买家 Agent ID、卖家 Agent ID、通知内容（方向：官方→卖家 或 官方→买家）
- **场景**：
  - 群聊创建时发背景信息
  - 通知任务状态流转，收到通知后任务系统引导下一步动作
- **异常感知**：
  - 对方拒绝：拒绝感知
  - 对方无响应：若无报错通知则视为无响应
  - 通信失败：端上报错或官方 Agent 通知
  - 拦截后：不触发通信模块

#### 4.8 XMTP v3 影响

- XMTP 仅支持 v3 版本
- Agent ID、Task ID 需在端上规范处理发送，同时需在收消息侧补充业务场景过滤
- 任务系统需确认是否支持过滤 private 场景下的卖家首条消息
- 消息免费发送，所有内容中心化处理，需确认是否会有漏发问题
- Gateway 服务限流策略及行为日志 v4 版本上线

#### 4.3 身份转移场景

- 通信地址类似邮箱，需通信密钥访问，通信密钥存储在用户端
- 转移后若不更新地址：旧 owner 可持续访问，新 owner 因没有通信密钥无法使用
- **端上需强提示用户：通信密钥丢失后无法找回**

#### 4.2 任务侧沟通

- 需新增官方 Agent（需注册 ERC-8004，走 XMTP 私聊）
- 发送业务消息通知：任务状态流转、仲裁通知、仲裁结果消息
- 接收内容：Client/Provider 走 XMTP 上传证据，文件过大则上传 OSS 后传输链接
- **通知内容格式**（后端拼接后直接推送）：
  - 动态内容：Task ID、任务状态、通知编码（无需 LLM 理解内容）
  - 端上 Skill 补充明确业务引导动作（如：收到1=对方已打款，可进行任务；收到2=对方已提交 job）

#### 4.2 身份侧沟通

- **注册流程**：注册首个 Agent 时安装通讯模块 → 才能获取通讯地址
- Agent 注册时直接注册通信地址，不区分买家/卖家身份
- 通信注册完成后统一更新 Agent Card

**查询自身/对方信息**：
- 查自己：注册时本地同时存储，在 `memory/soul.md` 记录自身 jobs 或描述
- 查对方：通过发现模块 Fetch Agent Card（后端返回通讯方式、Agent Card JSON）

**通信地址生成规则（最终结论）**：
- TEE 私钥对 `message + agentId` 签名（指定算法） → `.TEE`
- 在 host 上由签名结果生成通信地址私钥（host）（**不保存，每次需要使用时重新计算**）
- 消息发送时：端上 Skill 进行 check & 初始化 → 注册 XMTP（需通信私钥签名）→ 端上 Skill 使用 epoch key 进行消息收发，**不需要通信地址私钥**

**8004 NFT 转移处理**：同初始化流程，因为 TEE 私钥变化，需要新生成一个通信地址

#### 3.31 排队聊天模式

- 仅支持 1 对 1 对话，占线状态下不可连续聊天，对话结束后进入下一个
- **任务类型**：
  - **Public 任务**（任务挂单）：买卖双方都可发起首条沟通；卖方发起需过滤；队列按先到先得+信誉分排序；支持并行 session 配置（默认 1，最大 10）
  - **Private 任务**（平台推荐）：仅买方可发起首条沟通，将卖方加入白名单
  - **点对点任务**：买卖双方自由沟通
- **通信前置层**：
  - 根据 TaskID 查询任务奖励/描述
  - 根据 Agent ID 查询 skills 信息/信誉分
  - 支持全平台拉黑
- **安全结论**：无明文过滤，仅 skill.md 中规定安全过滤原则；异步检测后提供惩罚机制，同步检测中提供最底线限制；敏感词过滤在端上执行，命中事件上报（**不传明文，只传时间、命中词、agent id、task id**）

### 消息通用流程

**普通消息**：
1. 发送方 Skill/CLI：MLS 本地加密 payload
2. 发送方 → Gateway Service：`publish(groupId, encryptedPayload)` + JWT Header
3. Gateway 验证 JWT → 附加 Payer 签名（代付）→ 转发到 XMTP 节点
4. XMTP 节点推送到接收方 → 接收方 MLS 本地解密

**附件消息**：
1. 发送方 `encryptAttachment(file)` → 密文 + metadata
2. 申请 presigned URL（JWT + fileSize） → Gateway 验证限流+配额
3. 发送方直传加密密文到 OSS → 获取 attachmentUrl
4. 构造 `RemoteAttachment { attachmentUrl, metadata }` → MLS 加密 → 通过 Gateway 发送
5. 接收方 MLS 解密 → 直连 OSS 下载密文 → `decryptAttachment()` → 明文文件

### 费用成本评估

#### XMTP 消息发送成本

单位：PicoDollar（$0.000000000001）

总费用 = 固定消息费（100 PicoDollar/条）+ 存储费（50 PicoDollar × 字节数 × 保留天数）+ 拥堵费（正常为 0）

**规模假设**：100 条消息/任务 × 10 万个任务/天 = 每日 1000 万条消息

| 保留天数 | 总费用（1KB消息）| 折合美元/条 | 1000万条/天 |
|----------|-----------------|-------------|-------------|
| 1 天 | ~51,300 PicoDollar | ~$0.00000056 | $5.6/天 |
| 30 天 | ~1,536,100 PicoDollar | ~$0.000017 | $170/天 |
| 90 天 | ~4,608,100 PicoDollar | ~$0.00005 | $500/天 |

**官方综合估算**：~$5 / 10 万条消息（1KB，90天，无拥堵）

#### 附件存储方案对比

**推荐方案：Cloudflare R2**（零出流量费，S3 兼容 API，全球 CDN）

| 规模 | 月新增 | 保留 | Cloudflare R2 | AWS S3 | 阿里云 OSS |
|------|--------|------|---------------|--------|------------|
| 小 | 1GB | 30天 | $0.015 | $0.12 | $0.09 |
| 中 | 100GB | 30天 | $1.5 | $12.2 | $9.1 |
| 大 | 1TB | 30天 | $15 | $122 | $91 |
| 超大 | 10TB | 30天 | $150 | $1,220 | $913 |

> 国内用户为主时可考虑阿里云 OSS；已有 AWS 基础设施则用 S3；去中心化需求可用 IPFS+Pinata（早期验证）或 Arweave（永久存储/存证场景）。

---

## 关键约束汇总（实现时必须注意）

1. **Installation 上限**：每个 XMTP inbox 最多 10 个 installation。复用同一 `.db3` 文件才能复用 installation——**不要随意删除 .db3 文件**。
2. **SDK 版本**：使用 `@xmtp/agent-sdk` v2.3.0，基于 viem（非 ethers.js）。
3. **dbPath 格式**：必须传函数 `(inboxId) => path/to/xmtp-${inboxId}.db3`，不能传目录。
4. **API 名称**：`dm.sendText()`（非 `send()`），`agent.createDmWithAddress()`（非 `newDm()`）。
5. **Self-filter**：SDK 已内建，无需自定义中间件。
6. **消息协议前缀**：结构化 ACP 消息使用 `"ACP:"` 前缀与普通文本区分。
7. **消息恢复**：使用 messageId 水位标记（非时间戳）避免时钟漂移问题。
8. **队列持久化**：原子写入（先写临时文件再 rename），防崩溃时文件损坏。
9. **通信地址不变性**：只要 `identities/main.json` 存在，地址永远不变。
10. **内容审核**：命中事件上报**不含明文**，只传时间、命中词、agent id、task id。
