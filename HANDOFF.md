# XMTP Expert Network — 交接文档

> 这份文档是写给接手这个项目的 ClaudeCode / OpenClaw 会话的。请完整阅读后再开始工作。
> 本文件保留了开发期本机路径、日志和调试背景，不作为发布后的安装说明。发布与初始化请以 `OPENCLAW_INIT.md`、`SKILL.md`、`README.md` 为准。

## 项目概述

这是一个 **XMTP Agent-to-Agent 专家知识交换 Demo**。核心想法：每个人的 AI 助手（OpenClaw，用户称之为"龙虾"）通过 XMTP 去中心化消息网络互相通信。每个龙虾对外暴露一个受 `knowledge.md` 限制的专家人格，当别人的龙虾来问问题时，只能回答知识范围内的内容。

## 用户背景

- 用户将 AI 编程助手称为"龙虾"，实际指的是 **OpenClaw**（不是 Claude Code）
- OpenClaw 是一个开源 AI 助手平台，支持多消息通道（Telegram、WhatsApp 等），有 WebSocket Gateway（`ws://127.0.0.1:18789`）
- 用户希望把 XMTP 作为 OpenClaw 的一个新通信通道

## 核心架构

```
用户 → OpenClaw（大脑，读 knowledge.md，决定回复）
          │
          ├── CLI 命令（xmtp-agent send/inbox/status）
          │         ↕ HTTP
          └── XMTP Agent Process（纯消息管道，不调用任何 AI model）
                    ↕ XMTP Network
              其他人的 XMTP Agent + OpenClaw
```

**关键原则**：XMTP agent 进程是**纯消息管道**，不调用任何 AI Model Provider。所有智能决策（读 knowledge.md、生成回复、判断对话是否结束）都由 OpenClaw 完成。

## 当前文件结构

```
xmtp-demo1/
├── SKILL.md              # OpenClaw skill 定义（告诉 OpenClaw 如何使用这个工具）
├── HANDOFF.md             # 本文档
├── package.json
├── tsconfig.json
├── .env                   # XMTP 钱包密钥（自动生成，每个实例独立）
├── knowledge.md           # 尚未创建（init 命令会生成模板）
├── src/
│   ├── agent.ts           # XMTP agent + HTTP server + WebSocket push（核心）
│   ├── cli.ts             # CLI 命令入口（init/start/stop/send/inbox/status）
│   ├── logger.ts          # 分级日志（INFO/DEBUG/ERROR）
│   └── index.ts           # 旧文件，已被 agent.ts 替代，可删除
├── scripts/
│   ├── gen-keys.ts        # 旧的密钥生成脚本（已被 cli.ts init 替代）
│   ├── test-local.ts      # 双 agent 集成测试（9/9 通过）
│   └── test-single.ts     # 单 agent 测试（配合 XMTP 网页端手动发消息）
└── data/                  # 运行时数据（XMTP SQLite DB、PID 文件、审计日志）
```

## 关键环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `XMTP_WALLET_KEY` | XMTP 钱包私钥（自动生成） | 无，必须配置 |
| `XMTP_DB_ENCRYPTION_KEY` | 数据库加密密钥（自动生成） | 无，必须配置 |
| `XMTP_ENV` | XMTP 网络环境 | `dev` |
| `XMTP_HTTP_PORT` | HTTP server 端口 | `18790` |
| `XMTP_BASE_DIR` | 基础目录（.env、data/、knowledge.md 的位置） | `process.cwd()` |
| `XMTP_NO_WS` | 设为 `1` 禁用 WebSocket 连接 | `0` |
| `OPENCLAW_WS` | OpenClaw Gateway WebSocket 地址 | `ws://127.0.0.1:18789` |

## HTTP API

agent 进程启动后监听 `http://127.0.0.1:{port}`：

| 方法 | 路径 | 说明 | 请求体/参数 |
|------|------|------|------------|
| POST | /send | 发送 XMTP 消息 | `{ to: "0x...", msg: "..." }` |
| GET | /inbox | 查询收到的消息 | `?since=<timestamp>&from=<address>` |
| GET | /status | 查询 agent 状态 | 无 |
| POST | /stop | 停止 agent | 无 |

`/send` 返回：`{ ok: true, conversationId: "...", timestamp: 123 }`
`/inbox` 返回：`[{ from, content, conversationId, timestamp, knowledgeEmpty }]`
`/status` 返回：`{ running, address, env, uptime, knowledgeEmpty, webSocketConnected, chatUrl }`

## 已通过的测试

`npm test` 运行 `scripts/test-local.ts`，启动两个独立的 XMTP agent 互相聊天：

1. ✅ Agent A 启动成功
2. ✅ Agent B 启动成功
3. ✅ A→B 发送消息成功
4. ✅ B 的 inbox 收到 A 的消息
5. ✅ B→A 回复成功
6. ✅ A 的 inbox 收到 B 的回复
7. ✅ 发送含敏感数据的消息被阻止（输出过滤）
8. ✅ Agent A 正确报告 knowledgeEmpty=true（无 knowledge.md）
9. ✅ Agent B 正确报告 knowledgeEmpty=false（有 knowledge.md）

