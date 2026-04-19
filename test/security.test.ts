import { describe, it, expect } from "vitest";
import { ContentFilter } from "../src/domains/security/filter.js";
import { sandboxMessage } from "../src/domains/security/prompt-sandbox.js";
import type { MessageContext } from "@xmtp/agent-sdk";

// ── ContentFilter ──────────────────────────────────────────────────────────

describe("ContentFilter", () => {
  it("allows normal messages", () => {
    const f = new ContentFilter();
    expect(f.check("hello world").allowed).toBe(true);
  });

  it("rejects messages exceeding maxLength", () => {
    const f = new ContentFilter({ maxLength: 10 });
    const result = f.check("12345678901");
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/max length/);
  });

  it("allows messages exactly at maxLength", () => {
    const f = new ContentFilter({ maxLength: 5 });
    expect(f.check("12345").allowed).toBe(true);
  });

  it("rejects blocked words (case-insensitive)", () => {
    const f = new ContentFilter({ blocklist: ["badword"] });
    expect(f.check("this has BADWORD in it").allowed).toBe(false);
    expect(f.check("this has BADWORD in it").reason).toMatch(/blocked/);
  });

  it("allows messages with no blocked words", () => {
    const f = new ContentFilter({ blocklist: ["badword"] });
    expect(f.check("totally clean message").allowed).toBe(true);
  });

  it("setBlocklist replaces previous list", () => {
    const f = new ContentFilter({ blocklist: ["alpha"] });
    f.setBlocklist(["beta"]);
    expect(f.check("contains alpha").allowed).toBe(true);
    expect(f.check("contains beta").allowed).toBe(false);
  });

  it("empty blocklist allows everything", () => {
    const f = new ContentFilter({ blocklist: [] });
    expect(f.check("anything goes").allowed).toBe(true);
  });
});

// ── sandboxMessage ─────────────────────────────────────────────────────────

function fakeCtx(content: unknown, extras?: Partial<{
  senderInboxId: string;
  id: string;
  sentAtNs: bigint;
  conversationId: string;
}>): MessageContext {
  return {
    message: {
      content,
      senderInboxId: extras?.senderInboxId ?? "inbox-abc",
      id: extras?.id ?? "msg-1",
      sentAtNs: extras?.sentAtNs ?? BigInt(Date.now()) * 1_000_000n,
    },
    conversation: { id: extras?.conversationId ?? "conv-xyz" },
  } as unknown as MessageContext;
}

describe("sandboxMessage", () => {
  it("passes through string content unchanged when under limit", () => {
    const ctx = fakeCtx("hello");
    expect(sandboxMessage(ctx).content).toBe("hello");
  });

  it("replaces non-string content with [non-text]", () => {
    const ctx = fakeCtx({ type: "reaction" });
    expect(sandboxMessage(ctx).content).toBe("[non-text]");
  });

  it("truncates content exceeding maxContentLength", () => {
    const ctx = fakeCtx("a".repeat(4010));
    const result = sandboxMessage(ctx, { maxContentLength: 4000 });
    expect(result.content.endsWith("…[truncated]")).toBe(true);
    expect(result.content.length).toBeLessThan(4010 + 20);
  });

  it("does not truncate content exactly at maxContentLength", () => {
    const ctx = fakeCtx("a".repeat(100));
    const result = sandboxMessage(ctx, { maxContentLength: 100 });
    expect(result.content).toBe("a".repeat(100));
  });

  it("extracts senderInboxId and conversationId correctly", () => {
    const ctx = fakeCtx("hi", { senderInboxId: "sender-1", conversationId: "conv-1" });
    const result = sandboxMessage(ctx);
    expect(result.senderInboxId).toBe("sender-1");
    expect(result.conversationId).toBe("conv-1");
  });

  it("converts sentAtNs to a Date", () => {
    const now = Date.now();
    const ctx = fakeCtx("hi", { sentAtNs: BigInt(now) * 1_000_000n });
    const result = sandboxMessage(ctx);
    expect(result.sentAt.getTime()).toBe(now);
  });
});
