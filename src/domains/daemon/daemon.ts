import { writeFileSync, unlinkSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Agent } from "@xmtp/agent-sdk";
import type { EncodedContent } from "@xmtp/node-bindings";
import { loggingMiddleware } from "../xmtp/middleware/logging.js";
import { unicodeNormalizeMiddleware } from "../xmtp/middleware/unicode-normalize.js";
import { createInjectionDetectMiddleware } from "../xmtp/middleware/injection-detect.js";
import { createLlmPresentationMiddleware } from "../xmtp/middleware/llm-presentation.js";
import { structuredEnvelopeMiddleware } from "../xmtp/middleware/structured-envelope.js";
import { SensitiveWordGuard } from "../security/sensitive-word-guard.js";
import { RecoveryManager } from "./recovery.js";
import type { TaskGroupEntry } from "./recovery.js";
import { MessagingToolkit } from "../xmtp/messaging.js";
import { ConversationTracker } from "./conversation-tracker.js";
import type { ConversationTrackerConfig } from "./conversation-tracker.js";
import { ContentFilter } from "../security/filter.js";
import type { ContentFilterConfig } from "../security/filter.js";
import { WatermarkStore } from "./watermark-store.js";
import { LlmRenderer } from "../xmtp/render-for-llm.js";

type EthAddress = `0x${string}`;
type Group = Awaited<ReturnType<Agent["createGroupWithAddresses"]>>;

// listGroups 的排序/过滤选项，预留扩展
export interface GroupListOptions {
  sortBy?: "taskId" | "id";
  filter?: (group: GroupInfo) => boolean;
}

export interface GroupInfo {
  id: string;
  taskId: string;
  peerAddress: string;
  memberCount: number;
}

export interface DaemonConfig {
  env: "dev" | "production";
  heartbeatIntervalMs?: number;
  pidFile?: string;
  /** 水位 JSON 文件路径,默认 data/watermarks.json */
  watermarkFile?: string;
  tracker?: ConversationTrackerConfig;
  filter?: ContentFilterConfig;
  /** injection-detect middleware 开关，默认 enabled=true */
  injectionDetect?: { enabled?: boolean };
}

export interface DaemonStatus {
  running: boolean;
  startedAt: Date | null;
  uptimeSeconds: number;
  messageCount: number;
  address: string | undefined;
  activeSubagents: number;
  watermarkCount: number;
  /** injection-detect 命中按 flag-name 的累计计数（daemon 生命周期内，重启清零） */
  injectionFlags: Record<string, number>;
}

export class MessageDaemon {
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private messageCount = 0;
  private startedAt: Date | null = null;
  private streamPromise: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
  private recovery: RecoveryManager;
  private messaging: MessagingToolkit;
  private tracker: ConversationTracker;
  private filter: ContentFilter;
  private watermarks: WatermarkStore;
  private renderer: LlmRenderer | null = null;
  private injectionFlagCounter = new Map<string, number>();

  private readonly pidFile: string;
  private readonly heartbeatIntervalMs: number;

  constructor(
    private agent: Agent,
    private config: DaemonConfig
  ) {
    this.pidFile = config.pidFile ?? "data/daemon.pid.json";
    this.heartbeatIntervalMs = config.heartbeatIntervalMs ?? 30_000;
    this.recovery = new RecoveryManager(agent);
    this.messaging = new MessagingToolkit(agent);
    this.tracker = new ConversationTracker(config.tracker);
    this.filter = new ContentFilter(config.filter);
    this.watermarks = new WatermarkStore(config.watermarkFile ?? "data/watermarks.json");
  }

