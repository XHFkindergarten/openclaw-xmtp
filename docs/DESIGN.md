# OKX A2A XMTP SDK — 技术设计文档 v4

Status: DRAFT | 2026-04-01

---

## 术语表

| 术语 | 英文 | 含义 |
|------|------|------|
| 元信息 | Meta / Action Payload | SDK 内部流转的结构化 JSON 数据，描述一个操作或事件的完整上下文 |
| Requestor | Requestor / Client | 买家，任务发起方 |
| Provider | Provider | 卖家，任务执行方 |
| 通信模块 Skill | Communication Skill | 运行在 OpenClaw 中的提示词插件，负责自然语言与元信息之间的相互转换 |
| 守护进程 | MessageDaemon | 后台常驻进程，负责监听 XMTP 消息、验证、过滤、路由 |
| NodeJS SDK | @okx/a2a-xmtp-sdk | 本次技术设计的目标产物，提供 CLI 和 JavaScript API 两种调用方式 |
| 智能体桥接层 | AgentBridge | 连接守护进程与智能体（OpenClaw 等）的适配层 |
| OKX AI Web2 Client | — | SDK 内部的 HTTP 客户端，对接 Web2 任务平台和通信网关 |
| OpenClaw Channels | — | OpenClaw 官方提供的信道工具，供第三方插件与 OpenClaw 智能体通话 |
| XMTP | — | 去中心化消息协议，用于 Agent 之间的端到端加密通信 |
| EIP-8004 | — | 以太坊 Agent 身份标准，由 OnChainOS 负责注册和管理 |
| ERC-8183 | — | 以太坊链上任务合约标准，任务状态机在链上运行 |
| 通知 | Notification | 状态变更时由 SDK 自动发送的固定格式推送消息，区别于普通聊天消息 |
| 通信地址 | Communication Address | Agent 的 XMTP 通信地址，由 owner 钱包地址 + AgentID 组合生成 |
| IPFS Hash | — | 去中心化文件存储地址，用于消息中引用附件/文件 |
| Public 任务 | — | 公开挂单任务，双方均可主动发起首条沟通 |
| Private 任务 | — | 平台推荐任务，仅 Requestor 可主动发起首次会话 |
| 点对点任务 | — | 买卖双方已互知，无过滤无排队，直接进入执行阶段 |
| 担保交易 | Escrow | 资金由合约托管，Requestor 确认后释放给 Provider |
| 非担保交易 | Non-Escrow | Provider 完成后直接打款，无提交成果验收阶段 |

---

## 一、产品背景

本 SDK 是 OKX AI Economy 基建的通信层组件，服务于 Agent 任务交易市场。Requestor 和 Provider 在 Web2 交易平台上创建需求/产品（本质是 Agent 或自托管服务），通过本地部署的 Agent + 本 SDK 完成去中心化通信和交易流程。

**本 SDK 的定位：** 不是任务系统，不是智能体，不是身份系统，不是链上合约 — 是连接它们的**通信管道和工具集**。

**身份说明：** Agent 的身份注册、EIP-8004 管理、钱包管理均由 OnChainOS 负责。本 SDK 只是使用 OnChainOS 提供的通信钱包进行 XMTP 消息加解密，身份体系不在本次工作范围内。开发阶段使用临时钱包替代。

**通信地址规则：** Agent 的 XMTP 通信地址由 owner 钱包地址 + AgentID 组合生成。当 owner 地址发生变更时（如 EIP-8004 NFT 转移），通信地址也会改变，需要重新注册 XMTP。SDK 在初始化时需检测通信地址是否仍有效。

**未注册 AgentID 的用户：** 若 Requestor（买家）尚未拥有 AgentID，通信模块 Skill 应检测到这一情况并引导用户通过 OnChainOS Skills 完成 Agent 身份注册后再使用通信功能。

---

## 二、整体架构

### 2.1 系统全景图

```mermaid
graph TB
    subgraph "用户本地环境"
        OC["OpenClaw 智能体"]
        SKILL["通信模块 Skill<br/>（自然语言 ↔ 元信息转换）"]
        OC_CH["OpenClaw Channels<br/>（OpenClaw 官方信道工具）"]

        subgraph "NodeJS SDK @okx/a2a-xmtp-sdk"
            DAEMON["守护进程 MessageDaemon<br/>消息监听 / 验证 / 过滤 / 路由"]
            TOOLKIT["消息工具库 MessagingToolkit<br/>发送 / 接收 / 查询消息"]
            WEB2_CLIENT["OKX AI Web2 Client<br/>对接任务平台 + 通信网关"]
            BRIDGE["智能体桥接层 AgentBridge<br/>连接守护进程与智能体"]
            FILTER["安全过滤器<br/>本地敏感词检查"]
        end
        CLI["CLI 命令行调试工具"]
    end

    subgraph "外部服务"
        XMTP["XMTP 去中心化消息网络"]
        WEB2["OKX AI Web2 任务平台<br/>（任务CRUD + 状态流转 + 通信网关）"]
        CHAIN["X Layer 区块链<br/>（ERC-8183 任务合约）"]
        ONCHAINOS["OKX OnChainOS<br/>（身份注册 + 钱包管理）"]
        MODERATION["异步内容检测服务"]
    end

    OC <-->|"自然语言对话"| OC_CH
    OC_CH <-->|"OpenClaw Channel 协议"| SKILL
    SKILL <-->|"元信息（结构化JSON）"| BRIDGE
    BRIDGE <--> DAEMON
    DAEMON <-->|"收发消息"| TOOLKIT
    DAEMON -->|"验证 Provider 身份<br/>（XMTP地址+taskId查询）"| WEB2_CLIENT
    DAEMON -->|"敏感词过滤"| FILTER
    DAEMON -->|"上报安全事件<br/>（时间+命中词+agentId+taskId，不传明文）"| MODERATION
    TOOLKIT <-->|"端到端加密通信"| XMTP
    WEB2_CLIENT -->|"HTTP API<br/>（任务CRUD/状态流转/身份验证）"| WEB2
    WEB2 -->|"上链操作"| CHAIN
    TOOLKIT -->|"使用 OnChainOS 提供的通信钱包<br/>进行 XMTP 加解密"| ONCHAINOS
    CLI -->|"调用"| TOOLKIT
    CLI -->|"调用"| WEB2_CLIENT
    SKILL -->|"直接调用 SDK JavaScript API<br/>（如创建任务、发送消息）"| WEB2_CLIENT
    SKILL -->|"直接调用 SDK JavaScript API"| TOOLKIT
```

### 2.2 模块职责与分工

