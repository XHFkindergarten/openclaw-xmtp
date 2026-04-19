# OKX A2A XMTP SDK — Mermaid 图源码（中英双语版）

> 使用方法：在飞书文档中删除对应位置的 Plaintext 代码块，插入"文本绘图"组件，粘贴下方源码。

---

## 图 1：1.1 战略设计 — 限界上下文划分

```mermaid
graph TB
    subgraph "Identity Context 身份上下文"
        IP["IdentityProvider 身份提供者"]
        DW["DemoWallet 演示钱包"]
        EIP["EIP8004Identity EIP8004身份"]
    end
    subgraph "Messaging Context 消息上下文"
        ME["MessagingEngine 消息引擎"]
        MW["MiddlewarePipeline 中间件管道"]
        CS["ConversationStream 会话消息流"]
    end
    subgraph "Moderation Context 审核上下文"
        CM["ContentModerator 内容审核器"]
        AL["AuditLogger 审计日志器"]
    end
    Identity_Context --> Messaging_Context
    Messaging_Context --> Moderation_Context
```

---

## 图 2：1.2 核心领域实体与值对象

```mermaid
classDiagram
    class AgentIdentity["AgentIdentity 代理身份"] {
        +address 钱包地址: string
        +type 身份类型: IdentityType
        +getPrivateKey() 获取私钥
        +getDbEncryptionKey() 获取数据库加密密钥
    }
    class Job["Job 交易任务"] {
        +id 任务ID: string
        +phase 当前阶段: JobPhase
        +myRole 我方角色: JobRole
        +clientAddress 客户端地址: string
        +providerAddress 服务方地址: string
        +request 需求: JobRequest
        +offer 报价: JobOffer
        +delivery 交付物: JobDelivery
        +evaluation 评估结果: JobEvaluation
        +messageHistory 消息历史: ACPEnvelope[]
        +transition() 状态转换
    }
    class Session["Session 多方会话"] {
        +id 会话ID: string
        +type 类型: SessionType
        +jobIds 关联任务: string[]
        +status 状态: SessionStatus
    }
    class Message["Message 消息"] {
        +id 消息ID: string
        +from 发送方: string
        +to 接收方: string
        +content 内容: string
        +contentType 内容类型: ContentType
        +direction 方向: Direction
        +conversationId 会话ID: string
    }
    class ACPEnvelope["ACPEnvelope 协议信封"] {
        +version 版本: string
        +type 消息类型: ACPMessageType
        +jobId 任务ID: string
        +senderRole 发送方角色: JobRole
        +payload 消息体: ACPPayload
    }
    class JobRequest["JobRequest 任务需求"] {
        +serviceType 服务类型: string
        +description 需求描述: string
        +budget 预算: Money
    }
    class JobOffer["JobOffer 服务报价"] {
        +pricing 定价: Money
        +terms 条款: string
    }
    class Money["Money 金额"] {
        +amount 数量: string
        +currency 币种: string
    }
    Job *-- JobRequest
    Job *-- JobOffer
    Job *-- ACPEnvelope
    Session o-- Job
    JobRequest *-- Money
    JobOffer *-- Money
```

---

## 图 3：1.3 系统分层架构

```mermaid
graph TB
    subgraph "Application Layer 应用层"
        APP["AI Agent 框架 / CLI / 自定义应用"]
    end
    subgraph "Domain Layer 领域层 @okx/a2a-xmtp-sdk"
        CLIENT["A2AXmtpClient 聚合入口"]
        subgraph "Identity 身份子域"
            IDP["IdentityProvider 身份提供者接口"]
            DEMO["DemoWalletProvider 演示钱包提供者"]
            EIP8004["EIP8004Provider EIP8004提供者（TODO）"]
        end
        subgraph "Messaging 消息子域"
            MENG["MessagingEngine 消息引擎"]
            PIPE["MiddlewarePipeline 中间件管道"]
        end
        subgraph "Moderation 审核子域"
            CMOD["ContentModerator 内容审核器（TODO）"]
            AUDIT["AuditLogger 审计日志器"]
        end
    end
    subgraph "Infrastructure Layer 基础设施层"
        XMTP["@xmtp/agent-sdk XMTP消息SDK"]
        FS["FileSystem 文件系统（JSON/SQLite）"]
        ETHERS["ethers.js 以太坊工具库"]
    end
    APP --> CLIENT
    CLIENT --> IDP
    CLIENT --> MENG
    MENG --> PIPE
    PIPE --> CMOD
    PIPE --> AUDIT
    IDP --> DEMO
    IDP --> EIP8004
    DEMO --> ETHERS
    DEMO --> FS
```

---

## 图 4：2.1 身份提供者类图

