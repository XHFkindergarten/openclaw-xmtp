/**
 * initXmtpInstall：extension 启动时初始化 XMTP 通信。
 *
 * 多钱包规则：所有 onchainos 返回的账户无条件连接，不区分主/次级钱包，
 * 也不依赖 dbDir 下是否已有 .db3 文件。
 *
 * 返回已连接的 XmtpClient + MessageDaemon 列表，供调用方做生命周期管理。
 */
import { join } from "node:path";
import { TestOnChainOSClient } from "../../test/helpers/test-onchainos.js";
import { XmtpClient } from "../domains/xmtp/xmtp.js";
import { MessageDaemon } from "../domains/daemon/daemon.js";

export interface XmtpInstall {
  accountName: string;
  address: string | undefined;
  client: XmtpClient;
  daemon: MessageDaemon;
}

export interface InitXmtpInstallOptions {
  /** 主钱包 accountName（生产中从 onchainos 当前登录账户取，这里走测试钱包） */
  mainAccount?: string;
  /** 每个账户的 XMTP DB 根目录，默认 "data" */
  dbBaseDir?: string;
  env?: "dev" | "production";
  log?: (msg: string) => void;
}

export async function initXmtpInstall(
  options: InitXmtpInstallOptions = {}
): Promise<XmtpInstall[]> {
  const {
    mainAccount = "alice",
    dbBaseDir = "data",
    env = "dev",
    log = (m) => console.log(m),
  } = options;

  const main = new TestOnChainOSClient(mainAccount);
  const accounts = await main.getAllAccounts();

  log(`[a2a-xmtp] found ${accounts.length} account(s)`);

  const installs: XmtpInstall[] = [];

  for (const account of accounts) {
    const dbDir = `${dbBaseDir}/${account.accountName}`;
    log(`[a2a-xmtp] connect ${account.accountName}`);

    const onchainOS = new TestOnChainOSClient(account.accountName);
    const client = new XmtpClient(onchainOS, { env, dbDir });
    await client.connect();
    log(`[a2a-xmtp]   address=${client.address}`);

    const daemon = new MessageDaemon(client.agent, {
      env,
      pidFile: join(dbDir, "daemon.pid.json"),
      watermarkFile: join(dbDir, "watermarks.json"),
    });
    await daemon.start();

    installs.push({
      accountName: account.accountName,
      address: client.address,
      client,
      daemon,
    });
  }

  log(`[a2a-xmtp] ${installs.length} install(s) ready`);
  return installs;
}
