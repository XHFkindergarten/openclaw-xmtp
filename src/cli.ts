#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_BASE_DIR = join(homedir(), ".openclaw", "state", "openclaw-xmtp", "runtime");
const BASE_DIR = process.env.XMTP_BASE_DIR ?? DEFAULT_BASE_DIR;
const DATA_DIR = join(BASE_DIR, "data");
const PID_FILE = join(DATA_DIR, "agent.json");
const ENV_FILE = join(BASE_DIR, ".env");
const KNOWLEDGE_FILE = join(BASE_DIR, "knowledge.md");
const CLI_FILE = fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(dirname(CLI_FILE), "..");
const OPENCLAW_CONFIG_FILE = join(homedir(), ".openclaw", "openclaw.json");

const KNOWLEDGE_TEMPLATE = `# 专家领域：[请填写你的专业领域]

## 核心知识

### [主题 1]
- [知识点 1]
- [知识点 2]

### [主题 2]
- [知识点 1]
- [知识点 2]

## 边界声明
以上是我愿意分享的全部知识范围。对于超出此范围的问题，
请回复"这超出了我的专业范围，建议你咨询其他专家"。
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getAgentInfo(): { pid: number; port: number; address: string } | null {
  try {
    if (!existsSync(PID_FILE)) {
      return null;
    }
    const info = JSON.parse(readFileSync(PID_FILE, "utf-8"));
    // Check if process is still alive
    try {
      process.kill(info.pid, 0);
      return info;
    } catch {
      // Process is dead, clean up stale PID file
      unlinkSync(PID_FILE);
      return null;
    }
  } catch {
    return null;
  }
}

async function httpCall(
  port: number,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const url = `http://127.0.0.1:${port}${path}`;
  const options: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body) {
    options.body = JSON.stringify(body);
  }

  const res = await fetch(url, options);
  return res.json();
}

function isJsonMode(): boolean {
  return process.argv.includes("--json");
}

function output(data: unknown): void {
  if (isJsonMode()) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    if (typeof data === "string") {
      console.log(data);
    } else {
      console.log(JSON.stringify(data, null, 2));
    }
  }
}

function commandExists(command: string): boolean {
  const result = spawnSync(command, ["--version"], {
    stdio: "ignore",
    shell: false,
  });
  if (!result.error) {
    return true;
  }
  const errorCode = (result.error as NodeJS.ErrnoException).code;
  return errorCode !== "ENOENT";
}

function readNodeMajorVersion(): number {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  return Number.isFinite(major) ? major : 0;
}

function parseEnvFile(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const index = trimmed.indexOf("=");
    if (index === -1) {
      continue;
    }
    result[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
  }
  return result;
}

function buildChatUrlFromEnvFile(): { address?: string; chatUrl?: string; env?: string } {
  if (!existsSync(ENV_FILE)) {
    return {};
  }
  const parsed = parseEnvFile(readFileSync(ENV_FILE, "utf-8"));
  const walletKey = parsed.XMTP_WALLET_KEY;
  const env = parsed.XMTP_ENV ?? "dev";
  if (!walletKey || !/^0x[a-fA-F0-9]{64}$/.test(walletKey)) {
    return { env };
  }
  const address = privateKeyToAccount(walletKey as `0x${string}`).address;
  return {
    address,
    env,
    chatUrl: `https://xmtp.chat/${env}/dm/${address}`,
  };
}

