import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Agent } from "@xmtp/agent-sdk";
import { hexToBytes } from "viem";
import type { IOnChainOSClient } from "../onchainos/onchainos.js";

export interface XmtpClientOptions {
  env: "dev" | "production";
  /** SQLite 文件存放目录，会在内部自动创建 */
  dbDir: string;
  /**
   * 直接传入数据库加密密钥（优先级高于 envFile）。
   * 用于多钱包场景下按钱包单独指定密钥。
   */
  dbEncryptionKey?: Uint8Array;
  /**
   * .env 文件路径，默认为当前工作目录下的 .env。
   * 若文件中存在 DB_ENCRYPTION_KEY，则用于加密本地 SQLite 数据库；否则不加密。
   * 当 dbEncryptionKey 已直接提供时此字段被忽略。
   */
  envFile?: string;
}

/**
 * XMTP Agent SDK 的收口模块。
 *
 * 通过依赖注入接受 IOnChainOSClient，屏蔽 Agent.create() 的初始化细节。
 * 生产场景注入 OnChainOSClient，测试场景注入 TestOnChainOSClient。
 *
 * DB 加密：若 .env 文件中存在 DB_ENCRYPTION_KEY（32 字节 hex），则加密本地数据库；
 * 否则不加密（开发环境可省略）。
 */
export class XmtpClient {
  private _agent: Agent | null = null;

  constructor(
    private readonly onchainOS: IOnChainOSClient,
    private readonly options: XmtpClientOptions
  ) {}

  /**
   * 初始化 XMTP Agent：从 onchainOS 获取 Signer，
   * 按需读取 .env 中的 DB_ENCRYPTION_KEY，连接 XMTP 网络。
   */
  async connect(): Promise<void> {
    if (this._agent) return;

    mkdirSync(this.options.dbDir, { recursive: true });

    const signer = this.onchainOS.createXmtpSigner();
    const dbEncryptionKey = this.options.dbEncryptionKey ?? this.readDbEncryptionKey();

    this._agent = await Agent.create(signer, {
      env: this.options.env,
      dbPath: (inboxId: string) =>
        `${this.options.dbDir}/xmtp-${inboxId}.db3`,
      ...(dbEncryptionKey ? { dbEncryptionKey } : {}),
    });
  }

  /**
   * 停止 XMTP Agent，释放连接和流。
   */
  async disconnect(): Promise<void> {
    if (!this._agent) return;
    await this._agent.stop();
    this._agent = null;
  }

  /**
   * 返回底层 Agent 实例，供 MessageDaemon 和 MessagingToolkit 使用。
   * 必须在 connect() 之后调用。
   */
  get agent(): Agent {
    if (!this._agent) {
      throw new Error("XmtpClient not connected. Call connect() first.");
    }
    return this._agent;
  }

  /** 当前 Agent 的 XMTP 地址（连接后可用） */
  get address(): string | undefined {
    return this._agent?.address;
  }

  get connected(): boolean {
    return this._agent !== null;
  }

  /**
   * 检测指定 dbDir 下是否已存在 XMTP 数据库文件。
   * 用于多钱包初始化时判断次级钱包是否曾经连接过。
   */
  static hasBeenInitialized(dbDir: string): boolean {
    try {
      const files = readdirSync(dbDir);
      return files.some((f) => f.endsWith(".db3"));
    } catch {
      return false;
    }
  }

  // ── 私有方法 ────────────────────────────────────────────────────────

  /**
   * 从 .env 文件读取 DB_ENCRYPTION_KEY。
   * 文件不存在或字段缺失时返回 undefined（不加密）。
   */
  private readDbEncryptionKey(): Uint8Array | undefined {
    const envPath = this.options.envFile ?? join(process.cwd(), ".env");
    let raw: string;
    try {
      raw = readFileSync(envPath, "utf-8");
    } catch {
      return undefined;
    }

    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const eqIdx = trimmed.indexOf("=");
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      if (key === "DB_ENCRYPTION_KEY" && value) {
        return hexToBytes(value as `0x${string}`);
      }
    }

    return undefined;
  }
}