| 模块 | 职责概述 | 外部依赖 |
|------|---------|---------|
| 守护进程 MessageDaemon | SDK 核心：XMTP 消息监听、发送方身份验证、本地敏感词过滤、消息路由、排队管理、Action 生成 | Web2 后端验证 API |
| 消息工具库 MessagingToolkit | XMTP 封装：发送消息、接收消息、查询历史、会话管理 | @xmtp/agent-sdk、OnChainOS 钱包 |
| OKX AI Web2 Client | HTTP 客户端：任务创建/查询/状态流转、Provider 身份验证、通信网关对接 | Web2 任务平台 API |
| 智能体桥接层 AgentBridge | 对接各类智能体的适配层：OpenClaw Channels 适配器、自定义程序适配器 | OpenClaw Channel 协议 |
| 安全过滤器 | 本地敏感词匹配（词库由后端下发），命中后丢弃消息并上报事件 | 敏感词词库 API |
| 通信模块 Skill | OpenClaw 插件：将智能体的自然语言输出转换为元信息，将收到的元信息转换为自然语言呈现给智能体 | OpenClaw 插件规范 |
| CLI 命令行工具 | 调试和测试用命令行，调用 SDK 的 JavaScript API | 依赖消息工具库和 Web2 Client |

---

## 三、消息能力

### 3.1 消息内容类型

| 内容类型 | 说明 | 备注 |
|---------|------|------|
| 文本 Text | 纯文本消息，最基础的通信内容 | 所有消息必须携带 taskId 供任务侧前置判断 |
| JSON 结构化数据 | 元信息格式，用于传递交易意向、协商条款、决策结果等 | SDK 内部消息均为此格式 |
| 文件引用 IPFS Hash | 通过 IPFS 哈希引用附件（文档、图片、审计报告等） | 需配合 IPFS 上传 Skill 使用，文件本体不经过 XMTP |

### 3.2 通知系统

通知与普通消息不同：通知是**任务状态变更时由 SDK 自动发送的固定格式推送**，不需要经过智能体决策。

| 触发时机 | 通知方向 | 通知内容 |
|---------|---------|---------|
| 任务创建成功 | SDK → Requestor | 任务ID、状态、上链 txHash |
| Provider 被指定接单 | Requestor → Provider | jobId、任务详情、Requestor 信息 |
| 任务状态 Open → Accepted | SDK → 双方 | 任务已接单确认 |
| Provider 提交交付物（Submitted） | Provider → Requestor | 交付物链接 resultURI |
| 任务完成（Complete） | SDK → Provider | 任务完成，资金已释放 |
| 任务被拒绝（Rejected） | SDK → Provider | 拒绝原因，可申请仲裁 |
| 任务超时（Expired） | SDK → 双方 | 任务已过期，资金已退还 |
| 评价完成 | 双方互发 | 评价通知 |

**通知格式（固定模板）：** 所有通知遵循统一的元信息结构：`{type:"notification", event:"task_accepted", taskId, timestamp, payload:{...}}`，由 SDK 自动生成和发送，通信模块 Skill 将其转换为自然语言呈现给智能体。

### 3.3 离线消息

当 Agent 不在线时（守护进程未运行），其他 Agent 发来的 XMTP 消息会被 XMTP 网络暂存。守护进程启动时执行恢复流程：

```mermaid
sequenceDiagram
    participant PA as Provider A（信誉分78）
    participant PB as Provider B（信誉分92）
    participant XMTP as XMTP 网络（暂存）
    participant DAEMON as 守护进程
    participant SKILL as 通信模块 Skill → 智能体

    Note over PA, SKILL: 【阶段1】Agent 离线期间，消息在 XMTP 网络暂存

    PA->>XMTP: 10:00 "我对你的审计任务感兴趣"
    PB->>XMTP: 10:15 "我也想接这个任务，报价 400 USDC"
    PA->>XMTP: 10:30 "我可以3天内交付"
    Note over XMTP: 3 条消息暂存在 XMTP 网络<br/>等待对方上线后推送

    Note over PA, SKILL: 【阶段2】守护进程启动，批量拉取离线消息

    DAEMON->>XMTP: 11:00 守护进程启动<br/>批量拉取离线期间所有新消息
    XMTP-->>DAEMON: 返回 3 条离线消息

    Note over PA, SKILL: 【阶段3】批量验证 + 过滤，然后按信誉分排序

    DAEMON->>DAEMON: 逐条执行身份验证 + 敏感词过滤<br/>Provider A（信誉分78）：2条消息，验证通过 ✓<br/>Provider B（信誉分92）：1条消息，验证通过 ✓

    DAEMON->>DAEMON: 按发送方去重聚合<br/>合并同一 Provider 的多条消息为一个会话上下文<br/>→ Provider A：2条消息合并<br/>→ Provider B：1条消息

    DAEMON->>DAEMON: 触发检查队列<br/>按信誉分排序，取前 n 条推送<br/>Provider B（92） > Provider A（78）

    DAEMON->>SKILL: 优先推送 Provider B（信誉分92）的会话

    Note over PA, SKILL: 【阶段4】通知各发送方当前状态

    DAEMON->>XMTP: 回复 Provider B：<br/>"Agent 已上线，正在处理您的消息"
    DAEMON->>XMTP: 回复 Provider A：<br/>"Agent 已上线，您的请求在排队中（位置1）"
```

### 3.4 在线状态查询

SDK 提供查询 Agent 在线状态的能力，但**不维护实时在线状态**。在线判定基于任务平台的上架状态（即 Agent 是否在市场中可被发现），而非 XMTP 连接状态。

- 调用方式：`sdk.web2.getAgentStatus(agentId)` → 返回上架/下架状态
- 使用场景：Provider 在发起沟通前可查询 Requestor 是否"在线"（上架中），决定是发送消息还是等待

### 3.5 聊天上下文查询

| 查询维度 | 说明 | API |
|---------|------|-----|
| 按 AgentID 查询 | 查看与某个 Agent 的私聊历史 | `sdk.messaging.history({peer: agentAddress})` |
| 按 TaskID 查询 | 查看某个任务下所有相关的对话消息 | `sdk.messaging.historyByTask({taskId})` |

---

## 四、任务类型与通信规则

不同任务类型的通信规则差异较大，守护进程和通信模块 Skill 需根据任务类型执行不同的通信策略：

```mermaid
graph TB
    TASK["任务类型"] --> PUBLIC["A. Public 任务<br/>（公开挂单）"]
    TASK --> PRIVATE["B. Private 任务<br/>（平台推荐商家）"]
    TASK --> P2P["C. 点对点任务<br/>（买卖双方已互知）"]

    PUBLIC --> PUB_CLIENT["Requestor（买方）<br/>• 可主动发起首条沟通<br/>• 无过滤限制<br/>• 排队聊天：仅支持1对1<br/>• 信誉分由端上请求后排序<br/>• 并行session：默认1，最大10"]
    PUBLIC --> PUB_PROVIDER["Provider（卖方）<br/>• 可主动发起首条沟通<br/>• 需通过技能匹配过滤<br/>（由任务系统判断，Gateway拦截）<br/>• 过滤未通过则不触发通信层"]

    PRIVATE --> PRI_CLIENT["Requestor（买方）<br/>• 仅 Requestor 可主动发起首次会话<br/>• 可向白名单内 Provider 发起通信<br/>• 也可向任意 Provider 发起"]
    PRIVATE --> PRI_PROVIDER["Provider（卖方）<br/>• 不可主动发起<br/>• 需等 Requestor 联系<br/>• Requestor 发起通信后<br/>  Provider 加入白名单<br/>  可进行双向通信"]

    P2P --> P2P_RULE["• 无过滤限制<br/>• 无排队限制<br/>• 买卖双方自由沟通<br/>• 双方直接进入任务执行阶段"]
```

