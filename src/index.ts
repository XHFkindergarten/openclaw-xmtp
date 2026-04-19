import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import { encodeText } from "@xmtp/node-sdk";
import { z } from "zod";

import type {
  ChannelPlugin,
  OpenClawPluginService,
  PluginRuntime,
  RuntimeLogger,
} from "openclaw/plugin-sdk/core";

import { initXmtpInstall, type XmtpInstall } from "./bootstrap/init-xmtp-install.js";
import { decodePeerId } from "./routing/peer-id.js";
import { buildCloseConversationTool } from "./routing/close-conversation-tool.js";
import { buildGetPendingListTool } from "./routing/get-pending-list-tool.js";
import { buildSendTool } from "./routing/send-tool.js";

// extension 根目录。依赖 tsconfig outDir 把编译产物放在 <ext>/dist/，
// 所以运行时 dist/index.js 的 "../" 就是扩展根。
// 注意：若修改 outDir 嵌套层级，这里要跟着调。
// PluginRuntime 未暴露 extension path，故暂用 import.meta.url 方案。
const EXTENSION_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ── runtime 捕获 ───────────────────────────────────────────────────────
// setRuntime 在 host 调 register(api) 时最先触发，
// 把 runtime 存到模块级变量，供 log / 其它工具用。
// 触发可能发生两次（cli-metadata + full），以最后一次为准（覆盖即可）。
let runtimeRef: PluginRuntime | null = null;
let pluginLogger: RuntimeLogger | null = null;

function getLogger(): { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void } {
  if (pluginLogger) return pluginLogger;
  // 在 runtime 就绪前的 fallback（例如模块顶层探针）
  return {
    info: (m) => console.log(m),
    warn: (m) => console.warn(m),
    error: (m) => console.error(m),
  };
}

// TODO: 发布前删除 —— 调试探针：验证 index.ts 被 OpenClaw host 导入
console.log(`[a2a-xmtp:register] module loaded (root=${EXTENSION_ROOT}) @ ${new Date().toISOString()}`);

// 每个 OpenClaw accountId 对应一个活跃的 XMTP 安装实例
const activeInstalls = new Map<string, XmtpInstall>();

// ── 可配置字段（对应 ~/.openclaw/openclaw.json 的 channels.a2a-xmtp.config）──
const A2aXmtpConfigSchema = z.object({
  env: z.enum(["dev", "production"]).default("dev"),
  dbBaseDir: z.string().optional(),
  mainAccount: z.string().default("alice"),
});
type A2aXmtpConfig = z.infer<typeof A2aXmtpConfigSchema>;

function readChannelConfig(cfg: unknown): A2aXmtpConfig {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = (cfg as any)?.channels?.["a2a-xmtp"]?.config ?? {};
  const parsed = A2aXmtpConfigSchema.safeParse(raw);
  return parsed.success ? parsed.data : A2aXmtpConfigSchema.parse({});
}

// gateway 启动时一次性初始化所有钱包的 XMTP client（幂等）
//
// 触发顺序（先到先得，cache 后续直接复用）：
//   1. daemonService.start  ← 主路径，ctx.stateDir 由 host 派发
//   2. lifecycle.runStartupMaintenance  ← fallback，仅在 service 注册失败时命中
//   3. startAccount  ← 二次 fallback
//
// dataDir 一致性：service.start 把 ctx.stateDir 解析后写入 resolvedDataDir，
// 后续 fallback 必须读这个值——否则 service 失败后 fallback 用孤立目录加载空 watermark，
// 历史消息会被当成"未消费"重放给 LLM。
let startupInitPromise: Promise<void> | null = null;
let resolvedDataDir: string | null = null;

