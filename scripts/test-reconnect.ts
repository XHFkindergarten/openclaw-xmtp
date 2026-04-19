/**
 * Phase 2 验收 2/3：重连验证 inboxId 持久化（同一 .db3 = 同一 installation）
 */
import { Agent } from "@xmtp/agent-sdk";
import { hexToBytes } from "viem";
import { loadTestWallet, createXmtpSigner } from "./helpers/wallet.js";

async function connect(label: string) {
  const wallet = loadTestWallet("alice");
  const signer = createXmtpSigner(wallet);
  const agent = await Agent.create(signer, {
    env: "dev",
    dbPath: (inboxId: string) => `./data/alice/xmtp-${inboxId}.db3`,
    dbEncryptionKey: hexToBytes(wallet.dbEncryptionKey),
  });
  const result = {
    inboxId: agent.client.inboxId,
    installationId: agent.client.installationId,
  };
  await agent.stop();
  console.log(`[${label}] inboxId=${result.inboxId} installationId=${result.installationId}`);
  return result;
}

console.log("Connecting first time...");
const first = await connect("connect-1");

console.log("Reconnecting with same dbPath...");
const second = await connect("connect-2");

const inboxMatch = first.inboxId === second.inboxId;
const installMatch = first.installationId === second.installationId;

console.log("\ninboxId matches:        ", inboxMatch);
console.log("installationId matches: ", installMatch);

if (!inboxMatch || !installMatch) {
  console.error("FAIL: persistence broken — new installation created on reconnect");
  process.exit(1);
}
console.log("\ntest-reconnect PASSED");
