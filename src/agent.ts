import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Agent, getTestUrl } from "@xmtp/agent-sdk";
import * as log from "./logger.js";

// ---------------------------------------------------------------------------
// Config — all paths derived from BASE_DIR (decoupled for multi-instance)
// ---------------------------------------------------------------------------

const DEFAULT_BASE_DIR = join(homedir(), ".openclaw", "state", "openclaw-xmtp", "runtime");
const BASE_DIR = resolve(process.env.XMTP_BASE_DIR ?? DEFAULT_BASE_DIR);

// Load .env from BASE_DIR before reading any env vars that may come from it
import { config as loadEnv } from "dotenv";
loadEnv({ path: join(BASE_DIR, ".env") });

const HTTP_PORT = parseInt(process.env.XMTP_HTTP_PORT ?? "18790", 10);
const DATA_DIR = join(BASE_DIR, "data");
const PID_FILE = join(DATA_DIR, "agent.json");
const AUDIT_FILE = join(DATA_DIR, "audit.jsonl");
const KNOWLEDGE_FILE = join(BASE_DIR, "knowledge.md");

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

function getPublicChatUrl(): string {
  return getTestUrl(agent.client).replace(/^http:\/\//, "https://");
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

    // Accept either wallet address (0x...) or inboxId (64 hex chars)
    const isInboxId = /^[a-fA-F0-9]{64}$/.test(to);
    const dm = isInboxId
      ? await agent.client.conversations.createDm(to)
      : await agent.createDmWithAddress(to as `0x${string}`);
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
        // Skip non-text system events (group membership changes, etc.)
        if (typeof m.content !== "string") {
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
    webSocketConnected: false,
    chatUrl: getPublicChatUrl(),
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
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

async function shutdown(): Promise<void> {
  const uptime = Math.floor((Date.now() - startTime) / 1000);
  log.info(`Agent stopping | uptime=${uptime}s`);

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
    log.info(`Chat URL: ${getPublicChatUrl()}`);
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

  // Start XMTP message streaming
  await agent.start();

  process.on("SIGINT", () => { shutdown(); });
  process.on("SIGTERM", () => { shutdown(); });
}

main().catch((err) => {
  log.error("Fatal error", err);
  process.exit(1);
});
