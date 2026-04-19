/**
 * TestOnChainOSClient
 *
 * 与 OnChainOSClient 相同的接口，但使用本地私钥（config/test-wallets.json）实现，
 * 不依赖 onchainos CLI，可在无网络的单元测试中直接使用。
 */
import { createUser, createSigner } from "@xmtp/agent-sdk";
import type { Signer } from "@xmtp/node-sdk";
import { loadTestWallet, loadTestWallets } from "../../scripts/helpers/wallet.js";
import type {
  IOnChainOSClient,
  WalletAddresses,
  AgentIdentity,
  AccountInfo,
} from "../../src/domains/onchainos/onchainos.js";

// XLayer chainIndex: 196（主网）
const XLAYER_CHAIN_INDEX = "196";

export class TestOnChainOSClient implements IOnChainOSClient {
  private readonly wallet: ReturnType<typeof loadTestWallet>;
  private readonly walletName: string;

  /**
   * @param walletName config/test-wallets.json 中的 key，默认 "alice"
   *                   该钱包作为当前选中的主钱包（isSelected=true）
   */
  constructor(walletName = "alice") {
    this.walletName = walletName;
    this.wallet = loadTestWallet(walletName);
  }

  async getWalletAddresses(): Promise<WalletAddresses> {
    return {
      accountId: `test-${this.wallet.address.slice(2, 10)}`,
      accountName: this.walletName,
      evm: [
        {
          address: this.wallet.address,
          chainIndex: XLAYER_CHAIN_INDEX,
          chainName: "xlayer",
        },
      ],
    };
  }

  async getXLayerAddress(): Promise<string> {
    return this.wallet.address;
  }

  /**
   * 使用本地私钥创建真实的 XMTP EOA Signer，签名实际可用。
   */
  createXmtpSigner(_agentId?: string): Signer {
    const user = createUser(this.wallet.privateKey);
    return createSigner(user);
  }

  async getAgentIdentity(_agentId?: string): Promise<AgentIdentity> {
    throw new Error("TestOnChainOSClient: getAgentIdentity not implemented");
  }

  async getXmtpAddress(_agentId?: string): Promise<string> {
    throw new Error("TestOnChainOSClient: getXmtpAddress not implemented");
  }

  /**
   * 返回 config/test-wallets.json 中的所有钱包，
   * 当前构造时传入的 walletName 标记为 isSelected=true（主钱包）。
   */
  async getAllAccounts(): Promise<AccountInfo[]> {
    const wallets = loadTestWallets();
    return Object.entries(wallets).map(([name, wallet]) => ({
      accountId: `test-${wallet.address.slice(2, 10)}`,
      accountName: name,
      isSelected: name === this.walletName,
      evm: [
        {
          address: wallet.address,
          chainIndex: XLAYER_CHAIN_INDEX,
          chainName: "xlayer",
        },
      ],
    }));
  }

  /**
   * 为指定账户名创建 XMTP Signer（多钱包初始化时使用）。
   */
  createXmtpSignerForAccount(accountName: string): Signer {
    const wallet = loadTestWallet(accountName);
    const user = createUser(wallet.privateKey);
    return createSigner(user);
  }
}