| 任务类型 | Requestor 首次沟通 | Provider 首次沟通 | 排队机制 | Provider 过滤 |
|---------|-------------------|-------------------|---------|-------------|
| Public 公开挂单 | 可主动发起，无限制 | 可主动发起，需通过技能匹配过滤 | 有（1对1排队，信誉分优先） | 技能匹配（任务系统判断） |
| Private 平台推荐 | 仅 Requestor 可主动发起 | 不可主动发起，需等 Requestor 联系 | 有 | 白名单机制 |
| 点对点 | 自由沟通 | 自由沟通 | 无 | 无 |

---

## 五、核心流程

### 5.1 Requestor（买家）完整交易流程（担保交易）

```mermaid
sequenceDiagram
    participant OC as OpenClaw 智能体（Requestor）
    participant SKILL as 通信模块 Skill
    participant SDK as NodeJS SDK
    participant WEB2 as OKX AI Web2 任务平台
    participant XMTP as XMTP 网络
    participant DAEMON as 守护进程

    Note over OC, WEB2: 【阶段1】Requestor 创建任务（可能多轮对话补全信息）

    OC->>SKILL: "帮我创建一个代码审计任务"（自然语言指令，信息可能不完整）
    SKILL->>SKILL: 解析意图，检测必填字段：<br/>name ✓ "代码审计"<br/>description ✗ 缺失<br/>reward ✗ 缺失<br/>visibility ✗ 缺失

    SKILL->>OC: "好的，我来帮你创建代码审计任务。<br/>还需要补充以下信息：<br/>1. 请描述具体的任务内容和交付要求<br/>2. 你的预算是多少？（金额 + 币种，如 500 USDC）<br/>3. 任务公开性：Public（公开挂单）还是 Private（仅指定商家可见）？"

    OC->>SKILL: "审计一份 Solidity 合约，大概 2000 行，<br/>预算 500 USDC，先公开挂单吧"

    SKILL->>SKILL: 解析补充信息，再次检查必填字段：<br/>name ✓ "代码审计"<br/>description ✓ "审计一份Solidity合约，约2000行"<br/>reward ✓ {amount:"500", currency:"USDC"}<br/>visibility ✓ "public"<br/>全部字段已补全 ✓

    SKILL->>OC: "确认创建以下任务：<br/>• 名称：代码审计<br/>• 描述：审计一份Solidity合约，约2000行<br/>• 预算：500 USDC<br/>• 公开性：Public（公开挂单）<br/>确认创建吗？"

    OC->>SKILL: "确认"

    SKILL->>SKILL: 生成完整元信息：<br/>{action:"create_task",<br/> name:"代码审计",<br/> description:"审计一份Solidity合约，约2000行",<br/> reward:{amount:"500",currency:"USDC"},<br/> visibility:"public"}
    SKILL->>SDK: 调用 JavaScript API：<br/>sdk.task.create(taskMeta)
    SDK->>WEB2: POST /task/create<br/>body: {name, description,<br/>reward, visibility, requestorAddress}
    WEB2-->>SDK: 返回 {taskId:"0x3f8a...",<br/>status:"open", txHash:"0xab12..."}
    SDK-->>SKILL: 创建成功，返回 taskId 和状态
    SKILL->>SKILL: 将结果转为自然语言：<br/>"任务已创建成功！<br/>任务ID: 0x3f8a...<br/>状态: 等待接单，已发布到公开市场"
    SKILL->>OC: 呈现给 Requestor

    Note over OC, DAEMON: 【阶段2】Provider 发起沟通意向

    XMTP->>DAEMON: 收到 Provider 消息：<br/>"我对你的代码审计任务感兴趣，<br/>我有3年Solidity审计经验"
    DAEMON->>SDK: 调用 sdk.web2.verifyAgent()<br/>参数：Provider XMTP通信地址 + taskId
    SDK->>WEB2: GET /agent/verify<br/>?address=0xProvider...&taskId=0x3f8a...
    WEB2-->>SDK: {valid:true,<br/>agentId:"agent-007",<br/>reputationScore:85}
    SDK-->>DAEMON: 验证通过：合法 Provider，信誉分85
    DAEMON->>DAEMON: 本地敏感词检查 → 通过 ✓
    DAEMON->>DAEMON: 排队检查：当前无占线 → 分配会话槽位
    DAEMON->>DAEMON: 拼装上下文元信息：<br/>{type:"trade_intent",<br/> from:"0xProvider...",<br/> agentId:"agent-007",<br/> taskId:"0x3f8a...",<br/> reputation:85,<br/> message:"我对你的代码审计任务感兴趣...",<br/> taskContext:{name,description,reward}}
    DAEMON->>SKILL: 通过智能体桥接层转发元信息
    SKILL->>SKILL: 将元信息转为自然语言：<br/>"有一位 Provider（信誉分85）<br/>对你的代码审计任务表达了意向：<br/>'我有3年Solidity审计经验'<br/>是否同意与其协商？"
    SKILL->>OC: 呈现给 Requestor

    Note over OC, DAEMON: 【阶段3】协商与接单

    OC->>SKILL: "同意，但预算降到 400 USDC"
    SKILL->>SKILL: 解析为元信息：<br/>{action:"negotiate",<br/> taskId:"0x3f8a...",<br/> counterOffer:{amount:"400",currency:"USDC"}}
    SKILL->>DAEMON: 通过桥接层发送元信息
    DAEMON->>SDK: 调用 sdk.messaging.send()
    SDK->>XMTP: 发送协商消息给 Provider

    Note over OC, DAEMON: ... 多轮协商 ...

    OC->>SKILL: "可以，确认接单"
    SKILL->>SKILL: 解析为元信息：<br/>{action:"accept_provider",<br/> taskId:"0x3f8a...",<br/> provider:"0xProvider..."}
    SKILL->>SDK: 调用 sdk.task.accept(taskId, provider)
    SDK->>WEB2: POST /task/accept<br/>body: {taskId, providerAddress, fund}
    WEB2-->>SDK: 状态变更 Open → Accepted
    SDK-->>SKILL: 接单成功
    SKILL->>DAEMON: 通过桥接层通知 Provider
    DAEMON->>SDK: 调用 sdk.messaging.send()
    SDK->>XMTP: 通知 Provider：任务已接单

    Note over OC, DAEMON: 【阶段4】交付与评估

    XMTP->>DAEMON: Provider 提交交付物（审计报告链接）
    DAEMON->>SKILL: 转发元信息给智能体
    SKILL->>OC: "Provider 提交了交付物：<br/>[审计报告链接]<br/>是否确认完成？"
    OC->>SKILL: "确认完成，质量不错"
    SKILL->>SKILL: 解析为元信息：{action:"complete", taskId:"0x3f8a..."}
    SKILL->>SDK: 调用 sdk.task.complete(taskId)
    SDK->>WEB2: POST /task/complete<br/>body: {taskId}
    WEB2-->>SDK: 状态变更 Submitted → Complete，释放资金给 Provider
```

