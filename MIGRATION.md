# XMTP Expert Network — 项目迁移文档

> **目标读者**：另一台电脑上的 Claude Code / OpenClaw 会话。
> 请按照本文档的指引，从零重建整个项目。完成后阅读 HANDOFF.md 开展测试。
> 本文件保留了迁移期的开发示例与环境说明，不作为发布后的标准安装文档。发布与初始化请以 `OPENCLAW_INIT.md`、`SKILL.md`、`README.md` 为准。

---

## 一、项目背景与目标

这是一个 **XMTP Agent-to-Agent 专家知识交换 Demo**。

**核心想法**：每个人的 AI 助手（OpenClaw，用户称之为"龙虾"）通过 XMTP 去中心化消息网络互相通信。每个龙虾对外暴露一个受 `knowledge.md` 限制的专家人格。用户可以派自己的龙虾去问别人的龙虾问题，龙虾自动聊完后把答案整理转述给用户。

**架构核心原则**：
- XMTP agent 进程 = **纯消息管道**，不调用任何 AI Model Provider
- OpenClaw = **大脑**，读取 knowledge.md，决定回复内容
- 通信方式：OpenClaw 通过 CLI 命令（底层 HTTP）与 XMTP agent 交互
- agent 收到新消息时尝试 WebSocket 推送给 OpenClaw Gateway，不可用则静默降级

## 二、参考资料

以下链接在实现中被参考过，遇到问题时可以查阅：

- **XMTP Agent SDK 文档**：https://docs.xmtp.org/llms/llms-agents.txt
- **XMTP Agent 开发指南**：https://docs.xmtp.org/agents/get-started/build-an-agent
- **XMTP 网页端测试工具**：https://xmtp.chat （用于手动发消息给 agent 测试）
- **OpenClaw GitHub**：https://github.com/openclaw/openclaw
- **OpenClaw 文档**：https://docs.openclaw.ai
- **OpenClaw Multi-Agent Routing**：https://docs.openclaw.ai/concepts/multi-agent
- **Virtuals ACP OpenClaw 插件**（参考了它的 Skill 加载模式）：https://github.com/Virtual-Protocol/openclaw-acp

## 三、环境要求

- **Node.js** >= 22
- **npm**（随 Node.js 安装）
- 网络连接（需要连接 XMTP dev 网络）

## 四、项目重建步骤

### 步骤 1：创建项目目录并初始化

```bash
mkdir xmtp-expert-network && cd xmtp-expert-network
```

### 步骤 2：创建所有文件

按以下顺序创建文件。每个文件的完整内容都在下方提供。

---

### FILE: package.json

```json
{
  "name": "xmtp-expert-network",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "bin": {
    "xmtp-agent": "./node_modules/.bin/tsx src/cli.ts"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsx --watch src/agent.ts --debug",
    "start": "tsx src/agent.ts",
    "agent": "tsx src/cli.ts",
    "cli": "tsx src/cli.ts",
    "test": "tsx scripts/test-local.ts",
    "test:debug": "tsx scripts/test-local.ts --debug",
    "test:single": "tsx scripts/test-single.ts",
    "typecheck": "tsc"
  },
  "engines": {
    "node": ">=22"
  },
  "dependencies": {
    "@xmtp/agent-sdk": "^2.2.0",
    "dotenv": "^17.3.1",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/node": "^25.3.0",
    "@types/ws": "^8.18.0",
    "tsx": "^4.21.0",
    "typescript": "^5.9.3"
  }
}
```

### FILE: tsconfig.json

```json
{
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "target": "ESNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["**/*.ts"]
}
```

### FILE: .gitignore

```
node_modules
.env
*.db3*
*.sqlcipher_salt
data/
.test-tmp/
.test-build/
old_db_backup
dist
```

### FILE: src/logger.ts

