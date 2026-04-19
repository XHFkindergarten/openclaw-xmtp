/**
 * 调试脚本：逐步隔离 XMTP 连接问题
 */
console.log("[1] script started");

let Agent: typeof import("@xmtp/agent-sdk").Agent;
let createUser: typeof import("@xmtp/agent-sdk").createUser;
let createSigner: typeof import("@xmtp/agent-sdk").createSigner;

try {
  const sdk = await import("@xmtp/agent-sdk");
  Agent = sdk.Agent;
  createUser = sdk.createUser;
  createSigner = sdk.createSigner;
  console.log("[2] @xmtp/agent-sdk imported ok");
} catch (e) {
  console.error("[2] FAIL import @xmtp/agent-sdk:", (e as Error).message);
  process.exit(1);
}

import { hexToBytes } from "viem";
import { loadTestWallet } from "./helpers/wallet.js";

const wallet = loadTestWallet("alice");
console.log("[3] wallet loaded:", wallet.address);

let signer: ReturnType<typeof createSigner>;
try {
  const user = createUser(wallet.privateKey);
  signer = createSigner(user);
  const id = await signer.getIdentifier();
  console.log("[4] signer created:", id.identifier.slice(0, 10) + "...");
} catch (e) {
  console.error("[4] FAIL createSigner:", (e as Error).message);
  process.exit(1);
}

import { mkdirSync } from "node:fs";
mkdirSync("data/alice", { recursive: true });
console.log("[5] data/alice dir ready");

console.log("[6] calling Agent.create (may take 5-10s)...");
try {
  const agent = await Agent.create(signer, {
    env: "dev",
    dbPath: (inboxId: string) => `./data/alice/xmtp-${inboxId}.db3`,
    dbEncryptionKey: hexToBytes(wallet.dbEncryptionKey),
  });
  console.log("[7] Agent.create ok");
  console.log("    inboxId:        ", agent.client.inboxId);
  console.log("    installationId: ", agent.client.installationId);
  await agent.stop();
  console.log("[8] agent stopped");
} catch (e) {
  console.error("[7] FAIL Agent.create:", (e as Error).message);
  console.error((e as Error).stack);
  process.exit(1);
}

console.log("\ndebug-connect DONE");
