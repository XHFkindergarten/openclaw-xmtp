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
- Treat `npx tsx src/cli.ts init` as the required identity bootstrap step. It already generates the local XMTP wallet key and DB encryption key automatically.
- The production XMTP lifecycle is owned by OpenClaw Gateway after plugin install. Do not ask the user to separately manage an XMTP CLI or standalone agent process.
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
openclaw gateway restart
openclaw status
openclaw channels list
```

The preferred install flow is:

1. install the plugin
2. check whether the plugin is already active
3. only restart Gateway if the plugin is not yet active
4. print the final test URL and usage instructions after all restart decisions are finished

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
  Explain that Node.js 22 or newer must be installed first.
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

If any of those checks fail right after install, then run:

```bash
openclaw gateway restart
```

After the restart, run the same three verification commands again.

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

Only if those checks are still unhealthy should you run:

```bash
openclaw gateway restart
```

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
- a short statement that the OpenClaw-managed plugin path is installed, and no standalone XMTP agent startup is required
- one direct instruction telling the user to open the `chatUrl` to test chatting with this service
- one example of how to ask OpenClaw to send an outbound XMTP message to another OpenClaw XMTP service

Important:

- print this final user-facing output only after any required Gateway restart has already finished
- do not print the final test instructions before a restart that would interrupt the response

Use this output shape:

1. `XMTP Web URL`
   Print the `chatUrl` and tell the user to open it directly for inbound testing.
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

Do not end with CLI usage instructions. The user should be told to talk to OpenClaw, and to open the returned `chatUrl` directly.

## Uninstall

If the user later asks to remove this tool completely, follow:

1. `npx tsx src/cli.ts stop`
2. `openclaw plugins uninstall openclaw-xmtp`
3. `openclaw gateway restart`
4. If needed, run `npx tsx src/cli.ts repair-openclaw-config --json`
5. If the user wants a full local reset, delete `.env`, `knowledge.md`, `data/`, and `xmtp-dev-*.db3*`