function ensureStartupInit(cfg: unknown, hostStateDir?: string): Promise<void> {
  if (startupInitPromise) return startupInitPromise;
  const chCfg = readChannelConfig(cfg);
  const log = getLogger();
  // 优先级：用户配置 > service.start 已解析的目录 > 本次 host stateDir > 扩展根 data
  // 一旦确定就缓存到模块顶层，所有 fallback 路径读相同值。
  const baseDir =
    chCfg.dbBaseDir ??
    resolvedDataDir ??
    hostStateDir ??
    resolve(EXTENSION_ROOT, "data");
  resolvedDataDir = baseDir;
  startupInitPromise = (async () => {
    const installs = await initXmtpInstall({
      env: chCfg.env,
      mainAccount: chCfg.mainAccount,
      dbBaseDir: baseDir,
      log: (m) => log.info(m),
    });
    for (const install of installs) {
      activeInstalls.set(install.accountName, install);
    }
    // TODO: 发布前删除 —— 调试探针：验证 lifecycle 初始化完成
    log.info(
      `[a2a-xmtp:lifecycle] startup init complete | installs=${installs.length} dbBaseDir=${baseDir}`
    );
  })();
  return startupInitPromise;
}

// daemonService.stop 主调入口：遍历所有 install 做 graceful stop，
// 确保最后一笔 watermark.ack 已 sync 落盘（防止 host 主动停机时丢数据）。
// daemon.stop 内部已加幂等保护，重复调用安全。
async function shutdownAll(reason: string): Promise<void> {
  const log = getLogger();
  if (activeInstalls.size === 0) return;
  log.info(`[a2a-xmtp:lifecycle] shutdown (${reason}) | installs=${activeInstalls.size}`);
  for (const [name, install] of activeInstalls) {
    try {
      await install.daemon.stop();
    } catch (err) {
      log.warn(`[a2a-xmtp:lifecycle] daemon ${name} stop failed: ${String(err)}`);
    }
  }
  activeInstalls.clear();
  startupInitPromise = null;
}

// host 调度：gateway start → service.start；gateway stop → 反向 service.stop。
// 比 lifecycle.runStartupMaintenance 多两个收益：
//   1. graceful stop —— host 主动 await stop()，不依赖 process signal
//   2. ctx.stateDir 由 host 派发，避免硬编码 EXTENSION_ROOT/data
const daemonService: OpenClawPluginService = {
  id: "a2a-xmtp.daemon",
  start: async (ctx) => {
    const dataDir = join(ctx.stateDir, "a2a-xmtp");
    await ensureStartupInit(ctx.config, dataDir);
  },
  stop: async () => {
    await shutdownAll("service.stop");
  },
};

type XmtpAccount = { accountId: string };