  async start(): Promise<void> {
    // 重建 task → group 路由表(无持久化设计:重启时全量扫描 XMTP 已持久化的消息,
    // 由 LLM PULL 通过 xmtp_get_pending_list 按需取)
    this.watermarks.load();
    this.renderer = new LlmRenderer(this.agent);
    await this.recovery.rebuild();

    // Middleware chain（按职责拆分，每层只做一件事）：
    //   1. logging           — 最早打点
    //   2. structured-envelope — 拆 JSON envelope，metadata 旁路
    //   3. unicode-normalize — NFC + 剥离零宽/bidi（为后续所有过滤器去混淆）
    //   4. injection-detect  — 启发式正则扫注入特征，flag 旁路到 __injectionFlags
    //   5. sensitive-word    — 黑名单拦截；命中则回警告并 return，不进后续
    //   6. llm-presentation  — 末层拼装 <incoming_message> XML 结构（含 schema/sender/metadata/body）
    //
    // 关键不变量：
    //   - structured-envelope 必须在 llm-presentation 之前（否则 content 被 tag 包裹无法 JSON.parse）
    //   - unicode-normalize 必须在 sensitive-word 之前（否则零宽拆字可绕过字面匹配）
    //   - llm-presentation 放在最末，避免对被拦截的消息做无谓的字符串拼接
    //
    // 注意:中间件对 ctx.message.content 的修改仅在 in-flight handler 内可见,
    // 不会落到 XMTP DB。LLM PULL 路径会通过 LlmRenderer 重跑相同的链。
    // 在线层只剩两个对外副作用:sensitive-word 的对外回警告 + counter 累计。
    this.agent.use(loggingMiddleware);
    this.agent.use(structuredEnvelopeMiddleware);
    this.agent.use(unicodeNormalizeMiddleware);
    this.agent.use(
      createInjectionDetectMiddleware({
        enabled: this.config.injectionDetect?.enabled ?? true,
        counter: this.injectionFlagCounter,
      })
    );
    this.agent.use(
      new SensitiveWordGuard({ replyOnPass: false, replyOnBlock: true }).middleware()
    );
    this.agent.use(createLlmPresentationMiddleware({ agent: this.agent }));

    // tracker notify：inbound 消息到达时，若 (task, peer) 已占席位则启动 response timer。
    // (γ 语义：inbound 本身不占位；只有 LLM 发首次 reply 才占位。)
    // group.name 格式 "${taskId}::${peerAddress}"，与 messaging.ts 创建逻辑对齐。
    this.agent.use(async (ctx, next) => {
      const groupName = (ctx as { conversation?: { name?: string } }).conversation?.name;
      if (groupName) {
        const sep = groupName.indexOf("::");
        if (sep !== -1) {
          const taskId = groupName.slice(0, sep);
          const peer = groupName.slice(sep + 2);
          this.tracker.notifyInbound(taskId, peer);
        }
      }
      await next();
    });

    // 防 middleware/handler 抛错让 SDK 主动 stop:swallow + log + 让 chain 继续。
    // SDK 默认 error handler 对非 AgentStreamingError 不 recover → #runErrorChain 返回 false
    // → SDK 内部 await this.stop() → 整个通信服务不可用。
    // 我们注册一个最早执行的 error handler 调 next() 标记为 "handled",
    // 阻止 SDK 走到 stop 路径。代价:单条消息 handler bug 被静默吃掉(已 log)。
    this.agent.errors.use((err: unknown, _ctx: unknown, next: () => void) => {
      console.error("[daemon] middleware error swallowed:", err);
      next();
    });

    // Pull 模型:入站消息不再 enqueue,LLM 通过 xmtp_get_pending_list 主动拉取。
    // 在线 handler 仅累计计数(供 getStatus 观测)。
    this.agent.on("message", (_ctx) => {
      this.messageCount++;
    });

    // 兜底:即使 errors.use swallow 了所有 middleware 错误,SDK 仍可能因 client 致命错误
    // 自己 stop。区分"我们主动 stop"(this.stopping 已置)和"SDK 单方面 stop"。
    // 后者需要外部 supervisor 重建整个 daemon —— 这里只负责显式告警。
    this.agent.on("stop", () => {
      if (this.stopping) return;
      console.error(
        "[daemon] FATAL: SDK emitted stop unexpectedly — agent stream is dead, restart required"
      );
    });

    this.writePidFile();
    this.startHeartbeat();

    process.on("SIGINT", () => void this.stop());
    process.on("SIGTERM", () => void this.stop());

    this.startedAt = new Date();
    console.log(
      `Daemon started | address: ${this.agent.address ?? "unknown"} | env: ${this.config.env}`
    );

    // SDK 内部已有完整 stream retry(retries=10, exp backoff 1-30s, INFINITELY timeout);
    // 且 agent.start() 的 try/catch 不 rethrow —— 这个 promise 永远 fulfill。
    // 不要在这里再加 .catch 重连,会和 SDK 内部 #retryStreams 双层冲突。
    this.streamPromise = this.agent.start();
  }

