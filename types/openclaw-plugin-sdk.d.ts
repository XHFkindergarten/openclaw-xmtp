declare module "openclaw/plugin-sdk" {
  export type OpenClawConfig = Record<string, any>;

  export type ChannelAccountSnapshot = Record<string, any>;

  export type PluginRuntime = {
    channel: {
      media: {
        saveMediaBuffer: (...args: any[]) => Promise<any>;
      };
      commands: any;
      routing: {
        resolveAgentRoute: (params: any) => {
          agentId?: string;
          sessionKey?: string;
          mainSessionKey?: string;
        };
      };
      session: {
        resolveStorePath: (store: any, params: any) => string;
        recordInboundSession: (params: any) => Promise<void>;
      };
      reply: {
        finalizeInboundContext: (ctx: any) => any;
        resolveHumanDelayConfig: (cfg: any, agentId?: string) => any;
        createReplyDispatcherWithTyping: (params: any) => {
          dispatcher: any;
          replyOptions: any;
          markDispatchIdle: () => void;
        };
        withReplyDispatcher: (params: { dispatcher: any; run: () => Promise<any> }) => Promise<any>;
        dispatchReplyFromConfig: (params: any) => Promise<any>;
      };
    };
  };

  export type OpenClawPluginApi = {
    id?: string;
    name?: string;
    version?: string;
    description?: string;
    source?: string;
    config?: Record<string, any>;
    pluginConfig?: Record<string, unknown>;
    logger?: {
      debug?: (message: string) => void;
      info?: (message: string) => void;
      warn?: (message: string) => void;
      error?: (message: string) => void;
    };
    runtime?: PluginRuntime;
    registerChannel: (params: { plugin: any }) => void;
    registerCli?: (register: any, params?: any) => void;
    on?: (hookName: string, handler: (event: any) => any, opts?: { priority?: number }) => void;
  };

  export type ChannelPlugin<TAccount = any> = {
    id: string;
    meta: Record<string, any>;
    configSchema?: Record<string, any>;
    capabilities?: Record<string, any>;
    messaging?: Record<string, any>;
    agentPrompt?: Record<string, any>;
    reload?: Record<string, any>;
    config?: Record<string, any>;
    outbound?: Record<string, any>;
    status?: Record<string, any>;
    auth?: Record<string, any>;
    gateway?: Record<string, any>;
  };

  export function buildChannelConfigSchema(schema: Record<string, any>): Record<string, any>;
}

declare module "openclaw/plugin-sdk/core" {
  export type OpenClawConfig = Record<string, any>;
}
