import { describe, it, expect } from "vitest";
import { sandboxMessage } from "../src/domains/security/prompt-sandbox.js";
import type { MessageContext } from "@xmtp/agent-sdk";

function fakeCtx(content: unknown, sentAtNs?: bigint): MessageContext {
  return {
    message: {
      content,
      senderInboxId: "inbox-x",
      id: "msg-1",
      sentAtNs: sentAtNs ?? BigInt(Date.now()) * 1_000_000n,
    },
    conversation: { id: "conv-1" },
  } as unknown as MessageContext;
}

describe("sandboxMessage – edge cases", () => {
  it("empty string content passes through unchanged", () => {
    const result = sandboxMessage(fakeCtx(""));
    expect(result.content).toBe("");
  });

  it("null content is treated as non-text", () => {
    const result = sandboxMessage(fakeCtx(null));
    expect(result.content).toBe("[non-text]");
  });

  it("number content is treated as non-text", () => {
    expect(sandboxMessage(fakeCtx(42)).content).toBe("[non-text]");
  });

  it("array content is treated as non-text", () => {
    expect(sandboxMessage(fakeCtx([])).content).toBe("[non-text]");
  });

  it("[non-text] sentinel is under default maxContentLength — no double truncation", () => {
    // Ensures [non-text] itself (11 chars) is not truncated with default 4000 limit
    const result = sandboxMessage(fakeCtx({ complex: true }));
    expect(result.content).toBe("[non-text]");
  });

  it("sentAtNs = 0n maps to Unix epoch", () => {
    const result = sandboxMessage(fakeCtx("hi", 0n));
    expect(result.sentAt.getTime()).toBe(0);
  });

  it("truncation appends ellipsis marker, final length slightly exceeds maxContentLength", () => {
    const limit = 10;
    const result = sandboxMessage(fakeCtx("a".repeat(20)), undefined);
    const r = sandboxMessage(fakeCtx("a".repeat(20)), BigInt(Date.now()) * 1_000_000n);
    const custom = sandboxMessage(fakeCtx("a".repeat(20)), BigInt(Date.now()) * 1_000_000n);
    // with custom limit
    const r2 = sandboxMessage(
      { message: { content: "a".repeat(20), senderInboxId: "x", id: "m", sentAtNs: 0n }, conversation: { id: "c" } } as unknown as MessageContext,
      { maxContentLength: limit }
    );
    expect(r2.content.startsWith("a".repeat(limit))).toBe(true);
    expect(r2.content.endsWith("…[truncated]")).toBe(true);
    // content after truncation: 10 'a's + "…[truncated]" (12 chars) = 22 total
    expect(r2.content.length).toBe(limit + "…[truncated]".length);
  });

  it("content exactly at maxContentLength is NOT truncated", () => {
    const ctx = { message: { content: "a".repeat(100), senderInboxId: "x", id: "m", sentAtNs: 0n }, conversation: { id: "c" } } as unknown as MessageContext;
    expect(sandboxMessage(ctx, { maxContentLength: 100 }).content).toBe("a".repeat(100));
  });
});
