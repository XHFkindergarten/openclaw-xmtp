// === 配置 ===
export interface PluginConfig {
  env: "production" | "dev";
  gatewayHost?: string;
  dbDir: string;
  httpPort: number;
  sensitiveWordRefreshInterval: number;
}

export interface QueueConfig {
  maxConcurrentChats: number;  // 默认 1，最大 10
}

// === 测试钱包 ===
export interface AgentWallet {
  privateKey: `0x${string}`;
  address: string;
  dbEncryptionKey: `0x${string}`;
}

export interface TestWallets {
  [name: string]: AgentWallet;
}
