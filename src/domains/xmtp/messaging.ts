import type { Agent } from "@xmtp/agent-sdk";
import { encodeText } from "@xmtp/node-sdk";
import type { EncodedContent } from "@xmtp/node-bindings";

type EthAddress = `0x${string}`;
type Group = Awaited<ReturnType<Agent["createGroupWithAddresses"]>>;
type DecodedMessage = Awaited<ReturnType<Group["messages"]>>[number];

export type { EncodedContent };

export class MessagingToolkit {
  private groupCache = new Map<string, Group>();

  constructor(private agent: Agent) {}

  private cacheKey(taskId: string, peerAddress: EthAddress): string {
    return `${taskId}::${peerAddress.toLowerCase()}`;
  }

  async getOrOpenGroup(taskId: string, peerAddress: EthAddress): Promise<Group> {
    const key = this.cacheKey(taskId, peerAddress);
    const cached = this.groupCache.get(key);
    if (cached) return cached;

    const groupName = key;
    await this.agent.client.conversations.sync();
    const groups = await this.agent.client.conversations.listGroups();
    const existing = groups.find((g) => g.name === groupName);
    if (existing) {
      this.groupCache.set(key, existing);
      return existing;
    }

    const group = await this.agent.createGroupWithAddresses([peerAddress], {
      groupName,
    });
    this.groupCache.set(key, group);
    return group;
  }

  async send(
    taskId: string,
    content: EncodedContent,
    peerAddress: EthAddress
  ): Promise<{ conversationId: string; messageId: string }> {
    const group = await this.getOrOpenGroup(taskId, peerAddress);
    const messageId = await group.send(content);
    return { conversationId: group.id, messageId };
  }

  async sendText(
    taskId: string,
    text: string,
    peerAddress: EthAddress
  ): Promise<{ conversationId: string; messageId: string }> {
    return this.send(taskId, encodeText(text), peerAddress);
  }

  /**
   * 发送结构化 payload：{ text, metadata }。
   * 当前实现把 envelope 序列化为 JSON 文本发送（仍走 text codec）。
   * 未来可注册自定义 XMTP contentType 以原生携带结构化数据。
   */
  async sendStructured(
    taskId: string,
    payload: { text: string; metadata?: Record<string, unknown> },
    peerAddress: EthAddress
  ): Promise<{ conversationId: string; messageId: string }> {
    // 自动注入 taskId 到 metadata，作为 group.name 的冗余校验源。
    // 信任序：接收侧 group.name > metadata.taskId（group.name 创建时固定，不可伪造；
    // metadata 可被发送方篡改，仅用作可观测性与一致性校验）。
    const metadata = { ...(payload.metadata ?? {}), taskId };
    const envelope = JSON.stringify({ text: payload.text, metadata });
    return this.send(taskId, encodeText(envelope), peerAddress);
  }

  /**
   * 尝试把收到的文本解析为结构化 envelope。
   * 兼容纯文本：若不是合法 JSON 或缺字段则回退为 { text: raw, metadata: {} }。
   */
  static parseStructured(raw: string): { text: string; metadata: Record<string, unknown> } {
    if (!raw.startsWith("{")) return { text: raw, metadata: {} };
    try {
      const obj = JSON.parse(raw);
      if (typeof obj?.text === "string") {
        return { text: obj.text, metadata: obj.metadata ?? {} };
      }
    } catch {
      /* fallthrough */
    }
    return { text: raw, metadata: {} };
  }

  async getPendingMessages(
    options?: { since?: Date }
  ): Promise<Map<string, DecodedMessage[]>> {
    await this.agent.client.conversations.sync();
    const groups = await this.agent.client.conversations.listGroups();
    const result = new Map<string, DecodedMessage[]>();

    for (const group of groups) {
      await group.sync();
      const msgs = await group.messages({
        sentAfterNs: options?.since
          ? BigInt(options.since.getTime()) * 1_000_000n
          : undefined,
      });
      if (msgs.length > 0) {
        result.set(group.name, msgs);
      }
    }
    return result;
  }

  async getHistory(
    taskId: string,
    peerAddress: EthAddress,
    options?: { limit?: number }
  ): Promise<DecodedMessage[]> {
    const group = await this.getOrOpenGroup(taskId, peerAddress);
    await group.sync();
    return group.messages({ limit: options?.limit });
  }
}