```mermaid
classDiagram
    class IdentityProvider["IdentityProvider 身份提供者接口"] {
        <<interface>>
        +type 身份类型: IdentityType
        +getPrivateKey() 获取私钥
        +getAddress() 获取地址
        +getDbEncryptionKey() 获取数据库加密密钥
    }
    class DemoWalletProvider["DemoWalletProvider 演示钱包提供者"] {
        -configDir 配置目录: string
        -privateKey 私钥: string
        -address 地址: string
        +initialize() 初始化
        +getPrivateKey() 获取私钥
        +getAddress() 获取地址
        +getInstallationId() 获取安装ID
        +type = demo
    }
    class EIP8004Provider["EIP8004Provider EIP8004身份提供者"] {
        <<TODO 待实现>>
        -serviceEndpoint 服务端点: string
        -did 去中心化身份: string
        +type = eip8004
    }
    class CustomProvider["CustomProvider 自定义提供者"] {
        <<扩展点>>
        +type = custom
    }
    IdentityProvider <|.. DemoWalletProvider
    IdentityProvider <|.. EIP8004Provider
    IdentityProvider <|.. CustomProvider
```

---

## 图 5：2.2 Demo 身份初始化流程

```mermaid
flowchart TD
    START(["initialize() 开始初始化"]) --> CHECK{"~/.okx-a2a-xmtp/.env\n配置文件存在?"}
    CHECK -->|"是"| READ["读取 .env 文件\n解析私钥、地址、加密密钥、安装ID"]
    CHECK -->|"否"| GEN["createRandom()\n随机生成新钱包"]
    GEN --> WRITE["写入 .env 文件\n保存私钥、地址、加密密钥"]
    WRITE --> READ
    READ --> INST{"XMTP_INSTALLATION_ID\n安装ID存在且有效?"}
    INST -->|"是"| REUSE["复用已有安装"]
    INST -->|"否"| NEW_INST["创建新的XMTP安装"]
    NEW_INST --> CHECK_LIMIT{"安装数量 < 10?\n（XMTP上限）"}
    CHECK_LIMIT -->|"是"| SAVE_INST["保存安装ID到 .env"]
    CHECK_LIMIT -->|"否"| ERROR["抛出错误:\n安装数量已达上限"]
    SAVE_INST --> DONE(["初始化完成 ✓"])
    REUSE --> DONE
```

---

## 图 6：3.1 消息流转时序图

```mermaid
sequenceDiagram
    participant App as 上层应用
    participant ME as MessagingEngine 消息引擎
    participant MW as MiddlewarePipeline 中间件管道
    participant CM as ContentModerator 内容审核器
    participant PP as ProtocolParser 协议解析器
    participant AL as AuditLogger 审计日志器
    participant XMTP as XMTP Network XMTP网络

    Note over App, XMTP: 【发送消息 Outbound】

    App->>ME: send() 发送消息
    ME->>MW: executeOutbound() 执行发送管道
    MW->>CM: [1] sensitiveFilter() 敏感信息过滤
    CM->>CM: [2] moderate() 内容审核（TODO 默认通过）
    CM->>PP: [3] parseOutbound() 封装ACP协议信封
    PP->>AL: [4] log() 记录审计日志
    AL->>MW: [5] rateLimit() 频率限制
    MW->>ME: 管道通过 ✓
    ME->>XMTP: sendText() 发送到XMTP网络
    XMTP-->>App: 返回 Message 消息对象

    Note over App, XMTP: 【接收消息 Inbound】

    XMTP->>ME: MessageStream 新消息事件
    ME->>MW: executeInbound() 执行接收管道
    MW->>PP: [1] parseInbound() 解析ACP协议信封并路由到任务管理器
    PP->>AL: [2] log() 记录审计日志
    AL->>MW: 管道通过 ✓
    MW->>ME: 分发事件
    ME->>App: on("message") / on("acp") 触发回调
```

---

## 图 7：3.2 中间件管道架构

```mermaid
graph LR
    subgraph "Outbound Pipeline 发送管道"
        O1["SensitiveFilter\n敏感信息过滤"] --> O2["ContentModerator\n内容审核（TODO）"]
        O2 --> O3["ProtocolParser\n协议解析器"]
        O3 --> O4["AuditLogger\n审计日志"]
        O4 --> O5["RateLimiter\n频率限制"]
        O5 --> SEND["XMTP Send\n发送到网络"]
    end
    subgraph "Inbound Pipeline 接收管道"
        RECV["XMTP Receive\n收到消息"] --> I1["ProtocolParser\n协议解析器"]
        I1 --> I2["AuditLogger\n审计日志"]
        I2 --> DISPATCH["Event Dispatch\n事件分发"]
    end
```

---

## 图 8：4.3 ACP 消息 Scheme（协议消息结构）