function repairOpenClawPluginConfig(): {
  changed: boolean;
  path: string;
  removed: string[];
} {
  if (!existsSync(OPENCLAW_CONFIG_FILE)) {
    return {
      changed: false,
      path: OPENCLAW_CONFIG_FILE,
      removed: [],
    };
  }

  const raw = readFileSync(OPENCLAW_CONFIG_FILE, "utf-8");
  const parsed = JSON.parse(raw) as Record<string, any>;
  const removed: string[] = [];

  if (Array.isArray(parsed.plugins?.allow)) {
    const nextAllow = parsed.plugins.allow.filter((entry: string) => entry !== "openclaw-xmtp");
    if (nextAllow.length !== parsed.plugins.allow.length) {
      parsed.plugins.allow = nextAllow;
      removed.push("plugins.allow[openclaw-xmtp]");
    }
  }

  if (parsed.plugins?.entries?.["openclaw-xmtp"]) {
    delete parsed.plugins.entries["openclaw-xmtp"];
    removed.push("plugins.entries.openclaw-xmtp");
  }

  if (parsed.plugins?.installs?.["openclaw-xmtp"]) {
    delete parsed.plugins.installs["openclaw-xmtp"];
    removed.push("plugins.installs.openclaw-xmtp");
  }

  if (removed.length > 0) {
    writeFileSync(OPENCLAW_CONFIG_FILE, JSON.stringify(parsed, null, 2) + "\n");
  }

  return {
    changed: removed.length > 0,
    path: OPENCLAW_CONFIG_FILE,
    removed,
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdInit(): Promise<void> {
  if (!existsSync(BASE_DIR)) {
    mkdirSync(BASE_DIR, { recursive: true });
  }

  // Generate XMTP keys
  if (!existsSync(ENV_FILE)) {
    const walletKey = "0x" + randomBytes(32).toString("hex");
    const encryptionKey = "0x" + randomBytes(32).toString("hex");
    const envContent = `XMTP_WALLET_KEY=${walletKey}\nXMTP_DB_ENCRYPTION_KEY=${encryptionKey}\nXMTP_ENV=dev\n`;
    writeFileSync(ENV_FILE, envContent);
    console.log("✓ Generated .env with XMTP wallet and encryption keys");
  } else {
    console.log("✓ .env already exists, skipping key generation");
  }

  // Create knowledge.md template
  if (!existsSync(KNOWLEDGE_FILE)) {
    writeFileSync(KNOWLEDGE_FILE, KNOWLEDGE_TEMPLATE);
    console.log("✓ Created knowledge.md template — please edit it with your expert knowledge");
  } else {
    console.log("✓ knowledge.md already exists");
  }

  // Create data directory
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
    console.log("✓ Created data/ directory");
  }

  // Install dependencies if needed
  if (!existsSync(join(PROJECT_ROOT, "node_modules"))) {
    console.log("⏳ Installing dependencies...");
    const result = spawnSync("npm", ["install"], { stdio: "inherit", cwd: PROJECT_ROOT });
    if (result.status !== 0) {
      throw new Error("npm install failed during initialization");
    }
  }

  console.log("\n🎉 Initialization complete!");
  console.log("Next steps:");
  console.log("  1. Install the OpenClaw plugin so Gateway can own the XMTP lifecycle");
  console.log("  2. Run: npx tsx src/cli.ts status --json");
  console.log("  3. Optional dev-only path: run xmtp-agent start for standalone debugging");
}

async function cmdPreflight(): Promise<void> {
  const nodeMajor = readNodeMajorVersion();
  const hasNode = typeof process.versions.node === "string";
  const hasNpm = commandExists("npm");
  const hasNpx = commandExists("npx");
  const hasOpenClaw = commandExists("openclaw");
  const hasNodeModules = existsSync(join(PROJECT_ROOT, "node_modules"));
  const hasEnv = existsSync(ENV_FILE);
  const hasKnowledge = existsSync(KNOWLEDGE_FILE);
  const agentInfo = getAgentInfo();

  const checks = {
    node: {
      ok: hasNode && nodeMajor >= 22,
      found: hasNode,
      version: process.versions.node,
      required: ">=22",
    },
    npm: {
      ok: hasNpm,
      found: hasNpm,
    },
    npx: {
      ok: hasNpx,
      found: hasNpx,
    },
    openclaw: {
      ok: hasOpenClaw,
      found: hasOpenClaw,
      optional: true,
    },
    dependencies: {
      ok: hasNodeModules,
      installed: hasNodeModules,
    },
    envFile: {
      ok: hasEnv,
      present: hasEnv,
      path: ENV_FILE,
    },
    knowledgeFile: {
      ok: hasKnowledge,
      present: hasKnowledge,
      path: KNOWLEDGE_FILE,
    },
    agent: {
      running: Boolean(agentInfo),
      pid: agentInfo?.pid ?? null,
      port: agentInfo?.port ?? null,
      address: agentInfo?.address ?? null,
    },
  };

  const blockers: string[] = [];
  if (!checks.node.ok) {
    blockers.push(`Node.js ${checks.node.required} is required (current: ${checks.node.version ?? "missing"})`);
  }
  if (!checks.npm.ok) {
    blockers.push("npm is required");
  }
  if (!checks.npx.ok) {
    blockers.push("npx is required");
  }

  const nextSteps: string[] = [];
  if (!checks.dependencies.ok) {
    nextSteps.push("Run: npm install");
  }
  if (!checks.envFile.ok || !checks.knowledgeFile.ok) {
    nextSteps.push("Run: npx tsx src/cli.ts init");
  }
  if (checks.openclaw.ok && checks.envFile.ok) {
    nextSteps.push(`Install the plugin: openclaw plugins install ${PROJECT_ROOT} && openclaw gateway restart`);
  }
  if (!checks.agent.running && checks.node.ok && checks.npm.ok && checks.npx.ok) {
    nextSteps.push("Optional dev-only: npx tsx src/cli.ts start");
  }
  if (!checks.openclaw.ok) {
    nextSteps.push("Install OpenClaw if you want automatic XMTP replies inside OpenClaw");
  }

  output({
    ok: blockers.length === 0,
    baseDir: BASE_DIR,
    checks,
    blockers,
    nextSteps,
  });
}

async function cmdRepairOpenClawConfig(): Promise<void> {
  const result = repairOpenClawPluginConfig();
  output({
    ok: true,
    changed: result.changed,
    path: result.path,
    removed: result.removed,
  });
  if (!isJsonMode()) {
    if (result.changed) {
      console.log(`Repaired stale openclaw-xmtp plugin records in ${result.path}`);
    } else {
      console.log(`No stale openclaw-xmtp plugin records found in ${result.path}`);
    }
  }
}

async function cmdStart(): Promise<void> {
  const existing = getAgentInfo();
  if (existing) {
    console.error(`Agent is already running (PID: ${existing.pid}, port: ${existing.port})`);
    process.exit(1);
  }

  console.log("Starting XMTP agent...");

  // Spawn agent as detached background process
  const agentScript = join(PROJECT_ROOT, "src", "agent.ts");
  const child = spawn("npx", ["tsx", agentScript, ...process.argv.slice(3)], {
    detached: true,
    stdio: "ignore",
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      XMTP_BASE_DIR: BASE_DIR,
      XMTP_HTTP_PORT: process.env.XMTP_HTTP_PORT ?? "18790",
    },
  });

  child.unref();

  // Wait for PID file to appear (agent writes it on startup)
  const maxWait = 15000; // 15 seconds
  const startMs = Date.now();
  let info = null;

  while (Date.now() - startMs < maxWait) {
    await new Promise((r) => {
      return setTimeout(r, 500);
    });
    info = getAgentInfo();
    if (info) {
      break;
    }
  }

  if (info) {
    console.log(`✓ Agent started`);
    console.log(`  PID:     ${info.pid}`);
    console.log(`  Address: ${info.address}`);
    console.log(`  HTTP:    http://127.0.0.1:${info.port}`);
    output({ ok: true, pid: info.pid, address: info.address, port: info.port });
  } else {
    console.error("✗ Agent failed to start within 15 seconds");
    console.error("  Check logs with: xmtp-agent start --debug");
    process.exit(1);
  }
}

