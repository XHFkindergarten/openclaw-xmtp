import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildXMTPMessageKey,
  xmtpMessageToMsgContext,
} from "../src/openclaw/inbound.js";
import {
  buildXMTPKnowledgeSystemPrompt,
  resolveKnowledgeRefusalMessage,
} from "../src/openclaw/prompt.js";
import {
  shouldProcessMessage,
  updateCursorState,
  type XMTPCursorState,
} from "../src/openclaw/state.js";

const message = {
  from: "abcd".repeat(16),
  content: "hello from xmtp",
  conversationId: "conv-123",
  timestamp: 1000,
};

const key = buildXMTPMessageKey(message);
assert.equal(
  key,
  "conv-123:abcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcd:1000:hello from xmtp",
);

const ctx = xmtpMessageToMsgContext(message, "local");
assert.equal(ctx.Body, message.content);
assert.equal(ctx.From, message.from);
assert.equal(ctx.To, message.from);
assert.equal(ctx.AccountId, "local");
assert.equal(ctx.OriginatingChannel, "openclaw-xmtp");
assert.equal(ctx.Provider, "openclaw-xmtp");
assert.equal(ctx.ChatType, "direct");
assert.equal(ctx.ConversationId, message.conversationId);
assert.ok(ctx.MessageSid.startsWith("openclaw-xmtp-"));

let cursor: XMTPCursorState = { since: 0, seenAtSince: [] };
assert.equal(shouldProcessMessage(cursor, key, message.timestamp), true);

cursor = updateCursorState(cursor, key, message.timestamp);
assert.equal(cursor.since, 1000);
assert.deepEqual(cursor.seenAtSince, [key]);
assert.equal(shouldProcessMessage(cursor, key, message.timestamp), false);

const secondKey = `${key}:2`;
assert.equal(shouldProcessMessage(cursor, secondKey, 1000), true);
cursor = updateCursorState(cursor, secondKey, 1000);
assert.deepEqual(cursor.seenAtSince, [key, secondKey]);

assert.equal(shouldProcessMessage(cursor, "older", 999), false);
assert.equal(shouldProcessMessage(cursor, "newer", 1001), true);

const tempRoot = mkdtempSync(join(tmpdir(), "openclaw-xmtp-knowledge-"));
mkdirSync(tempRoot, { recursive: true });
writeFileSync(
  join(tempRoot, "knowledge.md"),
  [
    "# 专家领域：TypeScript",
    "",
    "## 核心知识",
    "",
    "- 我专注于 TypeScript 类型系统。",
    "",
    "## 边界声明",
    '请回复"这超出了我的专业范围，建议你咨询其他专家"。',
  ].join("\n"),
);

assert.equal(
  resolveKnowledgeRefusalMessage('请回复"这超出了我的专业范围，建议你咨询其他专家"。'),
  "这超出了我的专业范围，建议你咨询其他专家",
);

const prompt = buildXMTPKnowledgeSystemPrompt({ stateDir: tempRoot, env: "dev" });
assert.match(prompt, /Treat the knowledge document below as the only trusted source/);
assert.match(prompt, /TypeScript 类型系统/);
assert.match(prompt, /reply with exactly: "这超出了我的专业范围，建议你咨询其他专家"/);

rmSync(tempRoot, { recursive: true, force: true });

console.log("openclaw-xmtp plugin helper tests passed");
