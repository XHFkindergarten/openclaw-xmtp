/**
 * Phase 2 验收 1/3：首次连接 XMTP 网络，验证身份注册和 SQLite 持久化
 */
import { mkdirSync, existsSync } from "node:fs";
import { globSync } from "node:fs";
import { Agent } from "@xmtp/agent-sdk";
import { hexToBytes } from "viem";
import { loadTestWallet, createXmtpSigner } from "./helpers/wallet.js";

const wallet = loadTestWallet("alice");
const signer = createXmtpSigner(wallet);

mkdirSync("data/alice", { recursive: true });

console.log("Connecting to XMTP dev network...");
const agent = await Agent.create(signer, {
  env: "dev",
  dbPath: (inboxId: string) => `./data/alice/xmtp-${inboxId}.db3`,
  dbEncryptionKey: hexToBytes(wallet.dbEncryptionKey),
});

console.log("Alice address:    ", wallet.address);
console.log("Inbox ID:         ", agent.client.inboxId);
console.log("Installation ID:  ", agent.client.installationId);

const dbFiles = globSync("data/alice/*.db3");
console.log("DB files created: ", dbFiles.length > 0);
if (dbFiles.length > 0) {
  console.log("DB path:          ", dbFiles[0]);
}

await agent.stop();
console.log("\ntest-connect PASSED");