async function cmdStop(): Promise<void> {
  const info = getAgentInfo();
  if (!info) {
    console.log("Agent is not running");
    return;
  }

  try {
    await httpCall(info.port, "POST", "/stop");
    console.log("✓ Agent stopped");
    output({ ok: true });
  } catch {
    // If HTTP fails, kill the process directly
    try {
      process.kill(info.pid, "SIGTERM");
      console.log("✓ Agent stopped (via signal)");
      output({ ok: true });
    } catch {
      console.error("✗ Failed to stop agent");
      process.exit(1);
    }
  }
}

async function cmdSend(): Promise<void> {
  const info = getAgentInfo();
  if (!info) {
    console.error("Agent is not running. Start it with: xmtp-agent start");
    process.exit(1);
  }

  const toIndex = process.argv.indexOf("--to");
  const msgIndex = process.argv.indexOf("--msg");

  if (toIndex === -1 || msgIndex === -1) {
    console.error("Usage: xmtp-agent send --to <address> --msg \"<message>\"");
    process.exit(1);
  }

  const to = process.argv[toIndex + 1];
  const msg = process.argv[msgIndex + 1];

  if (!to || !msg) {
    console.error("Usage: xmtp-agent send --to <address> --msg \"<message>\"");
    process.exit(1);
  }

  const result = await httpCall(info.port, "POST", "/send", { to, msg });
  output(result);
}

