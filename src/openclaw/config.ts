export const XMTP_CHANNEL_ID = "openclaw-xmtp";
export const XMTP_ACCOUNT_ID = "default";
export const DEFAULT_XMTP_ENV = process.env.XMTP_ENV ?? "dev";
export const DEFAULT_STATE_DIR = process.env.XMTP_PLUGIN_STATE_DIR
  ?? `${process.env.HOME ?? "."}/.openclaw/state/openclaw-xmtp/runtime`;

export const XMTP_CHANNEL_CONFIG_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    stateDir: {
      type: "string",
      description: "Directory containing XMTP runtime state (.env, DB files, audit logs)",
    },
    env: {
      type: "string",
      description: "XMTP network environment (dev or production)",
    },
  },
} as const;

export type XMTPChannelConfig = {
  stateDir: string;
  env: string;
};

export function resolveXMTPChannelConfig(cfg: Record<string, any> | undefined): XMTPChannelConfig {
  const channelCfg = (cfg?.channels?.[XMTP_CHANNEL_ID] ?? {}) as Record<string, unknown>;
  const stateDir = typeof channelCfg.stateDir === "string" && channelCfg.stateDir.trim().length > 0
    ? channelCfg.stateDir.trim()
    : DEFAULT_STATE_DIR;
  const env = typeof channelCfg.env === "string" && channelCfg.env.trim().length > 0
    ? channelCfg.env.trim()
    : DEFAULT_XMTP_ENV;

  return { stateDir, env };
}