```mermaid
classDiagram
    class ACPEnvelope["ACPEnvelope 协议消息信封"] {
        +version 版本: 0.1.0
        +type 消息类型: ACPMessageType
        +jobId 任务ID: string
        +from 发送方inboxId: string
        +to 接收方inboxId: string
        +timestamp 时间戳: number
        +payload 消息体: ACPPayload
    }
    class JobRequestPayload["JobRequestPayload 任务请求体"] {
        +serviceType 服务类型: string
        +description 需求描述: string
        +budget 预算: Money
        +deadline 截止时间: number
        +requirements 自定义需求: Record
        +evaluatorAddress 评估者地址: string
    }
    class JobOfferPayload["JobOfferPayload 报价响应体"] {
        +pricing 定价: Money
        +terms 服务条款: string
        +estimatedDelivery 预计交付时间: number
        +capabilities 服务能力声明: string[]
    }
    class JobDeliverPayload["JobDeliverPayload 交付物提交体"] {
        +deliverableType 交付物类型: string
        +content 交付内容: string
        +data 附加数据: Record
        +onChainProof 链上交付证明（TODO）: string
    }
    class JobEvaluatePayload["JobEvaluatePayload 评估结果体"] {
        +result 评估结果: approved通过/rejected拒绝/partial部分通过
        +score 评分: number
        +comment 评估备注: string
        +settlementTxHash 结算交易哈希（TODO）: string
    }
    ACPEnvelope --> JobRequestPayload : job_request 发起任务请求
    ACPEnvelope --> JobOfferPayload : job_offer 回复报价
    ACPEnvelope --> JobDeliverPayload : job_deliver 提交交付物
    ACPEnvelope --> JobEvaluatePayload : job_evaluate 评估交付物
```

---

## 图 10：5.1 一对多广播交易流程

```mermaid
sequenceDiagram
    participant Client as Client Agent 客户端代理
    participant SM as SessionManager 会话管理器
    participant P1 as Provider A 服务方A
    participant P2 as Provider B 服务方B
    participant P3 as Provider C 服务方C

    Client->>SM: createBroadcastSession() 创建广播会话
    SM->>SM: 创建1个Session + 3个独立Job任务

    par 并行发送请求
        SM->>P1: job_request 发送任务请求（Job1）
        SM->>P2: job_request 发送任务请求（Job2）
        SM->>P3: job_request 发送任务请求（Job3）
    end

    P1-->>SM: job_offer 报价$100（Job1）
    P3-->>SM: job_offer 报价$80（Job3）

    Note over SM: maxOffers=2 已收到足够报价，自动取消剩余

    SM->>P2: job_cancel 取消任务（Job2）
    Client->>SM: acceptJob() 接受最优报价（Job3）
```

---

## 图 11：5.2 多对一多客户端场景

```mermaid
sequenceDiagram
    participant C1 as Client A 客户端A
    participant C2 as Client B 客户端B
    participant C3 as Client C 客户端C
    participant Prov as Provider Agent 服务方代理
    participant JM as JobManager 任务管理器

    par 各客户端独立发送请求
        C1->>Prov: job_request 任务请求（Job1）
        C2->>Prov: job_request 任务请求（Job2）
        C3->>Prov: job_request 任务请求（Job3）
    end

    Note over Prov, JM: 多对一场景不需要显式Session，每个Job独立处理

    Prov->>JM: getActiveInboundJobs() 查询所有收到的任务
    JM-->>Prov: 返回 [Job1, Job2, Job3]
    Prov->>JM: offerJob() 回复报价（Job1）
    Prov->>JM: offerJob() 回复报价（Job2）
    Prov->>JM: rejectJob() 拒绝，产能已满（Job3）
```

---

## 图 12：六、ACP 完整交易时序图

