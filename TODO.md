# TODO

## 一、已知 Bug / 逻辑风险

### [BUG] RecoveryManager: lastMessageId 超出回溯窗口时离线消息被静默跳过

**位置**: `src/recovery.ts` `recoverOfflineMessages()`

**问题**: 若 daemon 上次关闭时间距本次启动超过 48 小时（`LOOKBACK_MS`），该 group 保存的 `lastMessageId` 不会出现在本次拉取的消息列表中（因为受 `sentAfterNs` 限制）。`past` 标志永远不会被置为 `true`，导致所有在回溯窗口内新到的消息被**全部跳过**，造成数据丢失。

**影响**: 离线超过 48 小时的 group 在重启后不会恢复任何离线消息。

**修复方向**: 若遍历完整个消息列表后 `past` 仍为 `false`（即 `lastMessageId` 未找到），应将 `past` 置为 `true` 并重新遍历，或者将该 group 视为「首次启动」状态（`lastId = null`）。需要配套考虑消息幂等性：handler 可能对边界消息重复处理。

---

### [BUG] MessagingToolkit.getOrOpenGroup: 并发调用存在重复建群竞态

**位置**: `src/messaging.ts` `getOrOpenGroup()`

**问题**: 若同一 `(taskId, peerAddress)` 的 `getOrOpenGroup` 被并发调用（如 daemon 启动时同时触发多条出站消息），两个调用都可能 cache miss → sync → 找不到 → `createGroupWithAddresses` → 建出两个名字相同的 Group。XMTP 协议层不保证 groupName 唯一性。

**影响**: 同一 task 下出现两个 group，消息路由不确定。

**修复方向**: 将 cache 从 `Map<string, Group>` 改为 `Map<string, Promise<Group>>`，并发请求共享同一个 Promise，消除竞态。

---

### [BEHAVIOR] ContentFilter 使用子串匹配，无词边界

**位置**: `src/filter.ts` `check()`

**问题**: blocklist 词 `"bad"` 会命中 `"badminton"`、`"abadon"` 等包含该子串的无关词，误报率高。

**现状**: 已在 `test/filter.edge.test.ts` 中记录此行为作为文档测试。

**修复方向**: 如需词边界匹配，将 `includes()` 改为正则 `\b<word>\b`（仅对 ASCII 有效）；中文无词边界，需要分词库支持。待产品明确需求后处理。

---

### [RISK] MessageDaemon.start() 重复调用未防护

**位置**: `src/daemon.ts` `start()`

**问题**: `start()` 被调用两次会：(1) 注册两次 `agent.on("message"` 监听器，导致消息被处理两次；(2) 注册两次 `process.on("SIGINT"/"SIGTERM")`，导致 `stop()` 被调用两次；(3) 启动两个 stream。

**修复方向**: 在 `start()` 入口加幂等守卫：若 `this.startedAt !== null` 则直接 return 或抛错。

---

### [RISK] daemon 收到自身发出的消息未过滤

**位置**: `src/daemon.ts` `agent.on("message")`

**问题**: 当前代码对 `agent.on("message")` 触发的所有消息都计数并进队，未检查 `ctx.message.senderInboxId === agent.client.inboxId`（自身消息）。`RecoveryManager.recoverOfflineMessages()` 已过滤自身消息，但实时流没有。

**影响**: daemon 调用 `sendMessage()` 后，自己发出的消息也会触发 `onMessage` 回调，可能引起循环调用。

**待确认**: XMTP `agent-sdk` 的 `agent.on("message")` 是否已在底层排除自身消息？如果是，此条可关闭。

---

## 二、外部依赖缺口（需其他团队实现）

### [EXTERNAL] OpenClaw Extension 适配层

**依赖方**: OpenClaw extension 负责人

**描述**: 本 SDK 是一个纯库，需要被包装成 OpenClaw `ChannelPlugin` 才能被 OpenClaw gateway 加载。适配层需要实现以下映射：

```
ChannelPlugin.gateway.startAccount(ctx)
  → 创建 Agent + MessageDaemon
  → daemon.start()
  → onMessage: (msg: SandboxedMessage) =>
      ctx.runtime.channel.dispatchInbound(toMsgContext(msg))

ChannelPlugin.outbound.sendText(ctx)
  → daemon.sendMessage(ctx.to /* taskId */, encodeText(ctx.text), peerAddress)
```

还需要定义 `SandboxedMessage → OpenClaw MsgContext` 的字段映射（`Body`, `From`, `To`, `AccountId`, `MessageSid`, `ChatType`, `OriginatingChannel` 等）。

**未实现文件**: `src/adapter.ts`（OpenClaw MsgContext 转换）、`index.ts`（ChannelPlugin 注册入口）

---

### [EXTERNAL] ContentFilter blocklist 数据源

**依赖方**: 内容安全团队 / 配置平台

**描述**: `ContentFilter.setBlocklist()` 接口已就位，支持运行时动态更新。但词库的实际来源（远端接口、配置平台、本地文件）未定义。`DaemonConfig.filter.blocklist` 目前只能在代码里静态传入。

**待接入**: 定时从配置平台拉取词库，调用 `filter.setBlocklist(words)` 刷新。刷新间隔参考 `PluginConfig.sensitiveWordRefreshInterval`。

---

### [EXTERNAL] E2E 集成测试（需要真实 XMTP 网络）

**描述**: `scripts/test-daemon.ts` 是现有的最接近 E2E 的测试，但需要手动执行且依赖真实钱包和 XMTP dev 网络。正式的 E2E 测试套件应覆盖：

1. 完整 alice → daemon → bob 消息流（含 recovery）
2. 并发多 task 下的队列隔离
3. filter 拒绝消息不影响后续正常消息
4. daemon 重启后 recovery 正确性（需测试 >48h 边界）

**阻塞条件**: 需要稳定的 XMTP dev 环境、测试钱包管理方案（当前硬编码在 `scripts/helpers/wallet.ts`）。

---

## 三、设计待确认事项

### [DESIGN] peerAddress 来源

`daemon.sendMessage(taskId, content, peerAddress)` 中 `peerAddress` 由调用方（OpenClaw session）提供。OpenClaw session 如何知道对方的 XMTP 地址？目前假设 session 在建立时已通过任务系统获得 peerAddress，但任务系统尚未设计，此假设需要确认。

### [DESIGN] groupId vs taskId 作为 onMessage 的路由 key

`OnMessageCallback` 目前的第二个参数是 `groupId`（即 XMTP conversation ID），而业务层更关心 `taskId`。两者的映射需要调用方自行维护（通过 `listGroups()` 可以查到）。是否需要在 `SandboxedMessage` 中直接暴露 `taskId` 字段？这要求 daemon 在收到消息时能反查 group name，增加一次 `g.name` 读取。

### [DESIGN] `[non-text]` 消息的处理策略

当前 sandbox 将非文本消息的 content 替换为 `"[non-text]"`，然后走正常的 filter + queue 路径，最终触发 `onMessage`。如果 handler 对 `"[non-text]"` 字符串做语义处理，可能产生误解。是否应该在 sandbox 阶段就 drop 非文本消息，而非转为占位符字符串传下去？
