import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

/**
 * 单 conversation 的"已推送给 LLM"水位（per-installation 本地状态）。
 *
 * 水位语义：DecodedMessage.sentAtNs（发送方时钟）。
 *
 * 为什么不用 insertedAtNs（本地 DB 插入时序，理论上更稳）：
 *   node-sdk 的 DecodedMessage 不暴露 insertedAtNs（只有底层 binding 的 raw
 *   Message 接口上有），而 node-sdk 把 #conversation 设为真私有字段，
 *   无法旁路到 binding 层。短期接受 sentAtNs 的代价：极端情况下两个 peer
 *   时钟接近、网络延迟反向时,后到的旧 sentAtNs 消息会被跳过。1:1 agent
 *   对话场景下这个 case 可忽略；多方场景遇到再升级到 ID-based dedup。
 *
 * 文件格式有意把 bigint 存为十进制字符串，避免 JSON.parse 落回 Number 丢精度。
 *
 * 写入策略：每次 ack 立即同步落盘 + 原子 rename。拒绝 lazy timer：
 * 水位 ack 频率本来就低（PULL 间隔级），用同步写换零数据丢失更值。
 *
 * 进程间互斥由上层 daemon 的 pidFile 兜底（多 daemon 同时启动会被拒）。
 */

const SCHEMA_VERSION = 1 as const;

interface PersistedShape {
  version: typeof SCHEMA_VERSION;
  entries: Record<string, string>;
}

export class WatermarkStore {
  private data = new Map<string, bigint>();
  private dirty = false;

  constructor(private filePath: string) {}

  load(): void {
    if (!existsSync(this.filePath)) return;
    const raw = readFileSync(this.filePath, "utf8");
    const parsed = JSON.parse(raw) as PersistedShape;
    if (parsed.version !== SCHEMA_VERSION) {
      throw new Error(
        `[watermark-store] unsupported schema version: ${parsed.version} (expected ${SCHEMA_VERSION}) at ${this.filePath}`
      );
    }
    for (const [k, v] of Object.entries(parsed.entries ?? {})) {
      this.data.set(k, BigInt(v));
    }
  }

  get(conversationId: string): bigint {
    return this.data.get(conversationId) ?? 0n;
  }

  /**
   * 单调推进。小于等于当前水位的 ack 直接拒绝，防止 LLM 回传旧值导致水位倒退。
   * 实际推进时同步落盘，返回 true；否则返回 false。
   */
  ack(conversationId: string, ns: bigint): boolean {
    const cur = this.data.get(conversationId) ?? 0n;
    if (ns <= cur) return false;
    this.data.set(conversationId, ns);
    this.dirty = true;
    this.flushSync();
    return true;
  }

  flushSync(): void {
    if (!this.dirty) return;
    const obj: PersistedShape = {
      version: SCHEMA_VERSION,
      entries: Object.fromEntries(
        Array.from(this.data.entries()).map(([k, v]) => [k, v.toString()])
      ),
    };
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(obj));
    renameSync(tmp, this.filePath);
    this.dirty = false;
  }

  snapshot(): ReadonlyMap<string, bigint> {
    return new Map(this.data);
  }
}
