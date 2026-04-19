/**
 * Phase 2 验收 3/3：三个钱包各自独立身份，inboxId 互不相同
 */
import { mkdirSync } from "node:fs";
import { Agent } from "@xmtp/agent-sdk";
import { hexToBytes } from "viem";
import { loadTestWallets, createXmtpSigner } from "./helpers/wallet.js";

const wallets = loadTestWallets();
const names = ["alice", "bob", "carol"] as const;

const results: Record<string, { inboxId: string; installationId: string }> = {};

for (const name of names) {
  mkdirSync(`data/${name}`, { recursive: true });
  const wallet = wallets[name];
  const signer = createXmtpSigner(wallet);

  console.log(`Connecting ${name}...`);
  const agent = await Agent.create(signer, {
    env: "dev",
    dbPath: (inboxId: string) => `./data/${name}/xmtp-${inboxId}.db3`,
    dbEncryptionKey: hexToBytes(wallet.dbEncryptionKey),
  });

  results[name] = {
    inboxId: agent.client.inboxId,
    installationId: agent.client.installationId,
  };
  console.log(`  ${name}: inboxId=${agent.client.inboxId}`);
  await agent.stop();
}

const inboxIds = Object.values(results).map((r) => r.inboxId);
const uniqueCount = new Set(inboxIds).size;

console.log("\nAll inboxIds unique:", uniqueCount === inboxIds.length);

if (uniqueCount !== inboxIds.length) {
  console.error("FAIL: duplicate inboxIds detected");
  process.exit(1);
}
console.log("\ntest-multi-identity PASSED");