async function cmdInbox(): Promise<void> {
  const info = getAgentInfo();
  if (!info) {
    console.error("Agent is not running. Start it with: xmtp-agent start");
    process.exit(1);
  }

  const params = new URLSearchParams();

  const sinceIndex = process.argv.indexOf("--since");
  if (sinceIndex !== -1 && process.argv[sinceIndex + 1]) {
    params.set("since", process.argv[sinceIndex + 1]);
  }

  const fromIndex = process.argv.indexOf("--from");
  if (fromIndex !== -1 && process.argv[fromIndex + 1]) {
    params.set("from", process.argv[fromIndex + 1]);
  }

  const query = params.toString();
  const path = query ? `/inbox?${query}` : "/inbox";
  const result = await httpCall(info.port, "GET", path);
  output(result);
}

async function cmdStatus(): Promise<void> {
  const info = getAgentInfo();
  const identity = buildChatUrlFromEnvFile();
  if (!info) {
    output({
      running: false,
      configured: existsSync(ENV_FILE),
      baseDir: BASE_DIR,
      address: identity.address ?? null,
      env: identity.env ?? null,
      chatUrl: identity.chatUrl ?? null,
    });
    if (!isJsonMode()) {
      console.log("Standalone XMTP agent is not running");
    }
    return;
  }

  try {
    const result = await httpCall(info.port, "GET", "/status");
    output({
      ...(result as Record<string, unknown>),
      configured: existsSync(ENV_FILE),
      baseDir: BASE_DIR,
      chatUrl: identity.chatUrl ?? (result as Record<string, unknown>).chatUrl ?? null,
      address: identity.address ?? (result as Record<string, unknown>).address ?? null,
      env: identity.env ?? (result as Record<string, unknown>).env ?? null,
    });
  } catch {
    output({
      running: false,
      stale: true,
      pid: info.pid,
      configured: existsSync(ENV_FILE),
      baseDir: BASE_DIR,
      address: identity.address ?? null,
      env: identity.env ?? null,
      chatUrl: identity.chatUrl ?? null,
    });
    if (!isJsonMode()) {
      console.log("Standalone XMTP agent process exists but is not responding");
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const command = process.argv[2];

const commands: Record<string, () => Promise<void>> = {
  preflight: cmdPreflight,
  init: cmdInit,
  start: cmdStart,
  stop: cmdStop,
  send: cmdSend,
  inbox: cmdInbox,
  status: cmdStatus,
  "repair-openclaw-config": cmdRepairOpenClawConfig,
};

if (!command || !commands[command]) {
  console.log(`XMTP Expert Network - Agent CLI

Usage: xmtp-agent <command> [options]

Commands:
  preflight  Check local prerequisites and project readiness
  init       Initialize project (generate keys + knowledge.md template)
  start      Start XMTP agent background process
  stop       Stop the running agent
  send       Send a message via XMTP
  inbox      View received messages
  status     Check agent status
  repair-openclaw-config  Remove stale openclaw-xmtp plugin records from ~/.openclaw/openclaw.json

Options:
  --json     Machine-readable JSON output
  --debug    Enable detailed logging (for start command)

Examples:
  xmtp-agent preflight --json
  xmtp-agent init
  xmtp-agent start
  xmtp-agent send --to 0xABC... --msg "Hello"
  xmtp-agent inbox --since 1711234567890 --json
  xmtp-agent status --json
  xmtp-agent repair-openclaw-config --json
`);
  process.exit(command ? 1 : 0);
}

commands[command]().catch((err) => {
  console.error(`Error: ${err.message ?? err}`);
  process.exit(1);
});
