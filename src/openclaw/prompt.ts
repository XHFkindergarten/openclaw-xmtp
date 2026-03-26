import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { XMTPChannelConfig } from "./config.js";

const DEFAULT_REFUSAL =
  "这超出了我的专业范围，建议你咨询其他专家";

export function readKnowledgeFile(config: XMTPChannelConfig): {
  path: string;
  exists: boolean;
  content: string;
} {
  const path = join(config.stateDir, "knowledge.md");
  if (!existsSync(path)) {
    return { path, exists: false, content: "" };
  }
  return {
    path,
    exists: true,
    content: readFileSync(path, "utf8").trim(),
  };
}

export function resolveKnowledgeRefusalMessage(knowledge: string): string {
  const quoted =
    knowledge.match(/请回复["“](.+?)["”]/)?.[1]?.trim()
    ?? knowledge.match(/回复["“](.+?)["”]/)?.[1]?.trim();
  return quoted && quoted.length > 0 ? quoted : DEFAULT_REFUSAL;
}

export function isKnowledgeTemplateOrEmpty(knowledge: string): boolean {
  const normalized = knowledge.trim();
  if (!normalized) {
    return true;
  }
  return normalized.includes("[请填写你的专业领域]");
}

export function buildXMTPKnowledgeSystemPrompt(config: XMTPChannelConfig): string {
  const knowledge = readKnowledgeFile(config);
  const refusal = resolveKnowledgeRefusalMessage(knowledge.content);

  if (!knowledge.exists || isKnowledgeTemplateOrEmpty(knowledge.content)) {
    return [
      "XMTP expert mode is active.",
      "No trusted knowledge base has been configured yet.",
      `You must refuse every substantive question with exactly: "${refusal}"`,
      "Do not answer from general knowledge, workspace files, long-term memory, prior sessions, or owner identity.",
    ].join("\n");
  }

  return [
    "XMTP expert mode is active.",
    "You are answering an external XMTP peer, not the owner.",
    "Treat the knowledge document below as the only trusted source of facts you may use.",
    `If the answer is not explicitly stated in the knowledge document, or cannot be directly and conservatively inferred from it, reply with exactly: "${refusal}"`,
    "Do not use owner identity, workspace persona files, MEMORY.md, prior XMTP replies, or general world knowledge to fill gaps.",
    "If previous session history conflicts with the knowledge document, ignore that history and follow the knowledge document.",
    "",
    "Trusted knowledge document:",
    "```md",
    knowledge.content,
    "```",
  ].join("\n");
}

export const XMTP_ROUTING_DM_SCOPE = "per-account-channel-peer";
