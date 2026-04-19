import type { Agent } from "@xmtp/agent-sdk";

// 后端返回的 task 信息（ACCEPTED 及之后状态）
export interface TaskInfo {
  taskId: string;
  providerAgentId: string;
  requestorAgentId: string;
}

// 内存中维护的 task → group 映射条目
export interface TaskGroupEntry {
  taskId: string;
  peerAddress: string;
  groupId: string;
}

export class RecoveryManager {
  private taskGroupMap = new Map<string, TaskGroupEntry>();

  constructor(private agent: Agent) {}

  /**
   * daemon 启动时调用，重建 task → group 路由表：
   * 1. 从后端获取当前 agent 参与的 ACCEPTED+ task 列表（当前为占位）
   * 2. 在 XMTP 本地 DB 中查找与这些 task 匹配的 group
   * 3. 将映射写入内存，供 daemon.getTaskGroupMap() 查询
   *
   * 注:不再做 pending 消息恢复——所有未消费消息由 LLM 通过
   * xmtp_get_pending_list 主动 PULL,水位由 WatermarkStore 持久化跟踪。
   */
  async rebuild(): Promise<void> {
    const tasks = await this.fetchActiveTasks();

    await this.agent.client.conversations.sync();
    const groups = await this.agent.client.conversations.listGroups();

    this.taskGroupMap.clear();

    const myAddress = this.agent.address?.toLowerCase() ?? "";

    for (const task of tasks) {
      const peerAddress =
        task.providerAgentId.toLowerCase() === myAddress
          ? task.requestorAgentId.toLowerCase()
          : task.providerAgentId.toLowerCase();

      const expectedName = `${task.taskId}::${peerAddress}`;
      const group = groups.find((g) => g.name === expectedName);

      if (group) {
        this.taskGroupMap.set(task.taskId, {
          taskId: task.taskId,
          peerAddress,
          groupId: group.id,
        });
      }
    }

    console.log(
      `[recovery] rebuild complete | tasks=${tasks.length} matched=${this.taskGroupMap.size}`
    );
  }

  getTaskGroupMap(): ReadonlyMap<string, TaskGroupEntry> {
    return this.taskGroupMap;
  }

  // TODO: 后端 API 接口文档确认后实现。
  // 应返回当前 agent（this.agent.address）作为 provider 或 requestor、
  // 且状态为 ACCEPTED 及之后的所有 task。
  private async fetchActiveTasks(): Promise<TaskInfo[]> {
    return [];
  }
}
