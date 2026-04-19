/**
 * Phase 3 验收 1/2：基于 Group 的双向通信（每个 taskId 对应一个独立 Group）
 */
import { Agent } from "@xmtp/agent-sdk";
import { encodeText } from "@xmtp/node-sdk";
import { hexToBytes } from "viem";
import { loadTestWallet, createXmtpSigner } from "./helpers/wallet.js";

const aliceWallet = loadTestWallet("alice");
const bobWallet = loadTestWallet("bob");

console.log("Creating alice agent...");
const alice = await Agent.create(createXmtpSigner(aliceWallet), {
  env: "dev",
  dbPath: (inboxId: string) => `./data/alice/xmtp-${inboxId}.db3`,
  dbEncryptionKey: hexToBytes(aliceWallet.dbEncryptionKey),
});

console.log("Creating bob agent...");
const bob = await Agent.create(createXmtpSigner(bobWallet), {
  env: "dev",
  dbPath: (inboxId: string) => `./data/bob/xmtp-${inboxId}.db3`,
  dbEncryptionKey: hexToBytes(bobWallet.dbEncryptionKey),
});

const aliceInboxId = alice.client.inboxId;
const bobInboxId = bob.client.inboxId;
console.log(`alice inboxId: ${aliceInboxId}`);
console.log(`bob   inboxId: ${bobInboxId}`);

// Alice 作为发起方，为 task-001 创建 Group（groupName = taskId）
const taskId = "task-001";
const group = await alice.createGroupWithAddresses(
  [bobWallet.address as `0x${string}`],
  { groupName: taskId }
);
console.log(`Group created: id=${group.id} name=${group.name}`);

// Alice 发送消息
await group.send(encodeText("Hello from Alice"));
console.log('Alice -> Group: "Hello from Alice" ✓ sent');

// Bob 同步会话列表，找到 taskId 对应的 Group
await bob.client.conversations.sync();
const bobConvs = await bob.client.conversations.listGroups();
const bobGroup = bobConvs.find((g) => g.name === taskId);
if (!bobGroup) throw new Error(`Bob cannot find group for task ${taskId}`);

await bobGroup.sync();
const bobMessages = await bobGroup.messages();
const received = bobMessages.find(
  (m) => m.senderInboxId === aliceInboxId && m.content === "Hello from Alice"
);
if (!received) throw new Error("Bob did not receive alice's message");
console.log(`Bob received: "${received.content}" from ${received.senderInboxId} ✓`);

// Bob 回复
await bobGroup.send(encodeText("Hello back from Bob"));
console.log('Bob -> Group: "Hello back from Bob" ✓ sent');

// Alice 同步并验证
await alice.client.conversations.sync();
await group.sync();
const aliceMessages = await group.messages();
const reply = aliceMessages.find(
  (m) => m.senderInboxId === bobInboxId && m.content === "Hello back from Bob"
);
if (!reply) throw new Error("Alice did not receive bob's reply");
console.log(`Alice received: "${reply.content}" from ${reply.senderInboxId} ✓`);

await alice.stop();
await bob.stop();
console.log("\ntest-dm PASSED");
process.exit(0);
