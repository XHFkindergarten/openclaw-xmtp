import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createUser, createSigner } from "@xmtp/agent-sdk";
import type { AgentWallet, TestWallets } from "../../src/types.js";

const WALLETS_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../config/test-wallets.json"
);

export function loadTestWallets(): TestWallets {
  return JSON.parse(readFileSync(WALLETS_PATH, "utf-8")) as TestWallets;
}

export function loadTestWallet(name: string): AgentWallet {
  const wallets = loadTestWallets();
  const wallet = wallets[name];
  if (!wallet) {
    throw new Error(`Test wallet "${name}" not found`);
  }
  return wallet;
}

export function createXmtpSigner(wallet: AgentWallet) {
  const user = createUser(wallet.privateKey);
  return createSigner(user);
}