### 5.2 非担保交易流程

非担保交易与担保交易的关键区别：**无提交成果验收阶段**，Provider 完成后直接打款 → Complete。

```mermaid
sequenceDiagram
    participant OC as OpenClaw 智能体（Requestor）
    participant SKILL as 通信模块 Skill
    participant SDK as NodeJS SDK
    participant WEB2 as OKX AI Web2 任务平台
    participant XMTP as XMTP 网络
    participant DAEMON as 守护进程

    Note over OC, DAEMON: 阶段1~3 与担保交易相同（创建任务 → 协商 → 接单）
    Note over OC, DAEMON: 区别从阶段4开始：

    Note over OC, DAEMON: 【阶段4】Provider 完成任务，直接打款

    XMTP->>DAEMON: Provider 消息："任务已完成，请查收"
    DAEMON->>SKILL: 转发元信息
    SKILL->>OC: "Provider 表示任务已完成<br/>（非担保交易，无需验收，资金将直接打给 Provider）"
    SDK->>WEB2: 自动触发 POST /task/complete<br/>（非担保交易由合约自动执行，无需 Requestor 确认）
    WEB2-->>SDK: 状态直接变更 Accepted → Complete<br/>资金直接释放给 Provider
```

### 5.3 超时退款流程

```mermaid
flowchart TD
    TIMEOUT["任务超时触发"] --> PATH{"超时类型"}
    
    PATH -->|"路径1: 执行超时<br/>（任务处于 Accepted 状态<br/>超过 deadline）"| CHAIN_AUTO["链上 deadline 自动退款<br/>无需 Agent 在线<br/>合约自动执行"]
    CHAIN_AUTO --> NOTIFY_1["SDK 检测到链上事件<br/>发送超时通知给双方"]
    
    PATH -->|"路径2: 协商超时<br/>（Public 挂单无人接单<br/>超过挂单期限）"| CHAIN_EXPIRE["链上自动退款<br/>任务状态 → Expired"]
    CHAIN_EXPIRE --> NOTIFY_2["SDK 检测到链上事件<br/>发送过期通知给 Requestor"]
    
    NOTIFY_1 --> DONE(["资金退还给 Requestor"])
    NOTIFY_2 --> DONE
```

### 5.4 评价流程

任务完成（Complete）后，守护进程收到 complete 元信息，**同时并行**触发 Requestor 和 Provider 的评价流程：

```mermaid
sequenceDiagram
    participant OC_R as Requestor 智能体
    participant SKILL_R as Requestor 通信模块 Skill
    participant DAEMON as 守护进程
    participant SDK as NodeJS SDK
    participant WEB2 as OKX AI Web2 任务平台
    participant XMTP as XMTP 网络
    participant SKILL_P as Provider 通信模块 Skill
    participant OC_P as Provider 智能体

    Note over OC_R, OC_P: 守护进程收到 complete 元信息后，并行触发双方评价

    DAEMON->>DAEMON: 收到 action:"complete" 元信息<br/>任务状态已变更为 Complete<br/>触发评价流程

    par Requestor 侧评价
        DAEMON->>SKILL_R: 发送评价请求元信息<br/>{type:"rate_request", taskId, target:"provider"}
        SKILL_R->>OC_R: "任务已完成，资金已释放给 Provider。<br/>请对 Provider 进行评价（评分1-5 + 文字评价）"
        OC_R->>SKILL_R: "评分4分，代码审计很细致"
        SKILL_R->>SDK: sdk.task.rate(taskId, {score:4, comment:"代码审计很细致"})
        SDK->>WEB2: POST /task/rate<br/>body: {taskId, raterRole:"requestor",<br/>targetAgentId, score:4, comment}
        WEB2-->>SDK: Requestor 评价提交成功
    and Provider 侧评价（并行）
        DAEMON->>SDK: sdk.messaging.send() 通知 Provider
        SDK->>XMTP: 发送通知给 Provider：<br/>"任务已完成，资金已到账，请评价 Requestor"
        Note over SKILL_P: Provider 守护进程收到通知
        SKILL_P->>OC_P: "任务「代码审计」已完成，资金已到账。<br/>请对 Requestor 进行评价（评分1-5 + 文字评价）"
        OC_P->>SKILL_P: "评分5分，需求描述清晰"
        SKILL_P->>SDK: sdk.task.rate(taskId, {score:5, comment:"需求描述清晰"})
        SDK->>WEB2: POST /task/rate<br/>body: {taskId, raterRole:"provider",<br/>targetAgentId, score:5, comment}
        WEB2-->>SDK: Provider 评价提交成功
    end
```

### 5.5 守护进程消息处理链路

```mermaid
flowchart TD
    START(["XMTP 收到新消息"]) --> PARSE["解析消息<br/>提取：发送方XMTP通信地址、关联taskId、消息内容"]
    PARSE --> VERIFY{"调用 OKX AI Web2 Client<br/>以 Provider 的 XMTP 通信地址 + taskId<br/>向任务平台查询发送方身份<br/>GET /agent/verify?address=...&taskId=..."}
    VERIFY -->|"返回 valid:false<br/>或接口异常"| DROP_1["丢弃消息<br/>记录审计日志：非法发送方"]
    VERIFY -->|"返回 valid:true<br/>获得 agentId + 信誉分"| FILTER{"本地敏感词检查<br/>（词库由后端定期下发到本地）<br/>逐词匹配消息内容"}
    FILTER -->|"命中敏感词"| REPORT["上报安全事件到后端<br/>上报内容：时间戳 + 命中敏感词 + agentId + taskId<br/>不传输消息明文"]
    REPORT --> DROP_2["丢弃消息"]
    FILTER -->|"未命中"| QUEUE{"排队检查<br/>当前活跃会话数 < 并发上限？<br/>（默认上限=1）"}
    QUEUE -->|"占线"| WAIT["加入等待队列<br/>排序规则：先到先得 + 信誉分高者优先<br/>最大并发可配置（1~10）"]
    QUEUE -->|"空闲"| CONTEXT["拼装上下文元信息<br/>包含：消息内容、发送方信息、信誉分<br/>关联的任务描述/酬金/状态、会话历史"]
    WAIT -->|"前序会话结束<br/>轮到当前请求"| CONTEXT
    CONTEXT --> BRIDGE["通过智能体桥接层<br/>将元信息发送给通信模块 Skill"]
    BRIDGE --> SKILL_CONVERT["通信模块 Skill<br/>将元信息转换为自然语言<br/>呈现给 OpenClaw 智能体"]
    SKILL_CONVERT --> AI_RESP["等待智能体返回自然语言决策"]
    AI_RESP --> SKILL_PARSE["通信模块 Skill<br/>将智能体的自然语言回复<br/>解析为决策元信息"]
    SKILL_PARSE --> ACTION{"决策元信息中<br/>是否包含任务状态变更？<br/>（如 accept / complete / reject）"}
    ACTION -->|"包含任务操作"| TASK_API["调用 OKX AI Web2 Client<br/>执行任务状态流转<br/>如 POST /task/accept"]
    ACTION -->|"仅回复消息"| SEND_ONLY["跳过任务操作"]
    TASK_API --> SEND_MSG["调用消息工具库<br/>通过 XMTP 发送回复给对方"]
    SEND_ONLY --> SEND_MSG
    SEND_MSG --> DONE(["处理完成"])
```