```mermaid
sequenceDiagram
    participant C as Client Agent 客户端代理
    participant SDK_C as Client SDK 客户端SDK
    participant XMTP as XMTP Network XMTP网络
    participant SDK_P as Provider SDK 服务方SDK
    participant P as Provider Agent 服务方代理

    Note over C, P: 【阶段1 发起请求】
    C->>SDK_C: createJob() 创建交易任务
    SDK_C->>SDK_C: 创建Job，阶段=Open（已发起）
    SDK_C->>SDK_C: 经过中间件管道（审核、日志等）
    SDK_C->>XMTP: 发送 ACPEnvelope（job_request 任务请求）
    XMTP->>SDK_P: 消息流推送
    SDK_P->>P: 触发 job:request 新任务请求事件

    Note over C, P: 【阶段2 协商报价】
    P->>SDK_P: offerJob() 回复报价
    SDK_P->>SDK_P: 阶段 Open→Negotiation（协商中）
    SDK_P->>XMTP: 发送 ACPEnvelope（job_offer 报价）
    XMTP->>SDK_C: 消息流推送
    SDK_C->>C: 触发 job:offer 收到报价事件

    C->>SDK_C: acceptJob() 接受条款
    SDK_C->>XMTP: 发送 ACPEnvelope（job_accept 接受）
    XMTP->>SDK_P: 消息流推送
    SDK_P->>P: 触发 job:phase_change 阶段变更→执行中

    Note over C, P: 【阶段3 执行交付】
    P->>SDK_P: deliverJob() 提交交付物
    SDK_P->>XMTP: 发送 ACPEnvelope（job_deliver 交付）
    XMTP->>SDK_C: 消息流推送
    SDK_C->>C: 触发 job:delivery 收到交付物事件

    Note over C, P: 【阶段4 评估结算】
    C->>SDK_C: evaluateJob(approved) 评估通过
    SDK_C->>XMTP: 发送 ACPEnvelope（job_evaluate 评估结果）
    XMTP->>SDK_P: 消息流推送
    SDK_P->>P: 触发 job:evaluation 收到评估结果事件

    Note over C, P: 【TODO】触发链上结算
```

---

## 图 13：7.2 启动恢复流程

```mermaid
flowchart TD
    START(["client.start() 启动客户端"]) --> LOAD["1. 加载本地Job状态\n读取 jobs/*.json 中未完结的任务"]
    LOAD --> PULL["2. 拉取离线消息\n从XMTP获取离线期间的新消息"]
    PULL --> REPLAY["3. 按时间序重放\n将离线消息逐条送入状态机处理"]
    REPLAY --> PERSIST["4. 持久化状态\n使用 write-rename 原子写入保存"]
    PERSIST --> CONFLICT{"5. 冲突检测\n本地状态 vs 重放后状态是否一致?"}
    CONFLICT -->|"一致"| STREAM["启动实时消息监听"]
    CONFLICT -->|"不一致"| OVERRIDE["以重放后状态为准\n覆盖本地存储"]
    OVERRIDE --> STREAM
    STREAM --> DONE(["恢复完成，开始服务 ✓"])
```

---

## 图 14：8.1 CLI 命令树

```mermaid
graph TD
    CLI["a2a-xmtp 命令行工具"]
    CLI --> INIT["init 初始化身份"]
    CLI --> STATUS["status 查看运行状态"]
    CLI --> MSG["消息操作"]
    MSG --> SEND["send 发送消息\n--to 目标地址 --msg 消息内容"]
    MSG --> REPLY["reply 回复消息\n--conv 会话ID --msg 消息内容"]
    MSG --> INBOX["inbox 查看收件箱\n--from 发送方 --since 起始时间"]
    MSG --> HISTORY["history 查看聊天记录\n--peer 对方地址"]
    CLI --> JOB["交易操作"]
    JOB --> JC["job create 创建交易任务\n--to --service --desc"]
    JOB --> JL["job list 列出任务\n--phase --role"]
    JOB --> JS["job show 查看任务详情"]
    JOB --> JO["job offer 回复报价\n--price --terms"]
    JOB --> JA["job accept 接受条款"]
    JOB --> JR["job reject 拒绝\n--reason"]
    JOB --> JD["job deliver 提交交付物\n--type --content"]
    JOB --> JE["job evaluate 评估交付物\n--result"]
    CLI --> SESSION["会话操作"]
    SESSION --> SB["session broadcast 广播询价\n--to --service"]
    SESSION --> SL["session list 列出会话"]
    SESSION --> SC["session cancel 取消会话"]
```

---

## 图 15：9.1 聚合入口结构

```mermaid
classDiagram
    class A2AXmtpClient["A2AXmtpClient 客户端聚合入口"] {
        +messaging 消息引擎: MessagingEngine
        +jobs 任务管理器: JobManager
        +sessions 会话管理器: SessionManager
        +identity 身份提供者: IdentityProvider
        +address 钱包地址: string
        +create() 创建实例（静态方法）
        +start() 启动监听
        +stop() 停止并清理
        +status() 获取运行状态
    }
    class A2AXmtpConfig["A2AXmtpConfig 客户端配置"] {
        +identity 身份提供者: IdentityProvider
        +xmtpEnv XMTP网络环境: string
        +middleware 中间件列表: MiddlewareFn[]
        +dataDir 数据存储目录: string
        +logLevel 日志级别: string
        +moderation 审核配置: ModerationConfig
    }
    A2AXmtpClient --> IdentityProvider : 依赖身份提供者
    A2AXmtpClient --> MessagingEngine : 持有消息引擎
    A2AXmtpClient --> JobManager : 持有任务管理器
    A2AXmtpClient --> SessionManager : 持有会话管理器
    A2AXmtpClient ..> A2AXmtpConfig : 通过配置创建
```
