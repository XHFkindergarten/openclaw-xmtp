/**
 * Local integration test — two XMTP agents chat with each other.
 *
 * No OpenClaw required. The test script acts as the orchestrator:
 *   1. Create two isolated agent directories (agent_a, agent_b)
 *   2. Generate unique XMTP wallet keys for each
 *   3. Start both agents on different HTTP ports
 *   4. Agent A sends a message to Agent B
 *   5. Poll Agent B's inbox until the message arrives
 *   6. Agent B replies to Agent A
 *   7. Poll Agent A's inbox until the reply arrives
 *   8. Test output filtering (message with sensitive data should be blocked)
 *   9. Clean up both agents
 *
 * Usage:
 *   npx tsx scripts/test-local.ts
 *   npx tsx scripts/test-local.ts --debug    # verbose output
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

const PROJECT_ROOT = join(import.meta.dirname, "..");
const TMP_ROOT = join(PROJECT_ROOT, ".test-tmp");
const PORT_A = 18850;
const PORT_B = 18851;
const DEBUG = process.argv.includes("--debug");

let passed = 0;
let failed = 0;

function ok(label: string): void {
  passed++;
  console.log(`  ✅ ${label}`);
}

function fail(label: string, detail?: string): void {
  failed++;
  console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
}

function log(msg: string): void {
  if (DEBUG) {
    console.log(`  [debug] ${msg}`);
  }
}

function generateEnv(): string {
  const walletKey = "0x" + randomBytes(32).toString("hex");
  const encryptionKey = "0x" + randomBytes(32).toString("hex");
  return `XMTP_WALLET_KEY=${walletKey}\nXMTP_DB_ENCRYPTION_KEY=${encryptionKey}\nXMTP_ENV=dev\n`;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    return setTimeout(resolve, ms);
  });
}

async function httpJson(port: number, method: string, path: string, body?: Record<string, unknown>): Promise<unknown> {
  const url = `http://127.0.0.1:${port}${path}`;
  const opts: RequestInit = { method, headers: { "Content-Type": "application/json" } };
  if (body) { opts.body = JSON.stringify(body); }
  const res = await fetch(url, opts);
  return res.json();
}

async function waitForAgent(port: number, label: string, timeoutMs = 30000): Promise<Record<string, unknown>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const status = (await httpJson(port, "GET", "/status")) as Record<string, unknown>;
      if (status.running) { return status; }
    } catch { /* not ready */ }
    await sleep(1000);
  }
  throw new Error(`${label} did not start within ${timeoutMs / 1000}s`);
}

async function pollInbox(
  port: number,
  predicate: (msgs: Array<Record<string, unknown>>) => boolean,
  timeoutMs = 30000,
): Promise<Array<Record<string, unknown>>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const msgs = (await httpJson(port, "GET", "/inbox")) as Array<Record<string, unknown>>;
      if (predicate(msgs)) { return msgs; }
    } catch { /* not ready */ }
    await sleep(2000);
  }
  throw new Error(`Inbox condition not met within ${timeoutMs / 1000}s`);
}

function startAgentProcess(baseDir: string, port: number, label: string): ChildProcess {
  const agentScript = join(PROJECT_ROOT, "src", "agent.ts");
  const logArgs = DEBUG ? ["--debug"] : [];
  const child = spawn("npx", ["tsx", agentScript, ...logArgs], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      XMTP_BASE_DIR: baseDir,
      XMTP_HTTP_PORT: String(port),
      XMTP_NO_WS: "1",
      PATH: process.env.PATH,
    },
    stdio: DEBUG ? "inherit" : "ignore",
  });
  child.on("error", (err) => { console.error(`  [${label}] process error:`, err); });
  return child;
}

async function stopAgent(port: number): Promise<void> {
  try { await httpJson(port, "POST", "/stop"); } catch { /* already dead */ }
}

