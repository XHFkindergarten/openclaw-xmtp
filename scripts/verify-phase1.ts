/**
 * Phase 1 验收：只验证钱包生成与加载，不涉及 XMTP 网络
 */
import { readFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import type { TestWallets } from "../src/types.js";

const wallets: TestWallets = JSON.parse(
  readFileSync("config/test-wallets.json", "utf-8")
);

let allPassed = true;

for (const [name, wallet] of Object.entries(wallets)) {
  // 验证 privateKey 格式
  if (!/^0x[0-9a-fA-F]{64}$/.test(wallet.privateKey)) {
    console.error(`FAIL [${name}] invalid privateKey format`);
    allPassed = false;
    continue;
  }
  // 验证 address 与 privateKey 一致
  const derived = privateKeyToAccount(wallet.privateKey);
  if (derived.address.toLowerCase() !== wallet.address.toLowerCase()) {
    console.error(`FAIL [${name}] address mismatch`);
    allPassed = false;
    continue;
  }
  // 验证 dbEncryptionKey 格式（32 字节）
  if (!/^0x[0-9a-fA-F]{64}$/.test(wallet.dbEncryptionKey)) {
    console.error(`FAIL [${name}] invalid dbEncryptionKey format`);
    allPassed = false;
    continue;
  }
  console.log(`OK  [${name}] address=${wallet.address}`);
}

// 验证三个钱包地址各不相同
const addresses = Object.values(wallets).map((w) => w.address);
const uniqueCount = new Set(addresses).size;
if (uniqueCount !== addresses.length) {
  console.error("FAIL duplicate addresses detected");
  allPassed = false;
} else {
  console.log(`OK  all ${addresses.length} addresses are unique`);
}

if (!allPassed) {
  process.exit(1);
}
console.log("\nPhase 1 verification PASSED");
