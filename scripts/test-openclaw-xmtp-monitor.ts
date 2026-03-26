import assert from "node:assert/strict";
import { rmSync } from "node:fs";

import { monitorXMTPProvider } from "../src/openclaw/monitor.js";
import { setXMTPRuntime } from "../src/openclaw/runtime.js";
import {
  __resetXMTPServiceFactoryForTests,
  __setXMTPServiceFactoryForTests,
} from "../src/openclaw/service.js";

const outbound: Array<{ to: string; msg: string }> = [];
const stateDir = "/tmp/openclaw-xmtp-monitor-test";

const recorded: Array<{ kind: string; payload: any }> = [];

rmSync(stateDir, { recursive: true, force: true });

__setXMTPServiceFactoryForTests(() => {
  return {
    getStatus: () => ({
      running: true,
      address: "0x1234",
      chatUrl: "https://xmtp.chat/dev/dm/0x1234",
      env: "dev",
      stateDir,
    }),
    sendText: async (to: string, text: string) => {
      outbound.push({ to, msg: text });
      return { conversationId: "conv-bridge" };
    },
    start: async ({ onMessage, abortSignal }: { onMessage: (message: any) => Promise<void>; abortSignal?: AbortSignal }) => {
      await onMessage({
        from: "feed".repeat(16),
        content: "what is your specialty?",
        conversationId: "conv-bridge",
        timestamp: 1234,
        messageId: "msg-1",
      });
      await new Promise<void>((resolve) => {
        abortSignal?.addEventListener("abort", () => resolve(), { once: true });
      });
    },
    stop: async () => undefined,
  };
});

setXMTPRuntime({
  channel: {
    media: {
      saveMediaBuffer: async () => undefined,
    },
    commands: {},
    routing: {
      resolveAgentRoute: () => ({
        agentId: "expert-agent",
        sessionKey: "session:xmtp:peer",
        mainSessionKey: "session:xmtp:main",
      }),
    },
    session: {
      resolveStorePath: () => "/tmp/openclaw-xmtp-test.json",
      recordInboundSession: async (params: any) => {
        recorded.push({ kind: "record", payload: params });
      },
    },
    reply: {
      finalizeInboundContext: (ctx: any) => ctx,
      resolveHumanDelayConfig: () => null,
      createReplyDispatcherWithTyping: ({ deliver }: any) => ({
        dispatcher: { deliver },
        replyOptions: {},
        markDispatchIdle: () => {
          recorded.push({ kind: "idle", payload: null });
        },
      }),
      withReplyDispatcher: async ({ run }: { run: () => Promise<void> }) => run(),
      dispatchReplyFromConfig: async ({ dispatcher, ctx }: any) => {
        recorded.push({ kind: "dispatch", payload: ctx });
        await dispatcher.deliver({ text: `reply:${ctx.Body}` });
      },
    },
  },
});

const abortController = new AbortController();
const monitorPromise = monitorXMTPProvider({
  accountId: "local",
  config: {
    channels: {
      "openclaw-xmtp": {
        stateDir,
        env: "dev",
      },
    },
  },
  abortSignal: abortController.signal,
});

await waitFor(() => outbound.length === 1, 2000);
abortController.abort();
await monitorPromise.catch((err) => {
  if (String(err) !== "Error: aborted") {
    throw err;
  }
});

assert.equal(outbound.length, 1);
assert.equal(outbound[0]?.to, "feed".repeat(16));
assert.equal(outbound[0]?.msg, "reply:what is your specialty?");
assert.ok(recorded.some((entry) => entry.kind === "record"));
assert.ok(recorded.some((entry) => entry.kind === "dispatch"));
const dispatchCtx = recorded.find((entry) => entry.kind === "dispatch")?.payload;
assert.equal(typeof dispatchCtx?.GroupSystemPrompt, "string");
assert.match(dispatchCtx?.GroupSystemPrompt, /XMTP expert mode is active/);
assert.match(dispatchCtx?.GroupSystemPrompt, /You must refuse every substantive question with exactly/);

__resetXMTPServiceFactoryForTests();

console.log("openclaw-xmtp monitor integration test passed");

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("timeout waiting for monitor output");
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
}
