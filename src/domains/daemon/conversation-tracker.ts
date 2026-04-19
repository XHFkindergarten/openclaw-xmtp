/**
 * ConversationTracker：task scope 内的对话席位管理。
 *
 * 语义（γ 定义）：
 *   - 席位粒度：按 taskId 分桶，每个 task 最多 `maxConcurrentPerTask` 个活跃 peer（默认 1）
 *   - 席位占用时点：**LLM 发出首次回复时**（由 daemon.sendMessage 调 tryAcquire）
 *     —— 即"daemon 收到消息"本身不占席位；LLM 拉取后决定回复才占
 *   - 释放：close_conversation tool 主动 / idle timeout / response timeout
 *
 * 两类超时（都默认 10 min，可独立配置）：
 *   - idleTimeoutMs       ：双方都沉默（无 inbound 且无 reply）超过 N ms → close("idle")
 *   - responseTimeoutMs   ：peer 已发新 inbound 但 LLM 超过 N ms 未回复 → close("response-timeout")
 *
 * 设计要点：
 *   - 消息的"串行处理"由上游（XMTP SDK 按 sentAt 排序 + watermark 按序推进）保证，
 *     tracker 不再管消息顺序（原 chain/waiters 机制在 γ 语义下不需要）。
 *   - tryAcquire 同步、幂等；task 内已有其他 peer 时直接返回 false，不排队。
 */

export interface ConversationTrackerConfig {
  /** 每个 task 下最多同时活跃的会话数；默认 1 */
  maxConcurrentPerTask?: number;
  /** 空闲多少 ms 自动关闭（双方都沉默）；默认 10 * 60 * 1000 */
  idleTimeoutMs?: number;
  /** LLM 响应超时：有未回复 inbound 后多少 ms 未回复则关闭；默认 10 * 60 * 1000 */
  responseTimeoutMs?: number;
}

export type CloseReason = "manual" | "idle" | "response-timeout";

interface ConversationEntry {
  taskId: string;
  peer: string;
  acquiredAt: number;
  idleTimer: NodeJS.Timeout;
  responseTimer: NodeJS.Timeout | null;
}

export class ConversationTracker {
  private readonly maxPerTask: number;
  private readonly idleMs: number;
  private readonly responseMs: number;
  /** taskId → (peer → entry) */
  private activeByTask = new Map<string, Map<string, ConversationEntry>>();
  private onCloseListeners = new Set<(taskId: string, peer: string, reason: CloseReason) => void>();

  constructor(config: ConversationTrackerConfig = {}) {
    this.maxPerTask = Math.max(config.maxConcurrentPerTask ?? 1, 1);
    this.idleMs = config.idleTimeoutMs ?? 10 * 60 * 1000;
    this.responseMs = config.responseTimeoutMs ?? 10 * 60 * 1000;
  }

  /** 归一化 peer 地址（小写），避免大小写导致的重复席位 */
  static normalizePeer(peer: string): string {
    return peer.toLowerCase();
  }

  /**
   * LLM 准备回复时调用。
   *   - task 内无任何席位 / 该 peer 已占席位 → 占位（或刷新）并返回 true
   *   - task 内席位已满且都是其他 peer → 返回 false（LLM 应中止回复）
   * 同 (task, peer) 重复调用是幂等的，仅重置 idle timer。
   */
  tryAcquire(taskId: string, peer: string): boolean {
    const peerKey = ConversationTracker.normalizePeer(peer);
    const bucket = this.activeByTask.get(taskId);

    if (bucket) {
      const existing = bucket.get(peerKey);
      if (existing) {
        this.resetIdleTimer(existing);
        return true;
      }
      if (bucket.size >= this.maxPerTask) return false;
    }

    const entry: ConversationEntry = {
      taskId,
      peer: peerKey,
      acquiredAt: Date.now(),
      idleTimer: this.armIdleTimer(taskId, peerKey),
      responseTimer: null,
    };
    if (bucket) {
      bucket.set(peerKey, entry);
    } else {
      this.activeByTask.set(taskId, new Map([[peerKey, entry]]));
    }
    return true;
  }

