import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { TestWallets, AgentWallet } from "../src/types.js";

const OUTPUT_PATH = "config/test-wallets.json";
const NAMES = ["alice", "bob", "carol"];

function generateWallet(): AgentWallet {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const dbEncryptionKey = generatePrivateKey(); // 32 字节随机 hex，复用 generatePrivateKey
  return {
    privateKey,
    address: account.address,
    dbEncryptionKey,
  };
}

if (existsSync(OUTPUT_PATH)) {
  console.log("Wallets already exist, skipping");
  process.exit(0);
}

mkdirSync("config", { recursive: true });

const wallets: TestWallets = {};
for (const name of NAMES) {
  wallets[name] = generateWallet();
}

writeFileSync(OUTPUT_PATH, JSON.stringify(wallets, null, 2));
console.log(`Generated ${NAMES.length} test wallets -> ${OUTPUT_PATH}`);
