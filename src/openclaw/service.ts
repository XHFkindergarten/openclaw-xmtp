import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { Agent, createSigner, createUser, getTestUrl } from "@xmtp/agent-sdk";

import type { XMTPInboundMessage } from "./inbound.js";

export type XMTPServiceConfig = {
  stateDir: string;
  env: string;
};

export type XMTPServiceStatus = {
  running: boolean;
  address?: string;
  chatUrl?: string;
  env: string;
  stateDir: string;
};

export type XMTPInboundHandler = (message: XMTPInboundMessage) => Promise<void>;

type XMTPSecrets = {
  walletKey: `0x${string}`;
  dbEncryptionKey: `0x${string}`;
  env: string;
};

type XMTPService = {
  start: (params: { onMessage: XMTPInboundHandler; abortSignal?: AbortSignal }) => Promise<void>;
  sendText: (to: string, text: string) => Promise<{ conversationId: string }>;
  getStatus: () => XMTPServiceStatus;
  stop: () => Promise<void>;
};

const services = new Map<string, XMTPService>();
let serviceFactory: typeof createXMTPService = createXMTPService;

export function getOrCreateXMTPService(params: {
  accountId: string;
  config: XMTPServiceConfig;
  log?: (msg: string) => void;
  errLog?: (msg: string) => void;
}): XMTPService {
  const key = serviceKey(params.accountId, params.config);
  let service = services.get(key);
  if (!service) {
    service = serviceFactory(params.config, {
      log: params.log ?? (() => {}),
      errLog: params.errLog ?? (() => {}),
    });
    services.set(key, service);
  }
  return service;
}

export function releaseXMTPService(accountId: string, config: XMTPServiceConfig): void {
  services.delete(serviceKey(accountId, config));
}

export function __setXMTPServiceFactoryForTests(next: typeof createXMTPService): void {
  serviceFactory = next;
  services.clear();
}

export function __resetXMTPServiceFactoryForTests(): void {
  serviceFactory = createXMTPService;
  services.clear();
}

export async function sendXMTPText(params: {
  accountId: string;
  config: XMTPServiceConfig;
  to: string;
  text: string;
  log?: (msg: string) => void;
  errLog?: (msg: string) => void;
}): Promise<{ conversationId: string }> {
  const key = serviceKey(params.accountId, params.config);
  const existing = services.get(key);
  if (!existing) {
    const ephemeral = serviceFactory(params.config, {
      log: params.log ?? (() => {}),
      errLog: params.errLog ?? (() => {}),
    });
    try {
      return await ephemeral.sendText(params.to, params.text);
    } finally {
      await ephemeral.stop();
    }
  }

  return existing.sendText(params.to, params.text);
}

export function inspectXMTPState(config: XMTPServiceConfig): {
  configured: boolean;
  stateDir: string;
  env: string;
  envPath: string;
  missing: string[];
} {
  const envPath = join(config.stateDir, ".env");
  const missing = existsSync(envPath) ? [] : [envPath];
  return {
    configured: missing.length === 0,
    stateDir: config.stateDir,
    env: config.env,
    envPath,
    missing,
  };
}