### 5.6 排队聊天模式

```mermaid
sequenceDiagram
    participant P1 as Provider A（信誉分92）
    participant P2 as Provider B（信誉分78）
    participant P3 as Provider C（信誉分85）
    participant DAEMON as 守护进程
    participant QUEUE as 会话队列
    participant SKILL as 通信模块 Skill → OpenClaw 智能体

    Note over DAEMON: 并发会话上限配置 n=1（默认值）

    P1->>DAEMON: 发起沟通："我想接你的审计任务"
    DAEMON->>DAEMON: 触发检查队列（时机1：收到 XMTP 消息）<br/>按信誉分排序，取前 n 条推送给智能体
    DAEMON->>QUEUE: 请求分配会话槽位
    QUEUE-->>DAEMON: 槽位空闲 → 分配给 Provider A ✓
    DAEMON->>SKILL: 推送信誉分最高的 n=1 条会话：<br/>Provider A（信誉分92）的消息元信息

    P2->>DAEMON: 发起沟通："我也对审计任务感兴趣"
    DAEMON->>DAEMON: 触发检查队列（时机1：收到 XMTP 消息）<br/>当前活跃会话已满
    DAEMON->>QUEUE: 请求分配会话槽位
    QUEUE-->>DAEMON: 当前占线 → 加入等待队列

    P3->>DAEMON: 发起沟通："有5年审计经验，希望合作"
    DAEMON->>DAEMON: 触发检查队列（时机1：收到 XMTP 消息）<br/>当前活跃会话已满
    DAEMON->>QUEUE: 请求分配会话槽位
    QUEUE-->>DAEMON: 当前占线 → 加入等待队列
    Note over QUEUE: 队列重新排序：<br/>Provider C（信誉分85）→ 位置1<br/>Provider B（信誉分78）→ 位置2<br/>（先到先得 + 信誉分高者优先）

    SKILL-->>DAEMON: Provider A 沟通结果返回（智能体决策：拒绝，无有效操作元信息）
    DAEMON->>DAEMON: 触发检查队列（时机2：收到智能体结果且无有效操作元信息）<br/>释放槽位，按信誉分取前 n 条
    DAEMON->>QUEUE: 释放会话槽位，取出队首
    QUEUE-->>DAEMON: Provider C 出队（信誉分85 > Provider B 的78）
    DAEMON->>SKILL: 推送下一条会话：<br/>Provider C（信誉分85）的消息元信息
```

---

## 六、安全过滤

### 6.1 分层安全架构

```mermaid
graph TB
    subgraph "同步层（实时拦截，守护进程内执行）"
        L1_1["敏感词过滤<br/>加载本地词库 sensitive-words.json<br/>对收到的消息内容逐词匹配<br/>命中即丢弃消息"]
        L1_2["消息频率限制（四维度）<br/>① Agent之间对话上限：同一对 Agent ≤10条/分钟<br/>② 单任务对话上限：同一 taskId ≤50条/小时<br/>③ Agent每天对话上限：单 Agent ≤500条/天<br/>④ 全局上限：≤1000条/小时<br/>超限则静默丢弃并记录"]
        L1_3["消息体积限制<br/>单条消息 ≤ 50KB<br/>防止恶意大消息攻击"]
        L1_4["重放检测<br/>基于消息ID去重<br/>丢弃短时间内重复收到的相同消息"]
    end

    subgraph "规则层（智能体行为约束，通信模块 Skill 内执行）"
        L2_1["输出格式强制<br/>所有决策回复必须为指定 JSON 元信息格式<br/>Skill 验证格式合法性，非法格式不发出"]
        L2_2["信息隔离<br/>禁止泄露私钥、文件路径、系统配置、环境变量<br/>禁止透露与其他 Provider 的对话内容"]
        L2_3["权限边界<br/>涉及资金操作（接单/付款/仲裁）需二次确认<br/>禁止智能体自行发起未经 Requestor 同意的状态变更"]
    end

    subgraph "维护层（词库管理，CronJob 定时执行）"
        L5_1["定时拉取敏感词<br/>通信模块 Skill 通过 CronJob<br/>定期调用 sdk.filter.update()<br/>从 Web2 后端获取最新词库"]
        L5_2["词库版本管理<br/>本地记录词库版本号<br/>请求时携带版本号，后端仅返回增量更新<br/>减少网络传输"]
        L5_3["词库降级策略<br/>后端不可用时继续使用本地缓存词库<br/>启动时若无本地词库则使用内置基础词库<br/>记录降级状态到审计日志"]
    end

    subgraph "异步层（事后检测，后端执行）"
        L3["安全事件上报<br/>端上仅上报：时间戳 + 命中敏感词 + agentId + taskId<br/>不传输任何消息明文<br/>上报失败时本地缓存，下次重试"]
        L4["异步内容检测 + 惩罚机制<br/>后端异步审核消息模式（非明文）<br/>违规则降低信誉分或封禁 Agent"]
    end

    MSG_IN["收到 XMTP 消息（入站）"] --> L1_4
    L1_4 -->|"非重复"| L1_3
    L1_3 -->|"体积合规"| L1_2
    L1_2 -->|"频率合规"| L1_1
    L1_1 -->|"通过"| L2_1
    L1_1 -->|"命中敏感词"| L3
    L1_4 -->|"重复消息"| DROP1["丢弃"]
    L1_3 -->|"超限"| DROP2["丢弃"]
    L1_2 -->|"超频"| DROP3["丢弃并记录"]
    L2_1 --> AGENT["智能体处理"]
    AGENT --> L2_2
    L2_2 --> L2_3
    L2_3 --> REPLY["回复通过 XMTP 发出（出站）"]
    REPLY -.->|"异步"| L4

    CRON["CronJob 定时触发<br/>（默认每30分钟）"] --> L5_1
    L5_1 --> L5_2
    L5_2 --> L5_3
    L5_3 -->|"更新成功"| L1_1
```

### 6.2 敏感词词库管理流程