  /**
   * LLM 成功发送回复后调用。
   *   - 重置 idle timer
   *   - 清除 response timer（LLM 已经响应了）
   * 若 (task, peer) 不在活跃席位里（理论上不该发生），no-op。
   */
  touchReply(taskId: string, peer: string): void {
    const entry = this.getEntry(taskId, peer);
    if (!entry) return;
    this.resetIdleTimer(entry);
    if (entry.responseTimer) {
      clearTimeout(entry.responseTimer);
      entry.responseTimer = null;
    }
  }

  /**
   * 入站消息到达时调用（由 middleware 触发）。
   *   - 若 (task, peer) 未占席位 → no-op（γ 语义下不在 inbound 时占位）
   *   - 若已占席位：
   *       · 重置 idle timer（有活动了）
   *       · 启动 response timer（若未启动）—— "peer 已来新消息，LLM 必须在 N ms 内回"
   */
  notifyInbound(taskId: string, peer: string): void {
    const entry = this.getEntry(taskId, peer);
    if (!entry) return;
    this.resetIdleTimer(entry);
    if (!entry.responseTimer) {
      entry.responseTimer = setTimeout(
        // TODO: 依赖上游"任务阶段/对手方状态"的判断上线后，在此加分支：
        //   - 若当前任务尚处于「未锁定对手方」阶段 → 超时仍 close（释放席位供其他 peer 试探）
        //   - 若已锁定对手方（进入长任务执行） → skip close，保持会话挂起
        // 上游数据结构未提供前，保持现状：直接 close。
        () => this.close(taskId, entry.peer, "response-timeout"),
        this.responseMs
      );
      entry.responseTimer.unref?.();
    }
  }

  /** 关闭指定席位，幂等。返回是否真的关掉了（即之前存在）。 */
  close(taskId: string, peer: string, reason: CloseReason = "manual"): boolean {
    const peerKey = ConversationTracker.normalizePeer(peer);
    const bucket = this.activeByTask.get(taskId);
    const entry = bucket?.get(peerKey);
    if (!bucket || !entry) return false;
    clearTimeout(entry.idleTimer);
    if (entry.responseTimer) clearTimeout(entry.responseTimer);
    bucket.delete(peerKey);
    if (bucket.size === 0) this.activeByTask.delete(taskId);
    for (const listener of this.onCloseListeners) listener(taskId, peerKey, reason);
    return true;
  }

  /** 订阅 close 事件，用于联动清理（如 groupCache）。返回取消订阅函数。 */
  onClose(listener: (taskId: string, peer: string, reason: CloseReason) => void): () => void {
    this.onCloseListeners.add(listener);
    return () => this.onCloseListeners.delete(listener);
  }

  /** 全局活跃席位数；传 taskId 则返回该 task 下的活跃数 */
  activeCount(taskId?: string): number {
    if (taskId !== undefined) return this.activeByTask.get(taskId)?.size ?? 0;
    let total = 0;
    for (const bucket of this.activeByTask.values()) total += bucket.size;
    return total;
  }

  /** 列出某 task 当前活跃的 peer 列表 */
  activePeers(taskId: string): string[] {
    const bucket = this.activeByTask.get(taskId);
    return bucket ? Array.from(bucket.keys()) : [];
  }

  // ── 内部 ────────────────────────────────────────────────────────────────

  private getEntry(taskId: string, peer: string): ConversationEntry | undefined {
    return this.activeByTask.get(taskId)?.get(ConversationTracker.normalizePeer(peer));
  }

  private resetIdleTimer(entry: ConversationEntry): void {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = this.armIdleTimer(entry.taskId, entry.peer);
  }

  private armIdleTimer(taskId: string, peer: string): NodeJS.Timeout {
    // TODO: 依赖上游"任务阶段/对手方状态"的判断上线后，在此加分支：
    //   - 若当前任务尚处于「未锁定对手方」阶段 → 超时仍 close
    //   - 若已锁定对手方（进入长任务执行） → skip close，保持会话挂起
    // 上游数据结构未提供前，保持现状：直接 close。
    const t = setTimeout(() => this.close(taskId, peer, "idle"), this.idleMs);
    t.unref?.();
    return t;
  }
}