async function run(): Promise<void> {
  console.log("\n🧪 XMTP Expert Network — Local Integration Test\n");
  console.log("📁 Setting up test environment...");

  if (existsSync(TMP_ROOT)) { rmSync(TMP_ROOT, { recursive: true }); }

  const dirA = join(TMP_ROOT, "agent_a");
  const dirB = join(TMP_ROOT, "agent_b");
  mkdirSync(join(dirA, "data"), { recursive: true });
  mkdirSync(join(dirB, "data"), { recursive: true });

  writeFileSync(join(dirA, ".env"), generateEnv());
  writeFileSync(join(dirB, ".env"), generateEnv());
  writeFileSync(join(dirB, "knowledge.md"), "# 专家领域：TypeScript\n\n## 核心知识\n\n### 类型系统\n- 泛型编程\n- 条件类型\n");

  let childA: ChildProcess | null = null;
  let childB: ChildProcess | null = null;

  try {
    console.log("\n🚀 Starting agents...");
    childA = startAgentProcess(dirA, PORT_A, "Agent A");
    childB = startAgentProcess(dirB, PORT_B, "Agent B");

    log("Waiting for Agent A...");
    const statusA = await waitForAgent(PORT_A, "Agent A");
    ok(`Agent A online — address: ${statusA.address}`);

    log("Waiting for Agent B...");
    const statusB = await waitForAgent(PORT_B, "Agent B");
    ok(`Agent B online — address: ${statusB.address}`);

    const addrA = statusA.address as string;
    const addrB = statusB.address as string;

    // Test 1: A sends message to B
    console.log("\n📨 Test 1: Agent A sends message to Agent B");
    const sendResult = (await httpJson(PORT_A, "POST", "/send", {
      to: addrB, msg: "Hello from Agent A! What do you know about TypeScript generics?",
    })) as Record<string, unknown>;
    if (sendResult.ok) { ok(`Message sent (convId: ${String(sendResult.conversationId).slice(0, 8)}...)`); }
    else { fail("Message send failed", String(sendResult.error)); }

    // Test 2: B receives message from A
    console.log("\n📬 Test 2: Agent B receives message from Agent A");
    try {
      const msgs = await pollInbox(PORT_B, (msgs) => { return msgs.some((m) => { return String(m.content).includes("Hello from Agent A"); }); });
      const received = msgs.find((m) => { return String(m.content).includes("Hello from Agent A"); })!;
      ok(`Message received — from: ${String(received.from).slice(0, 12)}...`);
    } catch (err) { fail("Message not received in inbox within timeout", String(err)); }

    // Test 3: B replies to A
    console.log("\n💬 Test 3: Agent B replies to Agent A");
    const replyResult = (await httpJson(PORT_B, "POST", "/send", {
      to: addrA, msg: "Hi! I'm a TypeScript expert. Generics allow you to write reusable, type-safe code.",
    })) as Record<string, unknown>;
    if (replyResult.ok) { ok("Reply sent"); }
    else { fail("Reply send failed", String(replyResult.error)); }

    // Test 4: A receives reply from B
    console.log("\n📬 Test 4: Agent A receives reply from Agent B");
    try {
      const msgs = await pollInbox(PORT_A, (msgs) => { return msgs.some((m) => { return String(m.content).includes("TypeScript expert"); }); });
      const received = msgs.find((m) => { return String(m.content).includes("TypeScript expert"); })!;
      ok(`Reply received — from: ${String(received.from).slice(0, 12)}...`);
    } catch (err) { fail("Reply not received within timeout", String(err)); }

    // Test 5: Output filtering
    console.log("\n🛡️  Test 5: Output filtering blocks sensitive data");
    const blockedResult = (await httpJson(PORT_A, "POST", "/send", {
      to: addrB, msg: "My secret key is /Users/oker/.ssh/id_rsa and also sk-1234567890abcdefghijklmn",
    })) as Record<string, unknown>;
    if (!blockedResult.ok && String(blockedResult.error).includes("sensitive")) { ok("Sensitive message correctly blocked"); }
    else { fail("Sensitive message was NOT blocked"); }

    // Test 6: knowledge.md empty state
    console.log("\n📋 Test 6: knowledge.md empty state detection");
    const statusAFinal = (await httpJson(PORT_A, "GET", "/status")) as Record<string, unknown>;
    const statusBFinal = (await httpJson(PORT_B, "GET", "/status")) as Record<string, unknown>;
    if (statusAFinal.knowledgeEmpty === true) { ok("Agent A correctly reports knowledgeEmpty=true (no knowledge.md)"); }
    else { fail("Agent A should report knowledgeEmpty=true"); }
    if (statusBFinal.knowledgeEmpty === false) { ok("Agent B correctly reports knowledgeEmpty=false (has knowledge)"); }
    else { fail("Agent B should report knowledgeEmpty=false"); }

  } finally {
    console.log("\n🧹 Cleaning up...");
    await stopAgent(PORT_A).catch(() => {});
    await stopAgent(PORT_B).catch(() => {});
    await sleep(2000);
    if (childA && !childA.killed) { childA.kill("SIGKILL"); }
    if (childB && !childB.killed) { childB.kill("SIGKILL"); }
    try { rmSync(TMP_ROOT, { recursive: true }); } catch { /* non-fatal */ }
  }

  console.log("\n" + "═".repeat(50));
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log("═".repeat(50) + "\n");
  if (failed > 0) { process.exit(1); }
}

run().catch((err) => { console.error("Test runner crashed:", err); process.exit(1); });