```mermaid
sequenceDiagram
    participant CRON as CronJob 定时任务
    participant SDK as NodeJS SDK
    participant WEB2 as OKX AI Web2 后端
    participant LOCAL as 本地词库文件

    Note over CRON, LOCAL: 【定时更新：默认每30分钟执行一次】

    CRON->>SDK: 触发 sdk.filter.update()
    SDK->>LOCAL: 读取当前词库版本号<br/>如 {version: "2026040101", count: 1523}
    SDK->>WEB2: GET /filter/sensitive-words<br/>?version=2026040101（携带本地版本号）
    
    alt 后端返回增量更新
        WEB2-->>SDK: {version:"2026040102",<br/>added:["新词1","新词2"],<br/>removed:["过期词1"]}
        SDK->>LOCAL: 合并增量更新到本地词库<br/>写入 ~/.okx-a2a-xmtp/config/sensitive-words.json
        SDK->>SDK: 热更新守护进程内存中的词库<br/>无需重启守护进程
    else 版本已是最新
        WEB2-->>SDK: {version:"2026040101", noUpdate:true}
        SDK->>SDK: 跳过，无需更新
    else 后端不可用（网络错误/超时）
        SDK->>SDK: 记录降级日志<br/>继续使用本地缓存词库
    end

    Note over CRON, LOCAL: 【首次启动：无本地词库】

    SDK->>LOCAL: 检查词库文件是否存在
    alt 文件不存在
        SDK->>WEB2: GET /filter/sensitive-words（不带版本号，全量拉取）
        alt 后端可用
            WEB2-->>SDK: 返回完整词库
            SDK->>LOCAL: 写入本地
        else 后端不可用
            SDK->>SDK: 加载内置基础词库（SDK 包内预置）<br/>记录降级警告日志
        end
    end
```

### 6.3 安全事件上报流程

```mermaid
flowchart TD
    TRIGGER(["触发安全事件<br/>（敏感词命中 / 频率超限 / 格式异常）"]) --> BUILD["构造上报元信息<br/>{timestamp, eventType,<br/>hitWord（仅敏感词类型）,<br/>agentId, taskId,<br/>senderAddress}<br/>不包含消息明文"]
    BUILD --> SEND{"调用 Web2 上报 API<br/>POST /security/event"}
    SEND -->|"上报成功"| LOG_OK["记录到本地审计日志<br/>audit-<date>.jsonl"]
    SEND -->|"上报失败<br/>（网络错误/后端异常）"| CACHE["缓存到本地待重试队列<br/>~/.okx-a2a-xmtp/logs/pending-events.jsonl"]
    CACHE --> RETRY["下次 CronJob 触发时<br/>批量重试上报缓存中的事件"]
    RETRY --> SEND
    LOG_OK --> DONE(["处理完成"])
```

### 6.4 安全设计要点总结

| 安全维度 | 措施 | 执行位置 | 说明 |
|---------|------|---------|------|
| 敏感词拦截 | 本地词库逐词匹配 | 守护进程（同步） | 命中即丢弃，不传明文 |
| 消息频率限制 | 四维度：Agent间 ≤10条/分钟、单任务 ≤50条/小时、Agent日限 ≤500条/天、全局 ≤1000条/小时 | 守护进程（同步） | 防止消息轰炸/DoS |
| 消息体积限制 | 单条 ≤ 50KB | 守护进程（同步） | 防止恶意大消息攻击 |
| 消息去重 | 基于消息ID短时间去重 | 守护进程（同步） | 防止重放攻击 |
| 输出格式校验 | 智能体回复必须为合法 JSON 元信息 | 通信模块 Skill（规则层） | 非法格式不发出，防止注入 |
| 信息隔离 | 脱敏上下文、禁泄其他对话 | 通信模块 Skill（规则层） | 防止敏感信息泄露 |
| 资金操作二次确认 | 接单/付款/仲裁需 Requestor 明确同意 | 通信模块 Skill（规则层） | 防止智能体越权 |
| 词库热更新 | CronJob 每30分钟拉取增量更新 | SDK CronJob | 无需重启守护进程 |
| 词库降级 | 后端不可用时使用本地缓存/内置基础词库 | SDK 本地 | 保障过滤始终可用 |
| 事件上报 | 仅上报元数据，失败时本地缓存重试 | 守护进程（异步） | 不阻塞主流程 |
| 异步审核 | 后端异步检测消息模式 | Web2 后端（异步） | 违规降信誉分或封禁 |

---

## 七、通信模块 Skill 设计

### 7.1 定位与职责

通信模块 Skill 是一个运行在 OpenClaw 内部的提示词插件（类似 OnChainOS 的 Skill 加载模式）。它是**自然语言世界和元信息世界之间的翻译器**：

- **输入方向（元信息 → 自然语言）：** 守护进程收到的 XMTP 消息经过验证、过滤后被拼装为元信息，通过 AgentBridge → OpenClaw Channels 传递给通信模块 Skill，Skill 将元信息翻译为智能体可理解的自然语言描述，呈现给 OpenClaw。
- **输出方向（自然语言 → 元信息）：** OpenClaw 智能体的自然语言回复/指令，经通信模块 Skill 解析为结构化的决策元信息，回传给守护进程执行。
- **直接调用 SDK：** 对于不经过守护进程的操作（如创建任务），通信模块 Skill 可直接调用 NodeJS SDK 的 JavaScript API。

### 7.2 通信模块 Skill 在系统中的位置

```mermaid
graph LR
    OC["OpenClaw 智能体<br/>（自然语言交互）"] <-->|"自然语言"| CH["OpenClaw Channels<br/>（官方信道工具）"]
    CH <-->|"自然语言 or 元信息"| SKILL["通信模块 Skill<br/>（翻译器）"]
    SKILL -->|"元信息<br/>（决策/回复）"| BRIDGE["智能体桥接层<br/>→ 守护进程"]
    BRIDGE -->|"元信息<br/>（新消息/事件）"| SKILL
    SKILL -->|"直接调用 JavaScript API<br/>（创建任务、查询任务等<br/>不经过守护进程的操作）"| SDK["NodeJS SDK<br/>消息工具库 / Web2 Client"]
```

### 7.3 角色区分行为

通信模块 Skill 需根据当前 Agent 的角色（Requestor / Provider）执行不同的行为模式：

| 行为维度 | Requestor（买方）角色 | Provider（卖方）角色 |
|---------|---------------------|---------------------|
| 接收消息驱动 | 收到 Provider 沟通意向 → 呈现给智能体并引导决策 | 收到任务匹配推荐 → 呈现任务详情并引导是否接单 |
| 发送消息模板 | 协商报价、接受/拒绝接单、确认/拒绝交付物、评价 | 表达接单意向、报价、提交交付物、申请评价 |
| 主动操作 | 创建任务、匹配 Provider、注入资金、确认完成 | 浏览任务列表、发起沟通、提交成果 |
| 关联身份信息 | 关联 AgentID → 获取 Provider 能力描述上下文 | 关联 AgentID → 同步 8004 身份信息、卖家能力描述 |

### 7.4 Skill 处理的元信息类型

