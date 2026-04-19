/**
 * xmtp-revoke.ts
 *
 * 扫描 data/ 下所有本地 .db3 对应的钱包账户，依次连接 XMTP 并调用
 * revokeAllOtherInstallations()，仅保留本地目录中存在的 installation。
 *
 * 运行前请先停止 gateway（openclaw daemon stop），避免与 daemon 同时打开
 * SQLite db 造成冲突。
 */
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { TestOnChainOSClient } from "../test/helpers/test-onchainos.js";
import { XmtpClient } from "../src/domains/xmtp/xmtp.js";

const EXTENSION_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = resolve(EXTENSION_ROOT, "data");

function listInitializedAccounts(): string[] {
  return readdirSync(DATA_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .filter((d) =>
      readdirSync(resolve(DATA_DIR, d.name)).some((f) => f.endsWith(".db3"))
    )
    .map((d) => d.name);
}

async function revokeForAccount(accountName: string) {
  console.log(`\n━━━ ${accountName} ━━━`);
  const dbDir = resolve(DATA_DIR, accountName);
  const onchainOS = new TestOnChainOSClient(accountName);
  const client = new XmtpClient(onchainOS, { env: "dev", dbDir });
  await client.connect();
  console.log(`  address=${client.address}`);

  const inbox = await client.agent.client.preferences.inboxState();
  const currentId = client.agent.client.installationId;
  console.log(`  current installationId=${currentId}`);
  console.log(`  total installations on network: ${inbox.installations.length}`);
  for (const inst of inbox.installations) {
    const mark = inst.id === currentId ? "KEEP" : "revoke";
    console.log(`    [${mark}] ${inst.id}`);
  }

  const others = inbox.installations.filter((i) => i.id !== currentId);
  if (others.length === 0) {
    console.log("  no other installations, skip");
    await client.disconnect();
    return;
  }

  console.log(`  revoking ${others.length} other installation(s)...`);
  await client.agent.client.revokeAllOtherInstallations();
  const after = await client.agent.client.preferences.inboxState();
  console.log(`  done. remaining: ${after.installations.length}`);
  await client.disconnect();
}

async function main() {
  const accounts = listInitializedAccounts();
  console.log(`found ${accounts.length} initialized account(s): ${accounts.join(", ")}`);
  for (const name of accounts) {
    try {
      await revokeForAccount(name);
    } catch (err) {
      console.error(`[${name}] revoke failed:`, err);
    }
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