```typescript
const DEBUG = process.argv.includes("--debug") || process.env.DEBUG === "1";

type Level = "INFO" | "DEBUG" | "ERROR";

function formatMsg(level: Level, msg: string): string {
  const ts = new Date().toISOString();
  return `[${ts}] [${level.padEnd(5)}] ${msg}`;
}

export function info(msg: string): void {
  console.log(formatMsg("INFO", msg));
}

export function debug(msg: string): void {
  if (DEBUG) {
    console.log(formatMsg("DEBUG", msg));
  }
}

export function error(msg: string, err?: unknown): void {
  console.error(formatMsg("ERROR", msg));
  if (err && DEBUG) {
    console.error(err);
  }
}
```

### FILE: src/agent.ts

```typescript
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { Agent, getTestUrl } from "@xmtp/agent-sdk";
import { WebSocket } from "ws";
import * as log from "./logger.js";

// ---------------------------------------------------------------------------
// Config — all paths derived from BASE_DIR (decoupled for multi-instance)
// ---------------------------------------------------------------------------

const BASE_DIR = resolve(process.env.XMTP_BASE_DIR ?? process.cwd());
const HTTP_PORT = parseInt(process.env.XMTP_HTTP_PORT ?? "18790", 10);
const DATA_DIR = join(BASE_DIR, "data");
const PID_FILE = join(DATA_DIR, "agent.json");
const AUDIT_FILE = join(DATA_DIR, "audit.jsonl");
const KNOWLEDGE_FILE = join(BASE_DIR, "knowledge.md");
const OPENCLAW_WS = process.env.OPENCLAW_WS ?? "ws://127.0.0.1:18789";

// Load .env from BASE_DIR manually (dotenv/config always loads from cwd)
import { config as loadEnv } from "dotenv";
loadEnv({ path: join(BASE_DIR, ".env") });

// Sensitive data patterns for output filtering
const SENSITIVE_PATTERNS = [
  /\/Users\/\w+/g,
  /\/home\/\w+/g,
  /XMTP_WALLET_KEY=\S+/g,
  /XMTP_DB_ENCRYPTION_KEY=\S+/g,
  /sk-[a-zA-Z0-9]{20,}/g,
  /0x[a-fA-F0-9]{64}/g,
];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let agent: Agent;
let wsClient: WebSocket | null = null;
const startTime = Date.now();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

function audit(entry: Record<string, unknown>): void {
  ensureDataDir();
  const line = JSON.stringify({ ...entry, ts: new Date().toISOString() });
  appendFileSync(AUDIT_FILE, line + "\n");
}

function isKnowledgeEmpty(): boolean {
  try {
    const content = readFileSync(KNOWLEDGE_FILE, "utf-8");
    return content.includes("[请填写你的专业领域]");
  } catch {
    return true;
  }
}

function containsSensitiveData(text: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString());
    });
    req.on("error", reject);
  });
}

function jsonResponse(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// WebSocket push to OpenClaw Gateway (graceful — never blocks)
// ---------------------------------------------------------------------------

let wsRetryTimer: ReturnType<typeof setTimeout> | null = null;

function connectWebSocket(): void {
  if (process.env.XMTP_NO_WS === "1") {
    return;
  }
  try {
    wsClient = new WebSocket(OPENCLAW_WS);
    wsClient.on("open", () => {
      log.info(`WebSocket connected to OpenClaw Gateway: ${OPENCLAW_WS}`);
    });
    wsClient.on("error", (err) => {
      log.debug(`WebSocket error (non-fatal): ${err.message}`);
      wsClient = null;
    });
    wsClient.on("close", () => {
      log.debug("WebSocket disconnected from OpenClaw Gateway");
      wsClient = null;
      wsRetryTimer = setTimeout(() => {
        connectWebSocket();
      }, 10000);
    });
  } catch (err) {
    log.debug(`WebSocket connection failed (non-fatal): ${err}`);
    wsClient = null;
  }
}

function pushToOpenClaw(payload: Record<string, unknown>): void {
  if (wsClient && wsClient.readyState === WebSocket.OPEN) {
    try {
      wsClient.send(JSON.stringify(payload));
      log.debug(`WebSocket push: ${payload.type} | conv=${payload.conversationId}`);
    } catch (err) {
      log.debug(`WebSocket push failed (non-fatal): ${err}`);
    }
  } else {
    log.debug("WebSocket not connected, message available via /inbox (fallback)");
  }
}

// ---------------------------------------------------------------------------
// HTTP API handlers
// ---------------------------------------------------------------------------

async function handleSend(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = JSON.parse(await readBody(req));
    const { to, msg } = body as { to: string; msg: string };

    if (!to || !msg) {
      jsonResponse(res, 400, { ok: false, error: "Missing 'to' or 'msg'" });
      return;
    }

    if (containsSensitiveData(msg)) {
      log.error(`Blocked outgoing message containing sensitive data | to=${to}`);
      audit({ type: "blocked_send", to, reason: "sensitive_data" });
      jsonResponse(res, 403, { ok: false, error: "Message blocked: contains sensitive data" });
      return;
    }

    const dm = await agent.createDmWithAddress(to as `0x${string}`);
    await dm.sendText(msg);
    const convId = dm.id;

    log.info(`Message sent | to=${to} | conv=${convId} | length=${msg.length}`);
    audit({ type: "sent", to, conversationId: convId, length: msg.length });

    jsonResponse(res, 200, { ok: true, conversationId: convId, timestamp: Date.now() });
  } catch (err) {
    log.error("Send failed", err);
    jsonResponse(res, 500, { ok: false, error: String(err) });
  }
}

async function handleInbox(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url ?? "/", `http://localhost:${HTTP_PORT}`);
    const since = url.searchParams.get("since");
    const from = url.searchParams.get("from");

    const conversations = await agent.client.conversations.list();
    const messages: Array<Record<string, unknown>> = [];

    for (const conv of conversations) {
      const convMessages = await conv.messages();
      for (const m of convMessages) {
        if (m.senderInboxId === agent.client.inboxId) {
          continue;
        }
        const ts = Number(m.sentAtNs) / 1_000_000;
        if (since && ts < Number(since)) {
          continue;
        }
        const senderAddress = m.senderInboxId;
        if (from && senderAddress !== from) {
          continue;
        }
        messages.push({
          from: senderAddress,
          content: m.content,
          conversationId: conv.id,
          timestamp: ts,
          knowledgeEmpty: isKnowledgeEmpty(),
        });
      }
    }

    messages.sort((a, b) => {
      return (b.timestamp as number) - (a.timestamp as number);
    });
    jsonResponse(res, 200, messages);
  } catch (err) {
    log.error("Inbox query failed", err);
    jsonResponse(res, 500, { ok: false, error: String(err) });
  }
}

