import { randomUUID } from "node:crypto";

import { XMTP_CHANNEL_ID } from "./config.js";

export type XMTPInboundMessage = {
  from: string;
  content: string;
  conversationId: string;
  timestamp: number;
  messageId?: string;
};

export type XMTPMsgContext = {
  Body: string;
  From: string;
  To: string;
  AccountId: string;
  GroupSystemPrompt?: string;
  OriginatingChannel: typeof XMTP_CHANNEL_ID;
  OriginatingTo: string;
  MessageSid: string;
  Timestamp?: number;
  Provider: typeof XMTP_CHANNEL_ID;
  ChatType: "direct";
  SessionKey?: string;
  ConversationId: string;
};

export function buildXMTPMessageKey(message: XMTPInboundMessage): string {
  return message.messageId
    ? `${message.conversationId}:${message.messageId}`
    : `${message.conversationId}:${message.from}:${message.timestamp}:${message.content}`;
}

export function xmtpMessageToMsgContext(
  message: XMTPInboundMessage,
  accountId: string,
): XMTPMsgContext {
  return {
    Body: message.content,
    From: message.from,
    To: message.from,
    AccountId: accountId,
    OriginatingChannel: XMTP_CHANNEL_ID,
    OriginatingTo: message.from,
    MessageSid: message.messageId ?? `openclaw-xmtp-${randomUUID()}`,
    Timestamp: message.timestamp,
    Provider: XMTP_CHANNEL_ID,
    ChatType: "direct",
    ConversationId: message.conversationId,
  };
}
