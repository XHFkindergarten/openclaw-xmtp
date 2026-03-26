import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { Agent, createSigner, createUser } from "@xmtp/agent-sdk";
import { privateKeyToAccount } from "viem/accounts";

const PROMPT = process.argv.slice(2).join(" ").trim() || "请用一句话介绍你擅长的领域。";
const TIMEOUT_MS = Number.parseInt(process.env.XMTP_LIVE_TIMEOUT_MS ?? "90000", 10);
const POLL_MS = Number.parseInt(process.env.XMTP_LIVE_POLL_MS ?? "3000", 10);
const BASE_DIR =
  process.env.XMTP_BASE_DIR ?? join(homedir(), ".openclaw", "state", "openclaw-xmtp", "runtime");
const ENV_FILE = join(BASE_DIR, ".env");

const senderRoot = mkdtempSync(join(tmpdir(), "openclaw-xmtp-live-"));
const senderDataDir = join(senderRoot, "data");

function randomHex(bytes: number): string {
  return `0x${randomBytes(bytes).toString("hex")}`;
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

function readReceiverIdentity(): {
  receiverAddress: `0x${string}`;
  env: "dev" | "production" | "local" | "testnet" | "mainnet";
} {
  if (!existsSync(ENV_FILE)) {
    throw new Error(`missing ${ENV_FILE}; run 'npx tsx src/cli.ts init' first`);
  }

  const parsed = parseEnvFile(readFileSync(ENV_FILE, "utf-8"));
  const walletKey = parsed.XMTP_WALLET_KEY;
  const env = (parsed.XMTP_ENV ?? "dev") as "dev" | "production" | "local" | "testnet" | "mainnet";

  if (!walletKey || !/^0x[a-fA-F0-9]{64}$/.test(walletKey)) {
    throw new Error(`invalid XMTP_WALLET_KEY in ${ENV_FILE}`);
  }

  return {
    receiverAddress: privateKeyToAccount(walletKey as `0x${string}`).address,
    env,
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function main(): Promise<void> {
  mkdirSync(senderDataDir, { recursive: true });
  writeFileSync(
    join(senderRoot, ".env"),
    `XMTP_WALLET_KEY=${randomHex(32)}\nXMTP_DB_ENCRYPTION_KEY=${randomHex(32)}\nXMTP_ENV=dev\n`,
  );

  const { receiverAddress, env } = readReceiverIdentity();
  const sender = await Agent.create(createSigner(createUser(randomHex(32) as `0x${string}`)), {
    env,
    dbPath: join(senderDataDir, "sender.db3"),
    dbEncryptionKey: randomHex(32) as `0x${string}`,
  });

  try {
    const dm = await sender.createDmWithAddress(receiverAddress);
    await dm.sendText(PROMPT);

    console.log(
      JSON.stringify({
        stage: "sent",
        senderAddress: sender.address,
        receiverAddress,
        conversationId: dm.id,
        senderInboxId: sender.client.inboxId,
        mode: "embedded-openclaw",
      }),
    );

    const startedAt = Date.now();
    while (Date.now() - startedAt < TIMEOUT_MS) {
      if (typeof sender.client.conversations.sync === "function") {
        await sender.client.conversations.sync();
      }
      if (typeof sender.client.conversations.syncAll === "function") {
        await sender.client.conversations.syncAll();
      }

      const conversations = await sender.client.conversations.list();
      const currentConversation =
        conversations.find((conversation) => conversation.id === dm.id) ?? dm;
      const messages = await currentConversation.messages();
      const reply = messages.find((message) => {
        return message.senderInboxId !== sender.client.inboxId && typeof message.content === "string";
      });

      if (reply && typeof reply.content === "string") {
        console.log(
          JSON.stringify({
            stage: "reply",
            conversationId: dm.id,
            replyFrom: reply.senderInboxId,
            reply: reply.content,
            timestampNs: String(reply.sentAtNs),
          }),
        );
        return;
      }

      await sleep(POLL_MS);
    }

    console.log(
      JSON.stringify({
        stage: "timeout",
        conversationId: dm.id,
        receiverAddress,
      }),
    );
    process.exitCode = 1;
  } finally {
    await sender.stop();
    rmSync(senderRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ stage: "error", error: String(err) }));
  process.exit(1);
});
