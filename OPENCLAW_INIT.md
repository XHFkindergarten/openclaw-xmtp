# openclaw-xmtp Initialization Playbook

This is the single document to hand to OpenClaw.

Goal:

- install and initialize this repository from zero
- install and enable the `openclaw-xmtp` OpenClaw plugin
- verify the channel is healthy
- print the final `chatUrl`
- give the user a direct XMTP Web test URL and one outbound chat demo for messaging another XMTP service

The final deliverable for the user is the `chatUrl` returned by:

```bash
npx tsx src/cli.ts status --json
```

OpenClaw must print that exact URL to the user at the end.

## Rules

- Use the fixed repository path `~/.openclaw/repos/openclaw-xmtp`.
- Run all repository commands from `~/.openclaw/repos/openclaw-xmtp`.
- Do not claim success until the OpenClaw channel is healthy and `status --json` returns an `address` and `chatUrl`.
- If a hard prerequisite is missing, stop and explain the blocker instead of guessing.
- Treat the `chatUrl` from the status endpoint as the only canonical final link to return.
- Do not install `@xmtp/cli`, do not install any `xmtp-cli` skill pack, and do not tell the user to use raw XMTP CLI commands. This repository already embeds XMTP through `@xmtp/agent-sdk`.
- XMTP versions are already pinned in this repository to avoid a bad upstream native binding release. Tell users to run plain `npm install` and do not suggest changing XMTP package versions manually.
- Treat `npx tsx src/cli.ts init` as the required identity bootstrap step. It already generates the local XMTP wallet key and DB encryption key automatically.
- The production XMTP lifecycle is owned by OpenClaw Gateway after plugin install. Do not ask the user to separately manage an XMTP CLI or standalone agent process.
- Never run `openclaw gateway restart` from inside the active installation conversation. If a restart is required, stop and tell the user to run it manually in their own terminal.
- During installation, do not run `npx tsx src/cli.ts start`, `xmtp-agent start`, `npx tsx src/cli.ts inbox`, or `npx tsx src/cli.ts send`. Those are debug-only paths and are not part of normal plugin setup.
- Do not modify `package.json`, the package `bin` field, or other source files while installing. Installation is a verification task, not a code-fixing task.
- Do not inspect or kill old XMTP agent processes from other repositories unless this repository's own status checks prove there is a real conflict. Ignore unrelated old repos and stale experiments.
- A plugin install warning about local bindings is not by itself a blocker. Only treat it as a blocker if `openclaw status` does not show `openclaw-xmtp` as enabled/OK or if `status --json` has no `address`/`chatUrl`.

## Allowed Commands For Installation

Only use commands from this list unless a documented recovery path below requires more:

```bash
npm install
npx tsx src/cli.ts preflight --json
npx tsx src/cli.ts init
npx tsx src/cli.ts status --json
npx tsx src/cli.ts repair-openclaw-config --json
openclaw plugins install ~/.openclaw/repos/openclaw-xmtp
openclaw plugins uninstall openclaw-xmtp
openclaw status
openclaw channels list
```

`openclaw gateway restart` is not an allowed command for OpenClaw to execute during the active installation conversation. If a restart is required, OpenClaw must stop and instruct the user to run it manually in their own terminal.

The preferred install flow is:

1. install the plugin
2. check whether the plugin is already active
3. if the plugin is not yet active, tell the user to run `openclaw gateway restart` manually in their own terminal and do not run it for them
4. after that, tell the user exactly how to obtain the XMTP Web test URL and how to ask OpenClaw to send an XMTP message

## Phase 0: Repository Placement

The repository must live at:

```bash
~/.openclaw/repos/openclaw-xmtp
```

If it is not there yet, put it there first:

```bash
mkdir -p ~/.openclaw/repos
cd ~/.openclaw/repos
git clone <repo-url> openclaw-xmtp
cd ~/.openclaw/repos/openclaw-xmtp
```

If the repository already exists elsewhere, move it to this exact path before continuing.

## Phase 1: Preflight

Run:

```bash
npx tsx src/cli.ts preflight --json
```

Interpret the result.

### Hard blockers

- `node.ok = false`
  Explain that Node.js 22 LTS or 24 LTS must be installed first.
- `npm.ok = false` or `npx.ok = false`
  Explain that the Node.js installation is incomplete and must be repaired first.
- `openclaw.ok = false`
  Explain that OpenClaw itself must be installed before this repository can provide automatic XMTP replies.

Do not continue past hard blockers.

### Soft blockers

- `dependencies.ok = false`
  Run `npm install`.
- `envFile.ok = false` or `knowledgeFile.ok = false`
  Run `npx tsx src/cli.ts init`. This step automatically creates the XMTP wallet key, DB encryption key, and local runtime files.
- `agent.running = false`
  This is not a blocker. In production mode the gateway owns XMTP runtime startup after the plugin is installed.

## Phase 2: Repository Initialization

If dependencies are missing:

```bash
npm install
```

Initialize local files:

```bash
npx tsx src/cli.ts init
```

This step already completes local XMTP identity bootstrap. It creates:

- the XMTP wallet private key
- the XMTP DB encryption key
- `knowledge.md`
- runtime data directories

Do not ask the user to manually create a wallet or encryption key after this step.

Then inspect `knowledge.md`.

The generated file lives under the XMTP base directory reported by `preflight --json`.
By default that is `~/.openclaw/state/openclaw-xmtp/runtime/knowledge.md`.

- If it still contains placeholder text, tell the user they must replace the placeholder knowledge before they expect meaningful replies.
- If the user wants installation only, continue anyway.

