/**
 * Sensitive Word Guard Demo
 *
 * 角色：
 *   alice — 运行敏感词门禁 middleware 的 agent（接收并自动回复）
 *   bob   — 普通用户，发送消息，观察 alice 的回复
 *
 * 场景：
 *   1. bob 发送正常消息 → alice 的门禁 PASSED → alice sendTextReply 打招呼
 *   2. bob 发送含敏感词的消息 → alice 的门禁 BLOCKED → alice sendTextReply 警告
 */
import { hexToBytes } from "viem";
import { encodeText } from "@xmtp/node-sdk";
import { TestOnChainOSClient } from "../../test/helpers/test-onchainos.js";
import { XmtpClient } from "../domains/xmtp/xmtp.js";
import { SensitiveWordGuard } from "../domains/security/sensitive-word-guard.js";
import { loggingMiddleware } from "../domains/xmtp/middleware/logging.js";
import { loadTestWallet } from "../../scripts/helpers/wallet.js";

// ── 工具 ─────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

function log(tag: string, ...args: unknown[]) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [${tag.padEnd(12)}]`, ...args);
}

function separator(title: string) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${title}`);
  console.log(`${"─".repeat(60)}`);
}

// ── 1. 加载钱包 & 连接 ───────────────────────────────────────────────

separator("Phase 1 · Connect alice & bob");

const bobWallet = loadTestWallet("bob");

const aliceXmtp = new XmtpClient(new TestOnChainOSClient("alice"), {
  env: "dev",
  dbDir: "data/alice",
});

const bobXmtp = new XmtpClient(new TestOnChainOSClient("bob"), {
  env: "dev",
  dbDir: "data/bob",
  dbEncryptionKey: hexToBytes(bobWallet.dbEncryptionKey),
});

log("connect", "connecting alice...");
await aliceXmtp.connect();
log("connect", `alice OK | inboxId: ${aliceXmtp.agent.client.inboxId.slice(0, 16)}…`);

log("connect", "connecting bob...");
await bobXmtp.connect();
log("connect", `bob   OK | inboxId: ${bobXmtp.agent.client.inboxId.slice(0, 16)}…`);

// ── 2. 注册 alice 的 Middleware ──────────────────────────────────────

separator("Phase 2 · Register alice middleware");

const aliceAgent = aliceXmtp.agent;
const bobAgent   = bobXmtp.agent;

const guard = new SensitiveWordGuard();
// 顺序：loggingMiddleware 先打日志，再由 guard 决定是否拦截
aliceAgent.use(loggingMiddleware);
aliceAgent.use(guard.middleware());

log("middleware", "alice: loggingMiddleware + SensitiveWordGuard registered");
log("middleware", "  sensitive words: ['sb', '傻逼']");

// ── 3. Bob 注册消息监听（看 alice 的回复）────────────────────────────

separator("Phase 3 · Bob listens for alice's replies");

bobAgent.on("message", (ctx) => {
  const text =
    typeof ctx.message.content === "string"
      ? ctx.message.content
      : "[non-text]";
  // 只打印 alice 发来的消息（跳过 bob 自己发的回显，理论上不会有）
  if (ctx.message.senderInboxId === aliceAgent.client.inboxId) {
    log("bob←alice ", `"${text}"`);
  }
});

log("stream", "starting alice agent.start()...");
aliceAgent.start().catch((e: unknown) => log("error", "alice stream:", e));

log("stream", "starting bob agent.start()...");
bobAgent.start().catch((e: unknown) => log("error", "bob stream:", e));

log("stream", "waiting for streams to settle...");
await sleep(2000);

// ── 4. Alice 创建 Group ──────────────────────────────────────────────

separator("Phase 4 · Alice creates group with bob");

const group = await aliceAgent.createGroupWithAddresses(
  [bobWallet.address as `0x${string}`],
  {
    groupName: "sensitive-word-guard-demo",
    groupDescription: "Demo: Alice bot with SensitiveWordGuard middleware",
  }
);

const members = await group.members();
log("group", `id=${group.id}`);
log("group", `name=${group.name}`);
log("group", `members: ${members.length} (alice + bob)`);

// bob 同步获取 group
await sleep(1000);
await bobAgent.client.conversations.sync();
const bobGroups = await bobAgent.client.conversations.listGroups();
const bobGroup = bobGroups.find((g) => g.id === group.id);
if (!bobGroup) {
  log("error", "bob cannot find group after sync");
  process.exit(1);
}
await bobGroup.sync();
log("group", "bob has synced the group");

// ── 5. 场景 A：正常消息（应通过门禁，alice 回打招呼）────────────────

separator("Phase 5 · Scenario A — clean message (PASSED)");

const cleanMsg = "你好 alice！今天天气不错。";
log("bob→group ", `sending: "${cleanMsg}"`);
await bobGroup.send(encodeText(cleanMsg));
log("bob→group ", "sent, waiting for alice guard to respond...");

await sleep(4000);

// ── 6. 场景 B：敏感消息（应被拦截，alice 回警告）────────────────────

separator("Phase 6 · Scenario B — sensitive message (BLOCKED)");

const sensitiveMsg = "你这个 sb，傻逼！";
log("bob→group ", `sending: "${sensitiveMsg}"`);
await bobGroup.send(encodeText(sensitiveMsg));
log("bob→group ", "sent, waiting for alice guard to block and warn...");

await sleep(4000);

// ── 7. 结束 ──────────────────────────────────────────────────────────

separator("Phase 7 · Done");

log("done", "demo complete. streams still active (Ctrl+C to stop).");
log("done", `alice: ${aliceXmtp.address}`);
log("done", `bob  : ${bobXmtp.address}`);
