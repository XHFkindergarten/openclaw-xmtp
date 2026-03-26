import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { buildChannelConfigSchema } from "openclaw/plugin-sdk";

import { xmtpPlugin } from "./src/openclaw/channel.js";
import { XMTP_CHANNEL_CONFIG_SCHEMA } from "./src/openclaw/config.js";
import { resolveXMTPChannelConfig, XMTP_CHANNEL_ID } from "./src/openclaw/config.js";
import { buildXMTPKnowledgeSystemPrompt } from "./src/openclaw/prompt.js";
import { setXMTPRuntime } from "./src/openclaw/runtime.js";

const plugin = {
  id: "openclaw-xmtp",
  name: "XMTP",
  description: "XMTP channel running directly inside the OpenClaw gateway lifecycle",
  configSchema: buildChannelConfigSchema(XMTP_CHANNEL_CONFIG_SCHEMA),
  register(api: OpenClawPluginApi) {
    if (!api?.runtime) {
      throw new Error("[xmtp] api.runtime is not available in register()");
    }
    setXMTPRuntime(api.runtime);
    api.registerChannel({ plugin: xmtpPlugin });
    const applyXMTPKnowledgePrompt = async (hookName: string, event: any) => {
      const channelId = String(event?.channelId ?? "");
      const sessionKey = String(event?.sessionKey ?? "");
      const agentId = String(event?.agentId ?? "");
      const matched =
        channelId === XMTP_CHANNEL_ID || sessionKey.includes(`:${XMTP_CHANNEL_ID}:`);
      if (!matched) {
        return;
      }

      const channelCfg = resolveXMTPChannelConfig(api.config);
      const systemPrompt = buildXMTPKnowledgeSystemPrompt(channelCfg);
      api.logger?.info?.(
        `[xmtp] ${hookName} matched channel=${channelId || "(none)"} agent=${agentId || "(none)"} session=${sessionKey || "(none)"} knowledgeDir=${channelCfg.stateDir} promptChars=${systemPrompt.length}`,
      );
      return { systemPrompt };
    };

    api.on?.("before_prompt_build", (event: any) =>
      applyXMTPKnowledgePrompt("before_prompt_build", event));
    api.on?.("before_agent_start", (event: any) =>
      applyXMTPKnowledgePrompt("before_agent_start", event));
  },
};

export default plugin;
