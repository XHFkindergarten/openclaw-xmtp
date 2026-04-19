export interface QueueConfig {
  maxConcurrentChats: number; // default 1, max 10
}

interface QueueEntry<T> {
  taskId: string;
  payload: T;
  handler: (payload: T, taskId: string) => Promise<void>;
}

export class SessionQueue<T = unknown> {
  private readonly max: number;
  private active = new Map<string, Promise<void>>();
  private pending: QueueEntry<T>[] = [];

  constructor(config: QueueConfig) {
    this.max = Math.min(Math.max(config.maxConcurrentChats, 1), 10);
  }

  enqueue(
    taskId: string,
    payload: T,
    handler: (payload: T, taskId: string) => Promise<void>
  ): void {
    if (!this.active.has(taskId) && this.active.size < this.max) {
      this.run({ taskId, payload, handler });
    } else {
      this.pending.push({ taskId, payload, handler });
    }
  }

  get activeCount(): number {
    return this.active.size;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  private run(entry: QueueEntry<T>): void {
    const promise = entry
      .handler(entry.payload, entry.taskId)
      .catch((err: unknown) => {
        console.error(`[queue] error in task ${entry.taskId}:`, err);
      })
      .finally(() => {
        this.active.delete(entry.taskId);
        this.drain();
      });
    this.active.set(entry.taskId, promise);
  }

  private drain(): void {
    if (this.pending.length === 0) return;
    if (this.active.size >= this.max) return;

    const idx = this.pending.findIndex((e) => !this.active.has(e.taskId));
    if (idx === -1) return;

    const [entry] = this.pending.splice(idx, 1);
    this.run(entry);
  }
}
