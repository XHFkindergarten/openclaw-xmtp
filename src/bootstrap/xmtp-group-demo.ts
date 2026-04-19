/**
 * Group Chat Demo
 *
 * 流程：
 *  1. alice 和 bob 各自初始化 XMTP client，启动消息流
 *  2. alice 创建一个 group（含所有可自定义字段），成员：alice + bob
 *  3. alice 发送第一条消息
 *  4. bob 收到消息（终端输出），bob 发送回复
 *  5. alice 收到 bob 的回复（终端输出）
 */
import { hexToBytes } from "viem";
import { encodeText } from "@xmtp/node-sdk";
import type { CreateGroupOptions } from "@xmtp/node-sdk";
import { TestOnChainOSClient } from "../../test/helpers/test-onchainos.js";
import { XmtpClient } from "../domains/xmtp/xmtp.js";
import { loadTestWallet } from "../../scripts/helpers/wallet.js";

// ── 工具 ─────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

function log(tag: string, ...args: unknown[]) {
  const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  console.log(`[${ts}] [${tag.padEnd(10)}]`, ...args);
}

function separator(title: string) {
  console.log(`\n${"─".repeat(56)}`);
  console.log(`  ${title}`);
  console.log(`${"─".repeat(56)}`);
}

// ── 1. 加载钱包信息 ──────────────────────────────────────────────────

separator("Phase 1 · Load wallets");

const aliceWallet = loadTestWallet("alice");
const bobWallet   = loadTestWallet("bob");

log("wallets", `alice  ${aliceWallet.address}`);
log("wallets", `bob    ${bobWallet.address}`);

// ── 2. 连接 XMTP clients ─────────────────────────────────────────────

separator("Phase 2 · Connect XMTP clients");

// alice: db 未加密（之前以明文模式创建）
const aliceXmtp = new XmtpClient(new TestOnChainOSClient("alice"), {
  env: "dev",
  dbDir: "data/alice",
});

// bob: db 加密（直接传入 bob 的密钥）
const bobXmtp = new XmtpClient(new TestOnChainOSClient("bob"), {
  env: "dev",
  dbDir: "data/bob",
  dbEncryptionKey: hexToBytes(bobWallet.dbEncryptionKey),
});

log("connect", "connecting alice...");
await aliceXmtp.connect();
log("connect", `alice OK | inboxId: ${aliceXmtp.agent.client.inboxId}`);
log("connect", `         address:  ${aliceXmtp.address}`);

log("connect", "connecting bob...");
await bobXmtp.connect();
log("connect", `bob   OK | inboxId: ${bobXmtp.agent.client.inboxId}`);
log("connect", `         address:  ${bobXmtp.address}`);

// ── 3. 注册消息监听器，启动 stream ───────────────────────────────────

separator("Phase 3 · Start message streams");

const aliceAgent = aliceXmtp.agent;
const bobAgent   = bobXmtp.agent;

aliceAgent.on("message", (ctx) => {
  const text = typeof ctx.message.content === "string"
    ? ctx.message.content : "[non-text]";
  log("alice←   ", `conv=${ctx.conversation.id.slice(0, 12)}…`);
  log("alice←   ", `  from   : ${ctx.message.senderInboxId.slice(0, 20)}…`);
  log("alice←   ", `  content: "${text}"`);
});

bobAgent.on("message", (ctx) => {
  const text = typeof ctx.message.content === "string"
    ? ctx.message.content : "[non-text]";
  log("bob←     ", `conv=${ctx.conversation.id.slice(0, 12)}…`);
  log("bob←     ", `  from   : ${ctx.message.senderInboxId.slice(0, 20)}…`);
  log("bob←     ", `  content: "${text}"`);
});

log("stream", "starting alice agent.start()...");
aliceAgent.start().catch((e: unknown) => log("error", "alice stream:", e));

log("stream", "starting bob agent.start()...");
bobAgent.start().catch((e: unknown) => log("error", "bob stream:", e));

log("stream", "waiting for streams to initialize...");
await sleep(2000);

// ── 4. Alice 创建 Group ──────────────────────────────────────────────

separator("Phase 4 · Alice creates group");

const groupOptions: CreateGroupOptions = {
  groupName: "a2a-sdk-demo",
  groupDescription: "Demo group for @okx/a2a-xmtp-sdk — alice & bob",
  groupImageUrlSquare: "https://xmtp.org/img/logo.png",
  appData: JSON.stringify({
    sdk: "@okx/a2a-xmtp-sdk",
    version: "0.1.0",
    purpose: "group-demo",
    createdBy: aliceXmtp.address,
  }),
};

log("group", "creating group with options:");
log("group", `  groupName       : ${groupOptions.groupName}`);
log("group", `  groupDescription: ${groupOptions.groupDescription}`);
log("group", `  groupImageUrl   : ${groupOptions.groupImageUrlSquare}`);
log("group", `  appData         : ${groupOptions.appData}`);
log("group", `  members to add  : [bob] ${bobWallet.address}`);

const group = await aliceAgent.createGroupWithAddresses(
  [bobWallet.address as `0x${string}`],
  groupOptions
);

const members = await group.members();
log("group", `created! id=${group.id}`);
log("group", `  name   : ${group.name}`);
log("group", `  members: ${members.length}`);
for (const m of members) {
  log("group", `    - ${m.inboxId.slice(0, 24)}…`);
}

// ── 5. Alice 发送第一条消息 ──────────────────────────────────────────

separator("Phase 5 · Alice sends message");

await sleep(500);
const msg1 = "Hello Bob! This is the first message via @okx/a2a-xmtp-sdk group chat.";
log("alice→   ", `sending: "${msg1}"`);
await group.send(encodeText(msg1));
log("alice→   ", "message sent, waiting for bob to receive...");

// ── 6. Bob 同步 & 发送回复 ───────────────────────────────────────────

await sleep(3000);

separator("Phase 6 · Bob syncs and replies");

log("sync", "bob syncing conversations...");
await bobAgent.client.conversations.sync();
const bobGroups = await bobAgent.client.conversations.listGroups();
log("sync", `bob has ${bobGroups.length} group(s) after sync`);

const bobGroup = bobGroups.find((g) => g.id === group.id);
if (!bobGroup) {
  log("error", `bob cannot find group ${group.id} — aborting`);
  process.exit(1);
}

await bobGroup.sync();
const history = await bobGroup.messages({ limit: 20 });
log("sync", `bob sees ${history.length} message(s) in group history`);

const msg2 = "Hey Alice! Received your message. A2A group messaging works perfectly!";
log("bob→     ", `sending: "${msg2}"`);
await bobGroup.send(encodeText(msg2));
log("bob→     ", "reply sent, waiting for alice to receive...");

// ── 7. 等待双方收到消息 ───────────────────────────────────────────────

await sleep(3000);

separator("Phase 7 · Demo complete");

log("done", "all messages exchanged.");
log("done", "streams still active — send messages from xmtp.chat to test live:");
log("done", `  alice: ${aliceXmtp.address}`);
log("done", `  bob  : ${bobXmtp.address}`);
log("done", "Ctrl+C to stop.");