## Phase 3: Install OpenClaw Plugin

Install this repository into OpenClaw:

```bash
openclaw plugins install ~/.openclaw/repos/openclaw-xmtp
```

Then verify before restarting:

```bash
openclaw status
openclaw channels list
npx tsx src/cli.ts status --json
```

If all of the following are already true, do not restart Gateway:

- `openclaw-xmtp` appears in channel listings
- channel state is `OK`
- `status --json` returns `address`
- `status --json` returns `chatUrl`

If any of those checks fail right after install, do not restart Gateway from inside the current installation conversation.

Instead, tell the user to run this manually in their own terminal:

```bash
openclaw gateway restart
```

Then tell the user to run the same three verification commands again:

```bash
openclaw status
openclaw channels list
npx tsx src/cli.ts status --json
```

Required success state:

- `openclaw-xmtp` appears in channel listings
- channel state is `OK`
- `status --json` returns `address`
- `status --json` returns `chatUrl`
- if `running = false` in CLI output, that is acceptable before the first inbound message; do not treat it as a failure if OpenClaw status is `OK`
- if plugin install or gateway restart prints a local-binding warning, that is acceptable as long as the three checks above are healthy

### Do not escalate to debug mode during install

If the checks above are healthy, stop there.

Do not do any of the following during normal installation:

- do not run `openclaw gateway restart` yourself from the active installation conversation
- do not start a standalone XMTP agent
- do not inspect PID lists for old `xmtp-agent` processes from other repositories
- do not patch `package.json`
- do not try to make the CLI `bin` executable path work as part of installation
- do not treat `running = false` as a reason to manually start anything

### If install fails because plugin already exists

Do this:

```bash
openclaw plugins uninstall openclaw-xmtp
rm -rf ~/.openclaw/extensions/openclaw-xmtp
npx tsx src/cli.ts repair-openclaw-config --json
openclaw plugins install ~/.openclaw/repos/openclaw-xmtp
```

Then verify with:

```bash
openclaw status
openclaw channels list
npx tsx src/cli.ts status --json
```

Only if those checks are still unhealthy should you tell the user to run manually in their own terminal:

```bash
openclaw gateway restart
```

Prefer telling the user to run that restart manually after the current installation response ends.

### If install fails because `openclaw.json` contains stale `openclaw-xmtp` records

Run:

```bash
npx tsx src/cli.ts repair-openclaw-config --json
openclaw plugins install ~/.openclaw/repos/openclaw-xmtp
```

Then verify with:

```bash
openclaw status
openclaw channels list
npx tsx src/cli.ts status --json
```

Only if those checks are still unhealthy should you run:

```bash
openclaw gateway restart
```

Prefer telling the user to run that restart manually after the current installation response ends.

## Phase 4: Optional Validation

Repository validation:

```bash
npm run typecheck
npm run test:plugin
```

Live end-to-end validation:

```bash
npm run test:live
```

If `test:live` ends with `"stage":"reply"`, the automatic reply chain is confirmed.

## Final Output To User

At the end, OpenClaw must run:

```bash
npx tsx src/cli.ts status --json
```

Then print:

- the agent `address`
- the final `chatUrl`
- a short statement that wallet and key creation were already completed automatically during `init`
- either:
  - a short statement that the OpenClaw-managed plugin path is installed, and no standalone XMTP agent startup is required
  - or a short statement that the plugin install is complete but the user should now run `openclaw gateway restart` manually because restarting inside the current session may interrupt output
- one direct instruction telling the user to open the `chatUrl` to test chatting with this service
- one example of how to ask OpenClaw to send an outbound XMTP message to another OpenClaw XMTP service

Important:

- if the plugin is already active, print the final user-facing output immediately
- if manual Gateway restart is still needed, print the restart instruction first, then print the exact post-restart commands the user should run to get the final `chatUrl`
- do not let the current installation conversation end without telling the user both:
  - how to get the XMTP Web test URL after restart
  - how to ask OpenClaw to send an XMTP message after restart

Use this output shape:

1. `XMTP Web URL`
   If `chatUrl` is already available, print it and tell the user to open it directly for inbound testing.
   If a manual restart is still needed, tell the user:

```text
重启后运行：
npx tsx src/cli.ts status --json
```

   Then explain that the `chatUrl` field in that output is the XMTP Web test URL to open.
2. `How to send to another XMTP service`
   Tell the user they need:
   - a target XMTP address or inboxId
   - the text to send
3. `Demo`
   Provide one concrete natural-language example like:

```text
请通过 openclaw-xmtp 给 0x1234567890abcdef1234567890abcdef12345678 发消息：
你好，我是通过 OpenClaw 的 XMTP 服务发起的测试消息。请告诉我你的专业领域。
```

If manual restart is still needed, append this exact guidance before ending:

```text
如果你刚执行了 openclaw gateway restart，请在重启完成后回到这个仓库目录，运行：
npx tsx src/cli.ts status --json

然后：
1. 打开其中的 chatUrl 做 Web 测试
2. 回到 OpenClaw，对它说上面的示例消息，让它通过 openclaw-xmtp 主动发起聊天
```

## Uninstall

If the user later asks to remove this tool completely, follow:

1. `npx tsx src/cli.ts stop`
2. `openclaw plugins uninstall openclaw-xmtp`
3. `openclaw gateway restart`
4. If needed, run `npx tsx src/cli.ts repair-openclaw-config --json`
5. If the user wants a full local reset, delete `.env`, `knowledge.md`, `data/`, and `xmtp-dev-*.db3*`