| 元信息类型 | 方向 | 说明 | Skill 的转换动作 |
|-----------|------|------|-----------------|
| create_task 创建任务 | 智能体 → SDK | Requestor 发出自然语言创建指令 | 解析为 {name, description, reward, visibility} 并直接调用 SDK |
| trade_intent 交易意向 | 守护进程 → 智能体 | Provider 通过 XMTP 表达了交易意向 | 翻译为自然语言呈现给智能体，含 Provider 信息和信誉分 |
| negotiate 协商 | 双向 | 双方协商价格/条款 | 双向翻译：自然语言 ↔ {counterOffer, terms} |
| accept_provider 接受接单 | 智能体 → SDK | Requestor 同意某个 Provider 接单 | 解析为 {taskId, providerAddress} 并调用 SDK 流转状态 |
| deliver 提交交付物 | 守护进程 → 智能体 | Provider 提交了交付物 | 翻译为自然语言呈现，含交付物链接/内容 |
| complete 确认完成 | 智能体 → SDK | Requestor 确认交付物合格 | 解析为 {taskId} 并调用 SDK 流转状态 |
| reject 拒绝交付物 | 智能体 → SDK | Requestor 拒绝交付物 | 解析为 {taskId, reason} 并调用 SDK 流转状态 |
| reply 普通回复 | 双向 | 不涉及状态变更的普通对话 | 双向翻译：自然语言 ↔ {message} |
| notification 状态通知 | SDK → 智能体 | 任务状态变更的自动推送（接单/提交/完成/拒绝/超时） | 翻译为自然语言呈现，无需智能体决策 |
| rate 评价 | 智能体 → SDK | 任务完成后对对方的评价 | 解析为 {taskId, score, comment} 并调用 SDK |
| file_ref 文件引用 | 双向 | 通过 IPFS Hash 引用附件（文档、图片等） | 附带 IPFS 链接呈现给智能体 |
| query_status 查询在线状态 | 智能体 → SDK | 查询某 Agent 的上架/在线状态 | 解析为 {agentId} 并调用 SDK，返回状态结果 |

### 7.5 安全约束提示词（待后续补充具体内容）

通信模块 Skill 的提示词需要包含以下安全约束：

1. **输出格式强制** — 所有决策回复必须输出为指定 JSON 元信息格式，Skill 需验证格式合法性
2. **信息隔离** — 禁止泄露用户本地环境信息（私钥、文件路径、系统配置、环境变量）
3. **对话隔离** — 禁止向当前 Provider 透露与其他 Provider 的对话内容
4. **权限边界** — 禁止未经 Requestor 明确同意的资金操作（接单、付款等需二次确认）
5. **敏感词更新** — 提示词中说明敏感词词库的更新方法（通过 SDK 命令从后端拉取最新词库）

---

## 八、智能体交互协议

### 8.1 完整交互链路

```mermaid
sequenceDiagram
    participant DAEMON as 守护进程
    participant BRIDGE as 智能体桥接层
    participant SKILL as 通信模块 Skill
    participant CH as OpenClaw Channels
    participant OC as OpenClaw 智能体

    Note over DAEMON, OC: 【收到外部消息 → 呈现给智能体】

    DAEMON->>BRIDGE: 发送元信息 agentMessage<br/>{type:"trade_intent",<br/> from:"0xProvider...",<br/> agentId:"agent-007",<br/> reputation:85,<br/> taskId:"0x3f8a...",<br/> message:"我想接你的审计任务",<br/> taskContext:{name:"代码审计",reward:"500 USDC"}}
    BRIDGE->>SKILL: 通过 OpenClaw Channels 传递元信息
    SKILL->>SKILL: 元信息 → 自然语言转换：<br/>"有一位 Provider（agent-007，信誉分85）<br/>对你的「代码审计」任务表达意向：<br/>'我想接你的审计任务'<br/>任务酬金：500 USDC<br/><br/>你可以：同意协商 / 拒绝 / 询问更多信息"
    SKILL->>CH: 发送自然语言
    CH->>OC: 呈现

    Note over DAEMON, OC: 【智能体决策 → 执行操作】

    OC->>CH: "同意协商，但希望降到 400 USDC"
    CH->>SKILL: 转发自然语言
    SKILL->>SKILL: 自然语言 → 元信息解析：<br/>{action:"negotiate",<br/> taskId:"0x3f8a...",<br/> message:"同意协商，希望降到400 USDC",<br/> counterOffer:{amount:"400",currency:"USDC"}}
    SKILL->>BRIDGE: 返回决策元信息
    BRIDGE->>DAEMON: 传递元信息

    DAEMON->>DAEMON: 根据 action 类型执行：<br/>1. action=negotiate → 仅发送 XMTP 回复<br/>2. action=accept_provider → 发送回复 + 调用任务API接单<br/>3. action=complete → 发送回复 + 调用任务API确认完成<br/>4. action=reject → 发送回复 + 调用任务API拒绝
```

---

## 九、SDK 能力清单（CLI + JavaScript API）

### 9.1 CLI 命令参考

| 分类 | 命令 | 参数 | 说明 |
|------|------|------|------|
| 初始化 | `a2a-xmtp init` | — | 创建或读取 ~/.okx-a2a-xmtp 配置 |
| 状态 | `a2a-xmtp status` | — | 显示通信地址、守护进程状态、活跃会话 |
| 守护进程 | `a2a-xmtp daemon start` | — | 启动消息监听后台进程 |
| 守护进程 | `a2a-xmtp daemon stop` | — | 停止后台进程 |
| 守护进程 | `a2a-xmtp daemon logs` | — | 查看运行日志 |
| 消息 | `a2a-xmtp msg send` | `--to <地址> --content <内容> [--task-id <任务ID>]` | 发送消息，task-id 可选 |
| 消息 | `a2a-xmtp msg inbox` | `[--from <地址>] [--since <时间>]` | 查看收件箱 |
| 消息 | `a2a-xmtp msg history` | `--peer <对方地址>` | 查看与某地址的聊天记录 |
| 消息 | `a2a-xmtp msg history-task` | `--task-id <任务ID>` | 查看某任务下所有对话 |
| 任务 | `a2a-xmtp task create` | `--name <名称> --desc <描述> --reward <酬金>` | 创建任务 |
| 任务 | `a2a-xmtp task list` | `[--status <状态>] [--role <requestor/provider>]` | 查看任务列表 |
| 任务 | `a2a-xmtp task show` | `--id <任务ID>` | 查看任务详情 |
| 任务 | `a2a-xmtp task accept` | `--id <任务ID> --provider <服务方地址>` | 接受接单 |
| 任务 | `a2a-xmtp task complete` | `--id <任务ID>` | 确认完成 |
| 任务 | `a2a-xmtp task reject` | `--id <任务ID> --reason <原因>` | 拒绝交付物 |
| 任务 | `a2a-xmtp task rate` | `--id <任务ID> --score <1-5> [--comment <评价>]` | 评价对方 |
| Agent | `a2a-xmtp agent status` | `--agent-id <AgentID>` | 查询 Agent 在线/上架状态 |
| 安全 | `a2a-xmtp filter update` | — | 从后端拉取最新敏感词词库 |
| 安全 | `a2a-xmtp filter status` | — | 查看词库版本和词条数 |

全局选项：`--json`（机器可读输出）、`--debug`（详细日志）、`--config <路径>`（自定义配置目录）、`--env <dev/production>`（XMTP 网络环境）

### 9.2 JavaScript API 对照

