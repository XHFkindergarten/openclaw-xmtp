import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Signer, Identifier } from "@xmtp/node-sdk";

const execFileAsync = promisify(execFile);

// ── 类型定义 ──────────────────────────────────────────────────────────

export interface EvmAddress {
  address: string;
  chainIndex: string;
  chainName: string;
}

export interface WalletAddresses {
  accountId: string;
  accountName: string;
  evm: EvmAddress[];
}

/**
 * EIP-8004 Agent 身份。
 * 字段将在 onchainos 新增 Agent 身份 API 后确认，当前为占位定义。
 */
export interface AgentIdentity {
  agentId: string;
  ownerAddress: string;
  /** XMTP 通信地址，由 ownerAddress + agentId 组合派生 */
  xmtpAddress: string;
}

// onchainos CLI 统一响应格式
interface CliResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

/**
 * 单个账户的完整信息（含 isSelected 标识）。
 * 用于多钱包初始化场景，判断哪个是主钱包、哪些是次级钱包。
 */
export interface AccountInfo {
  accountId: string;
  accountName: string;
  /** 当前 onchainos 选中的主钱包 */
  isSelected: boolean;
  evm: EvmAddress[];
}

// ── 共享接口（测试类与生产类均实现此接口）────────────────────────────

export interface IOnChainOSClient {
  getWalletAddresses(): Promise<WalletAddresses>;
  getXLayerAddress(): Promise<string>;
  createXmtpSigner(agentId?: string): Signer;
  getAgentIdentity(agentId?: string): Promise<AgentIdentity>;
  getXmtpAddress(agentId?: string): Promise<string>;
  /**
   * 获取 onchainos 管理的所有账户列表。
   * isSelected 标识当前选中的主钱包（对应 getWalletAddresses() 返回的账户）。
   *
   * TODO: onchainos 新增多账户列表 API 后替换实现。
   * 预期命令形式: onchainos wallet list --format json
   */
  getAllAccounts(): Promise<AccountInfo[]>;
}

// ── 生产实现（调用 onchainos CLI）────────────────────────────────────

export class OnChainOSClient implements IOnChainOSClient {
  constructor(private readonly binaryPath = "onchainos") {}

  // ── 内部工具 ──────────────────────────────────────────────────────

  private async run<T>(args: string[]): Promise<T> {
    const { stdout } = await execFileAsync(this.binaryPath, args);
    const result = JSON.parse(stdout) as CliResponse<T>;
    if (!result.ok) {
      throw new Error(`onchainos error: ${result.error ?? "unknown"}`);
    }
    return result.data as T;
  }

  // ── 已可用：钱包地址 ──────────────────────────────────────────────

  /** 获取当前登录账户的所有钱包地址 */
  async getWalletAddresses(): Promise<WalletAddresses> {
    return this.run<WalletAddresses>(["wallet", "addresses"]);
  }

  /**
   * 获取 XLayer 链地址。
   * XMTP 身份注册使用 XLayer 地址（chainName=xlayer），而非 ETH 主网。
   * XLayer 与 ETH 为同一 EVM 密钥，但业务上需明确区分。
   */
  async getXLayerAddress(): Promise<string> {
    const { evm } = await this.getWalletAddresses();
    const entry = evm.find((a) => a.chainName === "xlayer");
    if (!entry) throw new Error("onchainos: no XLayer address found");
    return entry.address;
  }

  // ── 已可用：XMTP Signer ───────────────────────────────────────────

  /**
   * 构造供 XMTP Agent.create() 使用的 EOA Signer。
   *
   * - getIdentifier: 从 onchainos 读取 XLayer 地址
   * - signMessage:   委托 onchainos 对消息进行签名
   *
   * TODO: signMessage 目前为占位实现，等待 onchainos 新增消息签名 API 后替换。
   * 预期命令形式: onchainos wallet sign-message --message <hex>
   *
   * @param agentId 指定 AgentID；省略时使用当前账户默认 Agent
   */
  createXmtpSigner(_agentId?: string): Signer {
    return {
      type: "EOA",

      getIdentifier: async (): Promise<Identifier> => {
        const address = await this.getXLayerAddress();
        // IdentifierKind.Ethereum = 0（const enum，避免双包解析冲突，直接使用数字字面量）
        return { identifier: address, identifierKind: 0 } as Identifier;
      },

      // TODO: onchainos 新增消息签名命令后替换。
      // 预期: onchainos wallet sign-message --message <hex>
      // 返回: { ok: true, data: { signature: "0x..." } }
      // 实现: hexToBytes(signature) → Uint8Array
      signMessage: (_message: string): Promise<Uint8Array> => {
        throw new Error(
          "Not implemented: waiting for onchainos to add wallet sign-message support."
        );
      },
    };
  }

  // ── 占位：EIP-8004 Agent 身份（等待 onchainos 支持后实现）─────────

  /**
   * 获取 EIP-8004 Agent 身份信息。
   *
   * TODO: onchainos 新增 Agent 身份 API 后替换实现。
   * 预期命令形式: onchainos agent identity [--agent-id <id>]
   *
   * @param _agentId 指定 AgentID；省略时使用当前账户默认 Agent
   */
  async getAgentIdentity(_agentId?: string): Promise<AgentIdentity> {
    throw new Error(
      "Not implemented: waiting for onchainos to add EIP-8004 agent identity support."
    );
  }

  /**
   * 获取 Agent 的 XMTP 通信地址。
   *
   * TODO: onchainos 新增 XMTP 地址 API 后替换实现。
   * XMTP 通信地址由 ownerAddress + agentId 组合生成；
   * 若 ownerAddress 发生变更（EIP-8004 NFT 转移），通信地址也需重新注册。
   *
   * @param _agentId 指定 AgentID；省略时使用当前账户默认 Agent
   */
  async getXmtpAddress(_agentId?: string): Promise<string> {
    throw new Error(
      "Not implemented: waiting for onchainos to add XMTP address derivation support."
    );
  }

  /**
   * 获取 onchainos 管理的所有账户列表。
   *
   * TODO: onchainos 新增多账户列表 API 后替换实现。
   * 预期命令形式: onchainos wallet list --format json
   */
  async getAllAccounts(): Promise<AccountInfo[]> {
    throw new Error(
      "Not implemented: waiting for onchainos to add multi-account list support."
    );
  }
}