function createXMTPService(
  config: XMTPServiceConfig,
  deps: { log: (msg: string) => void; errLog: (msg: string) => void },
): XMTPService {
  let agent: Agent | null = null;
  let running = false;
  let startPromise: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;
  let messageHandler: XMTPInboundHandler | null = null;

  async function ensureAgent(): Promise<Agent> {
    if (agent) {
      return agent;
    }

    const secrets = loadXMTPSecrets(config);
    const signer = createSigner(createUser(secrets.walletKey));
    const dbDir = join(config.stateDir, "db");
    ensureDir(dbDir);

    agent = await Agent.create(signer, {
      env: secrets.env as "dev" | "production" | "local" | "testnet" | "mainnet",
      dbPath: (inboxId) => join(dbDir, `xmtp-${secrets.env}-${inboxId}.db3`),
      dbEncryptionKey: secrets.dbEncryptionKey,
    });

    agent.on("text", async (ctx) => {
      if (ctx.message.senderInboxId === agent?.client.inboxId) {
        return;
      }
      if (typeof ctx.message.content !== "string" || !messageHandler) {
        return;
      }

      await messageHandler({
        from: ctx.message.senderInboxId,
        content: ctx.message.content,
        conversationId: ctx.conversation.id,
        timestamp: Number(ctx.message.sentAtNs) / 1_000_000,
        messageId: ctx.message.id,
      });
    });

    agent.on("unhandledError", (error) => {
      deps.errLog(`[xmtp] sdk unhandled error: ${String(error)}`);
    });

    agent.on("start", () => {
      deps.log(`[xmtp] sdk online address=${agent?.address ?? "(unknown)"} env=${secrets.env}`);
    });

    agent.on("stop", () => {
      deps.log("[xmtp] sdk stopped");
    });

    return agent;
  }

  return {
    async start(params) {
      messageHandler = params.onMessage;
      const currentAgent = await ensureAgent();
      if (startPromise) {
        return startPromise;
      }

      running = true;
      startPromise = (async () => {
        await currentAgent.start();

        await new Promise<void>((resolve) => {
          if (params.abortSignal?.aborted) {
            resolve();
            return;
          }

          const onAbort = () => {
            params.abortSignal?.removeEventListener("abort", onAbort);
            resolve();
          };
          params.abortSignal?.addEventListener("abort", onAbort, { once: true });
        });
      })().finally(() => {
        running = false;
        startPromise = null;
        void this.stop();
      });

      return startPromise;
    },

    async sendText(to, text) {
      const currentAgent = await ensureAgent();
      const isInboxId = /^[a-fA-F0-9]{64}$/.test(to);
      const dm = isInboxId
        ? await currentAgent.client.conversations.createDm(to)
        : await currentAgent.createDmWithAddress(to as `0x${string}`);
      await dm.sendText(text);
      appendAudit(config.stateDir, {
        type: "sent",
        to,
        conversationId: dm.id,
        length: text.length,
      });
      return { conversationId: dm.id };
    },

    getStatus() {
      return {
        running,
        address: agent?.address,
        chatUrl: agent ? getTestUrl(agent.client).replace(/^http:\/\//, "https://") : undefined,
        env: config.env,
        stateDir: config.stateDir,
      };
    },

    async stop() {
      if (!agent) {
        return;
      }
      if (stopPromise) {
        return stopPromise;
      }
      stopPromise = agent.stop().finally(() => {
        stopPromise = null;
        agent = null;
      });
      return stopPromise;
    },
  };
}

function serviceKey(accountId: string, config: XMTPServiceConfig): string {
  return `${accountId}:${config.stateDir}:${config.env}`;
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function loadXMTPSecrets(config: XMTPServiceConfig): XMTPSecrets {
  const envPath = join(config.stateDir, ".env");
  if (!existsSync(envPath)) {
    throw new Error(
      `missing XMTP env file at ${envPath}; run 'XMTP_BASE_DIR=${config.stateDir} npx tsx src/cli.ts init' first`,
    );
  }

  const parsed = parseEnvFile(readFileSync(envPath, "utf8"));
  const walletKey = parsed.XMTP_WALLET_KEY;
  const dbEncryptionKey = parsed.XMTP_DB_ENCRYPTION_KEY;
  const env = parsed.XMTP_ENV ?? config.env;

  if (!walletKey || !/^0x[a-fA-F0-9]{64}$/.test(walletKey)) {
    throw new Error(`invalid or missing XMTP_WALLET_KEY in ${envPath}`);
  }
  if (!dbEncryptionKey || !/^0x[a-fA-F0-9]{64}$/.test(dbEncryptionKey)) {
    throw new Error(`invalid or missing XMTP_DB_ENCRYPTION_KEY in ${envPath}`);
  }

  return {
    walletKey: walletKey as `0x${string}`,
    dbEncryptionKey: dbEncryptionKey as `0x${string}`,
    env,
  };
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
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    result[key] = value;
  }
  return result;
}

function appendAudit(stateDir: string, entry: Record<string, unknown>): void {
  ensureDir(stateDir);
  appendFileSync(join(stateDir, "audit.jsonl"), `${JSON.stringify({ ...entry, ts: new Date().toISOString() })}\n`);
}