const plugin: ChannelPlugin<XmtpAccount> = {
  id: "a2a-xmtp",
  meta: {
    id: "a2a-xmtp",
    label: "A2A XMTP",
    selectionLabel: "A2A XMTP",
    docsPath: "channels/a2a-xmtp",
    blurb: "Agent-to-Agent messaging over XMTP",
    order: 80,
  },
  capabilities: {
    chatTypes: ["direct"],
  },
  config: {
    // TODO: 接入真实 agents 配置后，accountId 应取自 agent.agentId
    // 领域模型：wallet(1) ──< agent(N) ──(1:1)── xmtpAddress
    //   accountId ↔ agentId ↔ xmtpAddress ↔ XMTP Agent 实例（四位 1:1:1:1）
    // 当前测试数据硬编码 "alice"，真实数据应从 openclaw.json 的 agents 字段读出。
    listAccountIds: (_cfg) => ["alice"],
    resolveAccount: (_cfg, accountId) => ({ accountId: accountId ?? "alice" }),
    isConfigured: () => true,
    isEnabled: () => true,
  },
  lifecycle: {
    // Fallback：daemonService.start 是主路径（在 registerFull 注册）。
    // 这里仅作兜底——若 service 注册/启动失败，channel 自维护阶段还能补一次。
    // ensureStartupInit 幂等：service.start 已跑过则直接返回缓存 promise。
    runStartupMaintenance: async ({ cfg }) => {
      await ensureStartupInit(cfg);
    },
  },
  gateway: {
    // Pull 模型：入站消息由 XMTP DB 持久化 + WatermarkStore 跟踪水位,
    // LLM 通过 xmtp_get_pending_list 主动 PULL。这里仅确保对应钱包的 XMTP install 已初始化。
    startAccount: async (ctx) => {
      await ensureStartupInit(ctx.cfg);
      const install = activeInstalls.get(ctx.accountId) ?? activeInstalls.values().next().value;
      if (!install) {
        ctx.log?.error(`[a2a-xmtp] 未找到账户 ${ctx.accountId} 的安装实例`);
        return;
      }
      ctx.log?.info(`[a2a-xmtp] 账户 ${ctx.accountId} (${install.address ?? "unknown"}) 已就绪`);
    },

    stopAccount: async (ctx) => {
      ctx.log?.info(`[a2a-xmtp] 账户 ${ctx.accountId} stop（client 由 lifecycle 管理）`);
    },
  },

  outbound: {
    // "gateway" 模式：AI 回复经由 dispatchInboundDirectDmWithRuntime 的 deliver 回调发出，
    // 此 sendText 仅处理 OpenClaw 主动发起的出站消息（非 AI 回复）。
    deliveryMode: "gateway",
    sendText: async (ctx) => {
      const install = activeInstalls.get(ctx.accountId ?? "alice");
      if (!install) {
        throw new Error(`[a2a-xmtp] 账户 ${ctx.accountId} 无活跃安装实例`);
      }
      // ctx.to 可能是裸地址（OpenClaw 主动发起）或编码后的 peer.id（AI 回复路径）。
      // 统一走 decode：无 query 参数时 taskId 退化为 peerAddress（保持旧行为）。
      const { address, params } = decodePeerId(ctx.to);
      const taskId = params.taskId ?? address;
      await install.daemon.sendMessage(taskId, encodeText(ctx.text), address);
      return { channel: "a2a-xmtp" as const, messageId: `${Date.now()}` };
    },
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const entry: any = defineChannelPluginEntry({
  id: "a2a-xmtp",
  name: "A2A XMTP",
  description: "OKX A2A XMTP communication channel (Agent-to-Agent messaging over XMTP)",
  plugin,
  configSchema: buildChannelConfigSchema(A2aXmtpConfigSchema),
  // setRuntime 在 host 调用 register(api) 的第一步就会触发，
  // 无论 registrationMode 是 "cli-metadata" 还是 "full" 都会执行（可能两次）。
  // 必须幂等：只做赋值，不做 IO。
  setRuntime: (runtime) => {
    runtimeRef = runtime;
    pluginLogger = runtime?.logging?.getChildLogger?.({ subsystem: "a2a-xmtp" }) ?? null;
    // TODO: 发布前删除 —— 调试探针：验证 register() 被 host 调用
    console.log(
      `[a2a-xmtp:register] register() invoked | runtime.version=${runtime?.version ?? "unknown"} @ ${new Date().toISOString()}`
    );
  },
  // registerFull：完整 runtime 模式下注册全局 agent tool 和后台 service（cli-metadata 模式不会执行）。
  // - daemonService：host 在 gateway start/stop 时托管 daemon 生命周期，确保 graceful stop。
  // - close_conversation 让 agent 能主动释放 ConversationTracker 席位。
  // - xmtp_get_pending_list 是 LLM PULL 入口，自动推进水位、对外不暴露 ack 概念。
  registerFull: (api) => {
    api.registerService(daemonService);
    api.registerTool(
      buildCloseConversationTool(() =>
        Array.from(activeInstalls.values()).map((i) => i.daemon)
      )
    );
    api.registerTool(
      buildGetPendingListTool(() =>
        Array.from(activeInstalls.values()).map((i) => ({
          agent: i.daemon.getAgent(),
          renderer: i.daemon.getRenderer(),
          filter: i.daemon.getFilter(),
          watermarks: i.daemon.getWatermarks(),
        }))
      )
    );
    api.registerTool(
      buildSendTool(
        () => Array.from(activeInstalls.values()).map((i) => i.daemon),
        () => runtimeRef
      )
    );
  },
});
export default entry;

// 防止未使用变量告警（runtimeRef 保留给后续扩展使用）
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _runtimeRefKeepalive = () => runtimeRef;