## 你现在需要做的事

### 第一步：单 agent 测试（验证基础流程）

1. `git clone` 拉下来，`npm install`
2. 运行 `npx tsx src/cli.ts init` 初始化（生成 .env 和 knowledge.md 模板）
3. 编辑 `knowledge.md`，写入一些测试知识（比如你了解的某个技术领域）
4. 运行 `npm run test:single`
5. 脚本会打印一个 **Chat URL**（格式如 `http://xmtp.chat/dev/dm/0x...`）
6. 在浏览器中打开这个 URL，手动发送消息
7. 观察脚本输出是否打印了收到的消息
8. 按 Ctrl+C 停止

**这一步验证的是**：XMTP agent 能正确接收来自网页端的消息，并通过 HTTP API 暴露出来。

### 第二步：OpenClaw Skill 集成测试

这是核心验证——OpenClaw 能否正确使用这个 Skill。

1. 将项目注册为 OpenClaw skill。参考 Virtuals ACP 插件的方式，在 `~/.openclaw/openclaw.json` 中加入：
   ```json
   {
     "skills": {
       "load": {
         "extraDirs": ["/path/to/xmtp-demo1"]
       }
     }
   }
   ```
   （具体配置方式可能需要查阅 OpenClaw 文档，上述路径格式来自 [Virtuals ACP 插件](https://github.com/Virtual-Protocol/openclaw-acp)）

2. 启动 OpenClaw，确认它能识别 SKILL.md 中定义的命令

3. 先手动启动 agent：`npx tsx src/cli.ts start`

4. 让 OpenClaw 执行以下测试：
   - 运行 `xmtp-agent status --json` 查看 agent 状态
   - 在浏览器的 XMTP 网页端发送一条消息给 agent
   - 让 OpenClaw 运行 `xmtp-agent inbox --json` 查看是否收到消息
   - 让 OpenClaw 读取 `knowledge.md`，基于知识范围决定回复内容
   - 让 OpenClaw 运行 `xmtp-agent send --to <发送者地址> --msg "回复内容" --json`
   - 在网页端验证是否收到回复

5. **被动回复的关键验证**：当网页端发消息给 agent 时，OpenClaw 能否自动（或被提示后）执行 inbox → 读 knowledge.md → send 的流程

### 第三步：解决 XMTP 入站消息如何交给本地 OpenClaw

> 2026-03-26 结论：**不要继续把重点放在裸 WebSocket 推送上。**

当前 `src/agent.ts` 的实现是在收到 XMTP 消息后，直接往 `ws://127.0.0.1:18789` 发一段自定义 JSON：

```ts
pushToOpenClaw({
  type: "new_message",
  from: senderInboxId,
  content,
  conversationId,
  timestamp: Date.now(),
  knowledgeEmpty: isKnowledgeEmpty(),
});
```

这条路目前有两个问题：

1. **协议层不对**：参考 `~/.openclaw/extensions/openclaw-weixin`，微信扩展不是靠“发一个 WS 事件”通知 OpenClaw；它是在 OpenClaw 插件进程内，直接调用 `channelRuntime.routing/session/reply` 这套运行时接口，把入站消息喂进 OpenClaw 的原生会话与回复管线。
2. **Gateway 还有鉴权**：本机 `~/.openclaw/logs/gateway.err.log` 已出现多次 `unauthorized: device token mismatch` / `gateway token missing`。即使连上 WebSocket，也仍然没有证据表明发送自定义 JSON 能触发 OpenClaw 的回复流程。

**正确参考对象**：`openclaw-weixin` 的实际链路是：

```text
收到平台消息
  -> normalize 成 MsgContext
  -> resolveAgentRoute(...)
  -> recordInboundSession(...)
  -> dispatchReplyFromConfig(...)
  -> deliver() 调平台 send API
```

对应关键代码位置：

- `~/.openclaw/extensions/openclaw-weixin/index.ts`
- `~/.openclaw/extensions/openclaw-weixin/src/monitor/monitor.ts`
- `~/.openclaw/extensions/openclaw-weixin/src/messaging/process-message.ts`

#### 建议的实现方向：做一个 `openclaw-xmtp` Channel Bridge

不要让外部 `xmtp-agent` 直接“通知 Gateway”，而是让 **OpenClaw 插件主动消费 XMTP agent 的本地 HTTP API**。

推荐架构：

```text
XMTP Network
  -> xmtp-agent (现有进程，继续负责 XMTP SDK / SQLite / /send / /inbox)
  -> openclaw-xmtp 插件 monitor loop
  -> channelRuntime.recordInboundSession + dispatchReplyFromConfig
  -> 插件通过本地 /send 把 OpenClaw 回复发回 xmtp-agent
  -> xmtp-agent 再发到 XMTP
```

这样有几个好处：

- **复用已完成成果**：现在的 `src/agent.ts`、`/send`、`/inbox`、SQLite 持久化、测试脚本都保留
- **符合 OpenClaw 现有模型**：像微信通道一样进入官方 channel pipeline
- **不依赖猜测 Gateway WS 私有协议**

#### 最小落地计划

1. 新建 `openclaw-xmtp` 扩展（结构参考 `openclaw-weixin`）
2. 在插件 `register()` 时拿到 `api.runtime`
3. 做一个 monitor loop，轮询本地 `http://127.0.0.1:${XMTP_HTTP_PORT}/inbox?since=...`
4. 把每条 XMTP 文本转成 OpenClaw 的 direct message context
   - `Body = content`
   - `From/To = senderInboxId`
   - `OriginatingChannel = "openclaw-xmtp"`
   - `OriginatingTo = senderInboxId`
   - `Provider = "openclaw-xmtp"`
   - `ChatType = "direct"`
   - `SessionKey = route.sessionKey`
5. 调用与微信扩展同类的 runtime 流程：
   - `resolveAgentRoute(...)`
   - `finalizeInboundContext(...)`
   - `recordInboundSession(...)`
   - `dispatchReplyFromConfig(...)`
6. 在 `deliver(payload)` 里调用现有本地 `POST /send`
   - `to = senderInboxId`
   - `msg = payload.text`
7. 先只支持文本，媒体/typing/group 一律后置

#### 这一步暂时不建议做的事

- 不要再假设 `ws://127.0.0.1:18789` 接收任意 JSON 就会触发 OpenClaw 回复
- 不要先做 XMTP 原生 Channel Adapter 的“全量重写”
- 不要把 AI 逻辑重新塞回 `xmtp-agent` 进程

#### 现有 WebSocket 代码如何处理

短期可以保留 `src/agent.ts` 中的 WebSocket 连接逻辑，仅作为 debug/未来探索用途；但应明确把它视为 **非主路径、非可靠集成方式**。真正的本地集成主路径应切换为 `openclaw-xmtp` 插件桥接。

### 第四步（可选）：Channel Adapter 升级

如果 Skill + CLI 模式验证通过，可以探索将 XMTP 做成 OpenClaw 的原生 Channel Adapter（像 Telegram/WhatsApp 一样）。这需要了解 OpenClaw 的 Channel Adapter 接口。参考文档：
- https://docs.openclaw.ai/concepts/multi-agent
- https://github.com/openclaw/openclaw

## 已知问题和注意事项

1. **旧文件可删除**：`src/index.ts` 和 `scripts/gen-keys.ts` 是旧代码，已被 `agent.ts` 和 `cli.ts init` 替代
2. **XMTP 网络**：所有人必须在同一个 XMTP 网络（dev 或 production）上才能通信。当前配置是 `dev`
3. **installation 限制**：每个钱包地址最多 10 次 XMTP installation。如果反复删除重建数据库会消耗配额
4. **被动回复的局限**：在 CLI poll 模式下，OpenClaw 不在线时，收到的消息会被 XMTP SDK 存储在 SQLite 中，但不会被自动回复。OpenClaw 下次上线时通过 `inbox` 命令可以看到
5. **输出过滤**：agent 会阻止发送包含系统路径（`/Users/xxx`）、私钥格式（`0x` + 64 hex）、API 密钥格式（`sk-xxx`）的消息
6. **WebSocket 是 graceful 的**：如果 OpenClaw Gateway 不在线，WebSocket 连接会静默失败并每 10 秒重试，不影响 HTTP API 正常工作

## 设计决策的完整记录

详细的设计文档（包含所有 office-hours 讨论和工程审查决策）位于：
`~/.gstack/projects/garrytan-gstack/oker-unknown-design-20260326-183000.md`

如果这个文件在另一台电脑上不存在，以下是关键决策摘要：

- **为什么是 CLI + HTTP 而不是直接 Channel Adapter**：用户环境暂无 OpenClaw，CLI 模式可以先本地验证，推到 GitHub 后再升级
- **为什么 agent 不调用 AI model**：XMTP agent 是纯消息管道，所有智能决策由 OpenClaw 完成。OpenClaw 内部用什么 model 不在本设计范围
- **为什么用 XMTP SDK 的 SQLite 而不是内存存储**：SDK 已经持久化了所有消息，重复存储会引入同步问题
- **为什么 WebSocket 是可选的**：`XMTP_NO_WS=1` 可以禁用，方便在没有 OpenClaw 的环境中测试
- **为什么简化为 3 个文件**：这是 demo，不需要过度模块化。agent.ts（核心）、cli.ts（命令）、logger.ts（日志）足够

## 快速命令参考

```bash
# 初始化（生成钱包密钥 + knowledge.md 模板）
npx tsx src/cli.ts init

# 启动 agent
npx tsx src/cli.ts start
npx tsx src/cli.ts start --debug    # 带详细日志

# 查看状态
npx tsx src/cli.ts status --json

# 发送消息
npx tsx src/cli.ts send --to 0xABC... --msg "你好" --json

# 查看收件箱
npx tsx src/cli.ts inbox --json
npx tsx src/cli.ts inbox --since 1711234567890 --json

# 停止 agent
npx tsx src/cli.ts stop

# 运行双 agent 集成测试（不需要 OpenClaw）
npm test

# 运行单 agent 测试（配合网页端手动发消息）
npm run test:single
```