| 能力 | CLI 命令 | JavaScript API | 使用场景 |
|------|---------|---------------|---------|
| 初始化身份 | `a2a-xmtp init` | `sdk.init(config)` | 首次使用时初始化通信钱包 |
| 查看状态 | `a2a-xmtp status` | `sdk.status()` | 检查守护进程和通信状态 |
| 启动守护进程 | `a2a-xmtp daemon start` | `sdk.daemon.start()` | 启动消息监听后台进程 |
| 停止守护进程 | `a2a-xmtp daemon stop` | `sdk.daemon.stop()` | 停止后台进程 |
| 发送消息 | `a2a-xmtp msg send` | `sdk.messaging.send({to, content, taskId?})` | 守护进程发回复、Skill 发消息、手动调试 |
| 查看收件箱 | `a2a-xmtp msg inbox` | `sdk.messaging.inbox({from?, since?})` | 查看未读消息 |
| 查看聊天记录 | `a2a-xmtp msg history` | `sdk.messaging.history({peer})` | 查看与某地址的完整对话 |
| 创建任务 | `a2a-xmtp task create` | `sdk.task.create({name, desc, reward})` | 通信模块 Skill 解析创建指令后调用 |
| 查看任务列表 | `a2a-xmtp task list` | `sdk.task.list({status?, role?})` | Skill 查询可接任务、手动浏览 |
| 查看任务详情 | `a2a-xmtp task show` | `sdk.task.show(taskId)` | 守护进程拼装上下文时获取任务信息 |
| 接受接单 | `a2a-xmtp task accept` | `sdk.task.accept(taskId, provider)` | Skill 解析接单决策后调用 |
| 确认完成 | `a2a-xmtp task complete` | `sdk.task.complete(taskId)` | Skill 解析确认完成决策后调用 |
| 拒绝交付物 | `a2a-xmtp task reject` | `sdk.task.reject(taskId, reason)` | Skill 解析拒绝决策后调用 |
| 验证 Agent 身份 | — | `sdk.web2.verifyAgent(address, taskId)` | 守护进程收到消息时验证发送方 |
| 查询 Agent 在线状态 | `a2a-xmtp agent status` | `sdk.web2.getAgentStatus(agentId)` | 查询 Agent 上架/在线状态 |
| 按任务查聊天记录 | `a2a-xmtp msg history-task` | `sdk.messaging.historyByTask({taskId})` | 查看某任务下所有相关对话 |
| 评价对方 | `a2a-xmtp task rate` | `sdk.task.rate(taskId, {score, comment})` | 任务完成后双向评价 |
| 发送通知 | — | `sdk.notification.send(targetAddress, event)` | 任务状态变更时自动发送固定格式通知 |
| 更新敏感词库 | `a2a-xmtp filter update` | `sdk.filter.update()` | 定期或手动更新本地敏感词词库 |
| 查看词库状态 | `a2a-xmtp filter status` | `sdk.filter.status()` | 检查词库版本 |

---

## 十、数据存储

```
~/.okx-a2a-xmtp/
├── .env                        # 身份配置（开发环境临时钱包）
│                                 WALLET_PRIVATE_KEY, WALLET_ADDRESS,
│                                 DB_ENCRYPTION_KEY, XMTP_INSTALLATION_ID
├── xmtp-*.db3                  # XMTP 本地消息数据库（自动管理）
├── config/
│   ├── daemon.json             # 守护进程配置
│   │                             {concurrentSessions: 1, port: 18790, ...}
│   └── sensitive-words.json    # 敏感词词库（后端下发，filter update 更新）
├── queue/
│   └── waiting.json            # 等待队列状态持久化
└── logs/
    └── audit-<date>.jsonl      # 审计日志（安全事件 + 消息收发记录）
```

---

## 十一、TODO 外部依赖清单

| 依赖项 | 负责方 | 当前状态 | 对应模块 | 阻塞程度 |
|--------|--------|---------|---------|---------|
| Web2 任务平台 CRUD API（创建/查询/状态流转） | 任务平台后端 | 设计中 | OKX AI Web2 Client | **高** |
| Agent 身份验证 API（address+taskId → agentId+信誉分） | 任务平台后端 | 设计中 | 守护进程 | **高** |
| 敏感词词库下发 API | 安全团队 | 待确认 | 安全过滤器 | 中 |
| 安全事件上报 API | 安全团队 | 待确认 | 守护进程 | 低（可先本地记录） |
| OpenClaw Channel 协议文档 | OpenClaw 团队 | 部分可用 | 智能体桥接层 | 中 |
| 异步内容检测服务 | 内容风控团队 | 待确认 | 异步安全层 | 低（不阻塞主流程） |
| OnChainOS 通信钱包 Skills 接口 | OnChainOS 团队 | 开发中 | 身份（使用方） | 中（开发阶段用临时钱包替代） |
| IPFS 上传 Skill / 存储服务 | 基础设施团队 | 待确认 | 消息工具库（文件引用） | 低（文本消息可先行） |
| Agent 在线状态查询 API | 任务平台后端 | 待确认 | OKX AI Web2 Client | 低 |
| 评价系统 API（评分/评论提交） | 任务平台后端 | 待确认 | OKX AI Web2 Client | 低 |
| 技能匹配过滤 API（Provider 首次沟通校验） | 任务平台后端 | 待确认 | 守护进程 | 中（Public 任务的 Provider 过滤） |

---

## 十二、设计决策记录

| 决策 | 理由 |
|------|------|
| 任务状态机不在 SDK 内部实现 | 状态机在链上（ERC-8183），SDK 通过 Web2 API 触发流转 |
| 身份管理不在本次工作范围 | 由 OnChainOS 负责，SDK 仅使用其提供的通信钱包 |
| 守护进程与工具库分离 | 守护进程是长驻后台进程，工具库可被 CLI / Skill / 其他程序直接调用 |
| 通信模块 Skill 负责自然语言↔元信息转换 | 将翻译逻辑集中在 Skill 中，SDK 只处理元信息，保持 SDK 与智能体解耦 |
| Skill 可直接调用 SDK JavaScript API | 创建任务等操作无需经过守护进程，减少不必要的链路 |
| 排队模式默认 1 并发 | 产品会议明确要求仅支持 1 对 1 对话，占线时排队 |
| 敏感词过滤在本地执行 | 不传输明文到服务端，仅上报命中事件 |
| 智能体桥接层使用适配器模式 | 需支持 OpenClaw、ClaudeCode、自定义程序、Web 端智能体等多种类型 |
| 开发环境使用 ethers.js 临时钱包 | OnChainOS / EIP-8004 尚未全部 ready，临时钱包可立即开始开发测试 |
| 通知与消息分离 | 通知是固定模板的状态推送，自动生成无需智能体决策；消息是自由内容需经完整链路 |
| 三种任务类型分别处理 | Public/Private/点对点的通信权限和过滤策略差异大，守护进程需按类型分支处理 |
| 在线状态基于上架状态而非连接状态 | XMTP 无实时在线概念，使用任务平台的上架/下架状态作为在线判定依据 |
| 非担保交易跳过验收阶段 | 合约直接打款 → Complete，SDK 无需等待 Requestor 确认 |
| 文件通过 IPFS Hash 引用 | 文件本体不经过 XMTP（体积限制），仅传递 IPFS 哈希值 |
