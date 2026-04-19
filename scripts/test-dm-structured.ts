/**
 * Phase 3 验收 2/2：结构化 JSON 消息通过 XMTP Group 文本 channel 传输
 * 验证 XMTP text channel 能可靠承载任意 JSON payload，协议格式留待任务系统确定后再定义。
 */
import { Agent } from "@xmtp/agent-sdk";
import { encodeText } from "@xmtp/node-sdk";
import { hexToBytes } from "viem";
import { loadTestWallet, createXmtpSigner } from "./helpers/wallet.js";

const aliceWallet = loadTestWallet("alice");
const bobWallet = loadTestWallet("bob");

const alice = await Agent.create(createXmtpSigner(aliceWallet), {
  env: "dev",
  dbPath: (inboxId: string) => `./data/alice/xmtp-${inboxId}.db3`,
  dbEncryptionKey: hexToBytes(aliceWallet.dbEncryptionKey),
});

const bob = await Agent.create(createXmtpSigner(bobWallet), {
  env: "dev",
  dbPath: (inboxId: string) => `./data/bob/xmtp-${inboxId}.db3`,
  dbEncryptionKey: hexToBytes(bobWallet.dbEncryptionKey),
});

const aliceInboxId = alice.client.inboxId;
const taskId = "task-structured-001";

// Alice 创建任务 Group
const group = await alice.createGroupWithAddresses(
  [bobWallet.address as `0x${string}`],
  { groupName: taskId }
);

// Alice 发送任意 JSON（格式留待任务系统定义）
const payload = {
  from: aliceInboxId,
  taskId,
  timestamp: Date.now(),
  data: { message: "I'm interested in your service", budget: 500 },
};
const raw = JSON.stringify(payload);
await group.send(encodeText(raw));
console.log(`Sent JSON payload for task "${taskId}"`);

// Bob 找到对应 Group 并读取消息
await bob.client.conversations.sync();
const bobConvs = await bob.client.conversations.listGroups();
const bobGroup = bobConvs.find((g) => g.name === taskId);
if (!bobGroup) throw new Error(`Bob cannot find group for task ${taskId}`);

await bobGroup.sync();
const messages = await bobGroup.messages();
const jsonMsg = messages.find((m) => {
  try {
    JSON.parse(m.content as string);
    return true;
  } catch {
    return false;
  }
});
if (!jsonMsg) throw new Error("Bob did not receive JSON message");

const parsed = JSON.parse(jsonMsg.content as string);
if (parsed.taskId !== taskId) throw new Error("taskId mismatch");
if (parsed.from !== aliceInboxId) throw new Error("from mismatch");
if (parsed.data.budget !== 500) throw new Error("data mismatch");

console.log(`Bob received and parsed JSON: ✓`);
console.log(`taskId matches: ${parsed.taskId} ✓`);
console.log(`data integrity: budget=${parsed.data.budget} ✓`);

await alice.stop();
await bob.stop();
console.log("\ntest-dm-structured PASSED");
process.exit(0);