function handleStatus(_req: IncomingMessage, res: ServerResponse): void {
  const uptime = Math.floor((Date.now() - startTime) / 1000);
  jsonResponse(res, 200, {
    running: true,
    address: agent.address,
    env: process.env.XMTP_ENV ?? "dev",
    uptime,
    knowledgeEmpty: isKnowledgeEmpty(),
    webSocketConnected: wsClient?.readyState === WebSocket.OPEN,
    chatUrl: getTestUrl(agent.client),
  });
}

async function handleStop(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  log.info("Stop requested via HTTP");
  jsonResponse(res, 200, { ok: true });
  await shutdown();
}

// ---------------------------------------------------------------------------
// HTTP Server
// ---------------------------------------------------------------------------

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${HTTP_PORT}`);
  const path = url.pathname;
  const method = req.method ?? "GET";

  log.debug(`HTTP ${method} ${path}`);

  try {
    if (method === "POST" && path === "/send") {
      await handleSend(req, res);
    } else if (method === "GET" && path === "/inbox") {
      await handleInbox(req, res);
    } else if (method === "GET" && path === "/status") {
      handleStatus(req, res);
    } else if (method === "POST" && path === "/stop") {
      await handleStop(req, res);
    } else {
      jsonResponse(res, 404, { error: "Not found" });
    }
  } catch (err) {
    log.error(`HTTP handler error: ${err}`);
    jsonResponse(res, 500, { error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// XMTP message handler
// ---------------------------------------------------------------------------

function onMessage(content: string, senderInboxId: string, conversationId: string): void {
  log.info(`Message received | from=${senderInboxId} | conv=${conversationId} | length=${content.length}`);
  log.debug(`Message content: "${content.slice(0, 200)}"`);

  audit({ type: "received", from: senderInboxId, conversationId, length: content.length });

  pushToOpenClaw({
    type: "new_message",
    from: senderInboxId,
    content,
    conversationId,
    timestamp: Date.now(),
    knowledgeEmpty: isKnowledgeEmpty(),
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

async function shutdown(): Promise<void> {
  const uptime = Math.floor((Date.now() - startTime) / 1000);
  log.info(`Agent stopping | uptime=${uptime}s`);

  if (wsRetryTimer) {
    clearTimeout(wsRetryTimer);
  }
  if (wsClient) {
    wsClient.close();
  }
  server.close();
  await agent.stop();

  try {
    unlinkSync(PID_FILE);
  } catch {
    // ignore
  }

  process.exit(0);
}

async function main(): Promise<void> {
  ensureDataDir();

  log.info(`Initializing XMTP agent | base=${BASE_DIR} | port=${HTTP_PORT}`);
  agent = await Agent.createFromEnv();

  agent.on("text", async (ctx) => {
    onMessage(
      String(ctx.message.content),
      ctx.message.senderInboxId,
      ctx.conversation.id,
    );
  });

  agent.on("start", () => {
    log.info(`Agent online | address=${agent.address} | env=${process.env.XMTP_ENV ?? "dev"}`);
    log.info(`Chat URL: ${getTestUrl(agent.client)}`);
  });

  agent.on("unhandledError", (err) => {
    log.error("Unhandled XMTP error", err);
  });

  // Start HTTP server
  await new Promise<void>((resolve, reject) => {
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        log.error(`Port ${HTTP_PORT} already in use. Is another agent running?`);
      }
      reject(err);
    });
    server.listen(HTTP_PORT, "127.0.0.1", () => {
      log.info(`HTTP server listening on http://127.0.0.1:${HTTP_PORT}`);
      resolve();
    });
  });

  // Write PID file
  writeFileSync(PID_FILE, JSON.stringify({
    pid: process.pid,
    port: HTTP_PORT,
    address: agent.address,
    startedAt: new Date().toISOString(),
  }));

  // Connect WebSocket to OpenClaw (non-blocking, graceful)
  connectWebSocket();

  // Start XMTP message streaming
  await agent.start();

  process.on("SIGINT", () => { shutdown(); });
  process.on("SIGTERM", () => { shutdown(); });
}

