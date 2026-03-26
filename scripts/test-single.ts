/**
 * Single-agent test — start one XMTP agent and use the web chat to test.
 *
 * This script:
 *   1. Starts the XMTP agent on the default port
 *   2. Prints the XMTP web chat URL
 *   3. You open that URL in a browser, manually send messages
 *   4. The script polls inbox every 3 seconds and prints new messages
 *   5. Press Ctrl+C to stop
 *
 * Usage:
 *   npx tsx scripts/test-single.ts
 *   npx tsx scripts/test-single.ts --debug
 */

import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

const PROJECT_ROOT = join(import.meta.dirname, "..");
const PORT = parseInt(process.env.XMTP_HTTP_PORT ?? "18790", 10);
const DEBUG = process.argv.includes("--debug");

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    return setTimeout(resolve, ms);
  });
}

async function httpJson(method: string, path: string): Promise<unknown> {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
  });
  return res.json();
}

async function waitForAgent(): Promise<Record<string, unknown>> {
  const start = Date.now();
  while (Date.now() - start < 30000) {
    try {
      const status = (await httpJson("GET", "/status")) as Record<string, unknown>;
      if (status.running) { return status; }
    } catch { /* not ready */ }
    await sleep(1000);
  }
  throw new Error("Agent did not start within 30s");
}

async function run(): Promise<void> {
  console.log("\n🧪 XMTP Single-Agent Test\n");
  console.log("🚀 Starting XMTP agent...");

  const agentScript = join(PROJECT_ROOT, "src", "agent.ts");
  const logArgs = DEBUG ? ["--debug"] : [];
  const child: ChildProcess = spawn("npx", ["tsx", agentScript, ...logArgs], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      XMTP_BASE_DIR: PROJECT_ROOT,
      XMTP_HTTP_PORT: String(PORT),
      XMTP_NO_WS: "1",
      PATH: process.env.PATH,
    },
    stdio: DEBUG ? "inherit" : "ignore",
  });

  const cleanup = async (): Promise<void> => {
    console.log("\n\n🧹 Stopping agent...");
    try { await httpJson("POST", "/stop"); } catch { /* ignore */ }
    await sleep(1000);
    if (!child.killed) { child.kill("SIGKILL"); }
    process.exit(0);
  };

  process.on("SIGINT", () => { cleanup(); });
  process.on("SIGTERM", () => { cleanup(); });

  try {
    const status = await waitForAgent();
    console.log(`\n✅ Agent online!`);
    console.log(`   Address:  ${status.address}`);
    console.log(`   HTTP:     http://127.0.0.1:${PORT}`);
    console.log(`   Chat URL: ${status.chatUrl}`);
    console.log(`\n📋 Open the Chat URL in your browser and send a message.`);
    console.log(`   This script will print incoming messages below.\n`);
    console.log(`   Press Ctrl+C to stop.\n`);
    console.log("─".repeat(60));

    const seenIds = new Set<string>();
    while (true) {
      try {
        const msgs = (await httpJson("GET", "/inbox")) as Array<Record<string, unknown>>;
        for (const m of msgs) {
          const id = `${m.conversationId}-${m.timestamp}`;
          if (!seenIds.has(id)) {
            seenIds.add(id);
            const ts = new Date(m.timestamp as number).toLocaleTimeString();
            console.log(`\n📨 [${ts}] from: ${String(m.from).slice(0, 16)}...`);
            console.log(`   "${m.content}"`);
            console.log(`   knowledgeEmpty: ${m.knowledgeEmpty}`);
          }
        }
      } catch { /* agent might be restarting */ }
      await sleep(3000);
    }
  } catch (err) {
    console.error("❌ Error:", err);
    await cleanup();
  }
}

run().catch((err) => { console.error("Test runner crashed:", err); process.exit(1); });
