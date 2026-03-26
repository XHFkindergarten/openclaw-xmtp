import type { PluginRuntime } from "openclaw/plugin-sdk";

let pluginRuntime: PluginRuntime | null = null;

export function setXMTPRuntime(next: PluginRuntime): void {
  pluginRuntime = next;
}

export async function waitForXMTPRuntime(timeoutMs = 10_000): Promise<PluginRuntime> {
  const startedAt = Date.now();
  while (!pluginRuntime) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("XMTP runtime initialization timeout");
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
  }
  return pluginRuntime;
}