main().catch((err) => {
  log.error("Fatal error", err);
  process.exit(1);
});
```

### FILE: src/cli.ts

```typescript
#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BASE_DIR = process.env.XMTP_BASE_DIR ?? process.cwd();
const DATA_DIR = join(BASE_DIR, "data");
const PID_FILE = join(DATA_DIR, "agent.json");
const ENV_FILE = join(BASE_DIR, ".env");
const KNOWLEDGE_FILE = join(BASE_DIR, "knowledge.md");

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
      const { unlinkSync } = require("node:fs");
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

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdInit(): Promise<void> {
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
  if (!existsSync(join(BASE_DIR, "node_modules"))) {
    console.log("⏳ Installing dependencies...");
    const { execSync } = require("node:child_process");
    execSync("npm install", { stdio: "inherit", cwd: BASE_DIR });
  }

  console.log("\n🎉 Initialization complete!");
  console.log("Next steps:");
  console.log("  1. Edit knowledge.md with your expert knowledge");
  console.log("  2. Run: xmtp-agent start");
}

async function cmdStart(): Promise<void> {
  const existing = getAgentInfo();
  if (existing) {
    console.error(`Agent is already running (PID: ${existing.pid}, port: ${existing.port})`);
    process.exit(1);
  }

  console.log("Starting XMTP agent...");

  // Spawn agent as detached background process
  const agentScript = join(process.cwd(), "src", "agent.ts");
  const child = spawn("npx", ["tsx", agentScript, ...process.argv.slice(3)], {
    detached: true,
    stdio: "ignore",
    cwd: process.cwd(),
    env: {
      ...process.env,
      XMTP_BASE_DIR: BASE_DIR,
      XMTP_HTTP_PORT: process.env.XMTP_HTTP_PORT ?? "18790",
      XMTP_NO_WS: process.env.XMTP_NO_WS ?? "0",
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
  if (!info) {
    output({ running: false });
    if (!isJsonMode()) {
      console.log("Agent is not running");
    }
    return;
  }

  try {
    const result = await httpCall(info.port, "GET", "/status");
    output(result);
  } catch {
    output({ running: false, stale: true, pid: info.pid });
    if (!isJsonMode()) {
      console.log("Agent process exists but is not responding");
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const command = process.argv[2];

const commands: Record<string, () => Promise<void>> = {
  init: cmdInit,
  start: cmdStart,
  stop: cmdStop,
  send: cmdSend,
  inbox: cmdInbox,
  status: cmdStatus,
};

if (!command || !commands[command]) {
  console.log(`XMTP Expert Network - Agent CLI

Usage: xmtp-agent <command> [options]

Commands:
  init       Initialize project (generate keys + knowledge.md template)
  start      Start XMTP agent background process
  stop       Stop the running agent
  send       Send a message via XMTP
  inbox      View received messages
  status     Check agent status

Options:
  --json     Machine-readable JSON output
  --debug    Enable detailed logging (for start command)

Examples:
  xmtp-agent init
  xmtp-agent start
  xmtp-agent send --to 0xABC... --msg "Hello"
  xmtp-agent inbox --since 1711234567890 --json
  xmtp-agent status --json
`);
  process.exit(command ? 1 : 0);
}

commands[command]().catch((err) => {
  console.error(`Error: ${err.message ?? err}`);
  process.exit(1);
});
```

### FILE: scripts/test-local.ts

```typescript
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
```

### FILE: scripts/test-single.ts

```typescript
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
```

### FILE: SKILL.md

（SKILL.md 的完整内容已包含在 HANDOFF.md 中，此处不重复。请在重建项目时同时参考 HANDOFF.md 中的 SKILL.md 章节，或直接使用以下内容。）

请创建 SKILL.md 文件，内容参见随附的 HANDOFF.md 文档。

---

## 五、重建后的验证步骤

### 5.1 安装依赖

```bash
npm install
```

### 5.2 类型检查

```bash
npx tsc --noEmit
```

应该零错误。

### 5.3 运行双 agent 集成测试

```bash
npm test
```

预期结果：9 passed, 0 failed。这个测试会启动两个独立的 XMTP agent 互相发消息。

### 5.4 运行单 agent 测试（用于手动验证）

```bash
npm run test:single
```

启动后会打印一个 Chat URL（格式如 `http://xmtp.chat/dev/dm/0x...`）。在浏览器中打开这个 URL，发送消息，观察终端是否打印收到的消息。

### 5.5 验证完成后

阅读 **HANDOFF.md** 继续后续工作（OpenClaw Skill 集成测试等）。

---

## 六、项目文件清单

重建后项目应包含以下文件（共 8 个源文件）：

```
xmtp-expert-network/
├── .gitignore
├── package.json
├── tsconfig.json
├── SKILL.md
├── HANDOFF.md              ← 随本文档一起发送
├── src/
│   ├── agent.ts            ← 核心：XMTP agent + HTTP server
│   ├── cli.ts              ← CLI 命令入口
│   └── logger.ts           ← 日志模块
└── scripts/
    ├── test-local.ts       ← 双 agent 集成测试
    └── test-single.ts      ← 单 agent 手动测试
```

运行时自动生成（不纳入 git）：
- `.env` — XMTP 钱包密钥
- `knowledge.md` — 专家知识模板
- `data/` — PID 文件、审计日志
- `*.db3*` — XMTP SQLite 数据库
