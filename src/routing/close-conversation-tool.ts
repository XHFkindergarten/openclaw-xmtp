/**
 * close_conversation agent tool factory。
 *
 * 触发场景：
 *   - agent 判断当前任务沟通已结束，主动调用以释放 ConversationTracker 席位
 *   - 让出并发槽位给排队中的其它 (taskId, peerAddress)
 *
 * 参数：
 *   - taskId: 要关闭的任务 ID
 *   - peerAddress: 对手方 EVM 地址
 *
 * 查找 daemon：遍历 activeInstalls，向每个 install.daemon 调用 closeConversation，
 * 命中一个即成功。未来多钱包场景下可按 sessionKey 的 accountId 精准定位。
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAgentTool = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OpenClawPluginToolContext = any;

export interface DaemonLike {
  closeConversation(taskId: string, peerAddress: string): boolean;
}

export function buildCloseConversationTool(
  getDaemons: () => Iterable<DaemonLike>
): (ctx: OpenClawPluginToolContext) => AnyAgentTool {
  return (_ctx) => ({
    name: "close_conversation",
    label: "Close Conversation",
    description:
      "Release the conversation seat for a given (taskId, peerAddress). " +
      "Call this when the current task has finished its A2A exchange, so other tasks can proceed.",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task ID to close" },
        peerAddress: {
          type: "string",
          description: "Counterparty EVM address (0x-prefixed)",
        },
      },
      required: ["taskId", "peerAddress"],
    },
    execute: async (_toolCallId: string, params: { taskId: string; peerAddress: string }) => {
      let closed = false;
      for (const d of getDaemons()) {
        if (d.closeConversation(params.taskId, params.peerAddress)) {
          closed = true;
          break;
        }
      }
      const text = closed
        ? `Closed conversation: taskId=${params.taskId} peer=${params.peerAddress}`
        : `No active conversation matched: taskId=${params.taskId} peer=${params.peerAddress}`;
      return {
        content: [{ type: "text", text }],
        details: { closed, taskId: params.taskId, peerAddress: params.peerAddress },
      };
    },
  });
}