  async stop(): Promise<void> {
    // 幂等(in-flight 复用):service.stop 与 SIGINT/SIGTERM handler 可能并发触发,
    // 返回同一个 in-flight promise 让所有调用者 await 同一次完整的 stop。
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      console.log("Daemon stopping...");
      this.clearHeartbeat();
      // try/finally:即使 agent.stop / stream 抛错,也要把 watermark 落盘 + 清 PID,
      // 避免崩溃时未 sync 的 ack 丢失。
      try {
        await this.agent.stop();
        await this.streamPromise;
      } finally {
        // 防御性 flush:理论上每次 ack 已经同步落盘,这里兜底
        this.watermarks.flushSync();
        this.deletePidFile();
        // startedAt 在最末尾才清:期间 getStatus 仍如实报"running",
        // 直到 stop 真正完成才转 false。
        this.startedAt = null;
        console.log(`PID file cleaned: ${!existsSync(this.pidFile)}`);
      }
    })();
    return this.stopping;
  }

  getStatus(): DaemonStatus {
    const uptimeSeconds = this.startedAt
      ? Math.floor((Date.now() - this.startedAt.getTime()) / 1000)
      : 0;
    return {
      running: this.startedAt !== null,
      startedAt: this.startedAt,
      uptimeSeconds,
      messageCount: this.messageCount,
      address: this.agent.address,
      activeSubagents: this.tracker.activeCount(),
      watermarkCount: this.watermarks.snapshot().size,
      injectionFlags: Object.fromEntries(this.injectionFlagCounter),
    };
  }

  /**
   * 关闭指定 (taskId, peerAddress) 的 conversation，释放 tracker 席位。
   * 由 close_conversation agent tool 或外部调用触发。
   */
  closeConversation(taskId: string, peerAddress: string): boolean {
    return this.tracker.close(taskId, peerAddress, "manual");
  }

  /** 获取 ConversationTracker 引用，供观测或测试。 */
  getTracker(): ConversationTracker {
    return this.tracker;
  }

  /** WatermarkStore 引用,供 xmtp_get_pending_list tool 直接 ack。 */
  getWatermarks(): WatermarkStore {
    return this.watermarks;
  }

  /** LlmRenderer 引用,供 xmtp_get_pending_list tool 渲染 raw → XML envelope。 */
  getRenderer(): LlmRenderer {
    if (!this.renderer) {
      throw new Error("[daemon] renderer not ready (call start() first)");
    }
    return this.renderer;
  }

  /** ContentFilter 引用,供 xmtp_get_pending_list tool 在 PULL 时过滤。 */
  getFilter(): ContentFilter {
    return this.filter;
  }

  /** Agent 引用,供 tool 层使用。 */
  getAgent(): Agent {
    return this.agent;
  }

  /** MessagingToolkit 引用,供 xmtp_send tool 直接复用 sendStructured。 */
  getMessaging(): MessagingToolkit {
    return this.messaging;
  }

  // ── OpenClaw session 调用的出口 ──────────────────────────────────────

  /**
   * OpenClaw session 要求发送一条消息到指定 task 的 Group。
   * peerAddress 仅在 Group 不存在时用于创建，已存在则不需要。
   */
  async sendMessage(
    taskId: string,
    content: EncodedContent,
    peerAddress: EthAddress
  ): Promise<{ conversationId: string; messageId: string }> {
    // γ 语义：LLM 发出首次回复时占席位。task 内已有其他 peer 活跃 → 拒绝。
    if (!this.tracker.tryAcquire(taskId, peerAddress)) {
      const peers = this.tracker.activePeers(taskId);
      throw new Error(
        `[daemon] task=${taskId} already conversing with ${peers.join(",")}; ` +
          `refuse to send to ${peerAddress}. Call close_conversation first.`
      );
    }
    const result = await this.messaging.send(taskId, content, peerAddress);
    // 成功发送后刷新 idle timer 并清除 response timer
    this.tracker.touchReply(taskId, peerAddress);
    return result;
  }

  /**
   * OpenClaw session 要求获取当前所有 Group 列表，支持排序和过滤。
   */
  async listGroups(options?: GroupListOptions): Promise<GroupInfo[]> {
    await this.agent.client.conversations.sync();
    const groups = await this.agent.client.conversations.listGroups();

    const parsed = await Promise.all(
      groups.map(async (g) => {
        const sep = g.name.indexOf("::");
        if (sep === -1) return null; // not created by this SDK
        const taskId = g.name.slice(0, sep);
        const peerAddress = g.name.slice(sep + 2);
        const members = await g.members();
        return { id: g.id, taskId, peerAddress, memberCount: members.length } satisfies GroupInfo;
      })
    );

    let infos = parsed.filter((x): x is GroupInfo => x !== null);

    if (options?.filter) {
      infos = infos.filter(options.filter);
    }

    if (options?.sortBy === "taskId") {
      infos.sort((a, b) => a.taskId.localeCompare(b.taskId));
    } else if (options?.sortBy === "id") {
      infos.sort((a, b) => a.id.localeCompare(b.id));
    }

    return infos;
  }

  /**
   * 返回启动时重建的 task → group 路由表（内存中，无网络请求）。
   * key 为 taskId，value 含 groupId 和 peerAddress。
   */
  getTaskGroupMap(): ReadonlyMap<string, TaskGroupEntry> {
    return this.recovery.getTaskGroupMap();
  }

  // ── 私有方法 ────────────────────────────────────────────────────────

  private writePidFile(): void {
    // stale PID 检测:crash 场景下旧 PID 文件可能残留。
    // 若旧 PID 仍是活进程 → 拒绝启动(避免两个 daemon 抢同一个 XMTP DB);
    // 若旧 PID 已死或文件损坏 → 覆盖。
    if (existsSync(this.pidFile)) {
      try {
        const raw = JSON.parse(readFileSync(this.pidFile, "utf-8"));
        const oldPid = Number(raw?.pid);
        if (oldPid && oldPid !== process.pid && this.isProcessAlive(oldPid)) {
          throw new Error(
            `[daemon] refuse to start: pid ${oldPid} still alive (pidFile=${this.pidFile})`
          );
        }
        if (oldPid && oldPid !== process.pid) {
          console.warn(
            `[daemon] stale PID file (pid=${oldPid} dead), reclaiming`
          );
        }
      } catch (err) {
        // 校验失败时,refuse 错误原样抛出;JSON 解析/读取失败算 stale,覆盖。
        if (err instanceof Error && err.message.startsWith("[daemon] refuse")) {
          throw err;
        }
        console.warn(
          `[daemon] PID file unreadable, overwriting: ${String(err)}`
        );
      }
    }
    mkdirSync(dirname(this.pidFile), { recursive: true });
    writeFileSync(
      this.pidFile,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })
    );
  }

  private isProcessAlive(pid: number): boolean {
    try {
      // signal 0:不发真正的信号,仅测试进程存在性。
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // ESRCH = 进程不存在(已死);EPERM = 进程存在但无权限发信号(仍是活进程,
      // 通常是另一个用户跑的)。两种都不能视为"已死",EPERM 当作"活"来安全拒绝启动。
      const code = (err as NodeJS.ErrnoException)?.code;
      return code === "EPERM";
    }
  }

  private deletePidFile(): void {
    if (existsSync(this.pidFile)) {
      unlinkSync(this.pidFile);
    }
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      const { uptimeSeconds, messageCount } = this.getStatus();
      console.log(`Heartbeat: alive | uptime: ${uptimeSeconds}s | messages: ${messageCount}`);
    }, this.heartbeatIntervalMs);
    this.heartbeatTimer.unref();
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
