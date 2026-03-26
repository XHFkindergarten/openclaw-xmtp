---
name: xmtp-openclaw-installer
description: This skill should be used when the user asks to "install XMTP for OpenClaw", "set up openclaw-xmtp", "initialize the XMTP plugin", "configure XMTP agent", "test XMTP replies", "troubleshoot openclaw-xmtp", "uninstall openclaw-xmtp", or wants OpenClaw to manage this repository as an XMTP messaging channel.
metadata: {"clawdbot":{"emoji":"📡","requires":{"bins":["node","npm"]}}}
version: 1.0.0
---

# openclaw-xmtp

Initialize this repository as an XMTP channel bridge for OpenClaw.
Treat the OpenClaw plugin as the only supported automatic-reply path.
Do not use or revive the deprecated raw Gateway WebSocket design.
Do not install generic XMTP CLI tools or skill packs as part of this workflow.
Do not switch into standalone-agent debugging during normal installation.

## Purpose

Use this repository when OpenClaw needs to:

- install an XMTP channel backed by `@xmtp/agent-sdk`
- install the `openclaw-xmtp` channel plugin into a local OpenClaw instance
- initialize local secrets and `knowledge.md`
- validate end-to-end XMTP receive/reply behavior
- uninstall the plugin and remove all local state

If a single document is preferred over the skill plus references, read `OPENCLAW_INIT.md`.

## Working Directory

Use the fixed repository path `~/.openclaw/repos/openclaw-xmtp`.
Run all repository commands from `~/.openclaw/repos/openclaw-xmtp`.
Resolve all relative paths against that directory.

## Preflight

Start with:

```bash
npx tsx src/cli.ts preflight --json
```

Interpret the result before taking action.

- If `ok` is `false` because Node.js is missing or older than 22, stop and ask the user to install a compatible Node.js release first.
- If `npm` or `npx` is missing, stop and ask the user to repair the Node.js installation first.
- If `node_modules` is missing, run `npm install`.
- If `.env` or `knowledge.md` is missing, run `npx tsx src/cli.ts init`.
- `npx tsx src/cli.ts init` already auto-generates the XMTP wallet key and DB encryption key. Do not ask the user to create wallet/key material manually.
- If `openclaw` is missing and the user wants automatic OpenClaw replies, stop and ask the user to install OpenClaw first.

For detailed install decisions, read `references/install.md`.

## Install Workflow

Follow this order:

1. Run `npx tsx src/cli.ts preflight --json`.
   If the repository is not at `~/.openclaw/repos/openclaw-xmtp`, move or clone it there before continuing.
2. If dependencies are missing, run `npm install`.
3. Run `npx tsx src/cli.ts init`.
4. Ask the user to edit `knowledge.md` if it still contains placeholder content.
5. Install the OpenClaw plugin with:

```bash
openclaw plugins install ~/.openclaw/repos/openclaw-xmtp
```

6. Verify OpenClaw sees the channel before restarting:

```bash
openclaw status
openclaw channels list
```

7. Verify XMTP identity and chat link:

```bash
npx tsx src/cli.ts status --json
```

8. Only if the plugin is not yet active after install, run:

```bash
openclaw gateway restart
```

Then rerun steps 6 and 7.

9. The final user-facing output must include:
   - the XMTP `address`
   - the XMTP `chatUrl`
   - a note that wallet/key bootstrap was completed automatically during `init`
   - one example natural-language instruction for asking OpenClaw to send an outbound XMTP message to another service, including the target XMTP address or inboxId and message text

Interpretation rules during install:

- If `openclaw status` shows `openclaw-xmtp` enabled and OK, and `npx tsx src/cli.ts status --json` returns `address` plus `chatUrl`, treat installation as successful.
- If plugin install or gateway restart prints a local-binding warning but the two checks above are healthy, do not escalate into debug mode.
- If the plugin is already active right after `openclaw plugins install`, do not restart Gateway.
- Do not run `npx tsx src/cli.ts start`, `xmtp-agent start`, `inbox`, or `send` during installation.
- Do not patch `package.json` or try to repair the package `bin` field during installation.
- Do not inspect or kill old XMTP agent processes from other repositories unless these repo-local checks prove there is a real conflict.
- If a Gateway restart is needed, print the final user-facing XMTP Web URL and usage guidance only after that restart completes.

## Validation Workflow

Use two layers of validation.

### Repository Tests

Run:

```bash
npm run typecheck
npm run test:plugin
```

### Live End-to-End Test

Run:

```bash
npm run test:live
```

Success requires a final JSON line with `"stage":"reply"`.
If the script only reaches `"stage":"sent"` or `"stage":"timeout"`, inspect OpenClaw logs and the plugin status before retrying.

For detailed validation and new-user verification, read `references/self-test.md`.

## Troubleshooting Rules

- If `preflight` reports incompatible Node.js, do not attempt any install steps.
- If `openclaw status` does not show `openclaw-xmtp` as enabled and OK, do not assume automatic replies work.
- If `npx tsx src/cli.ts status --json` has no `address` or `chatUrl`, verify `.env` exists and rerun `npx tsx src/cli.ts init` if needed.
- If the live E2E test sends a message but no reply is observed, inspect OpenClaw logs for `inbound`, `route`, `dispatch`, and `deliver`.
- If plugin reinstall fails because the plugin already exists or because `openclaw.json` contains stale install records, repair the local OpenClaw config before retrying.

For step-by-step remediation, read `references/install.md`.

## Uninstall Workflow

Use this order:

1. Stop the local XMTP agent:

```bash
npx tsx src/cli.ts stop
```

2. Remove the OpenClaw plugin:

```bash
openclaw plugins uninstall openclaw-xmtp
```

3. Run `npx tsx src/cli.ts repair-openclaw-config --json` if uninstall leaves stale plugin records behind.
4. Delete the plugin install directory if it still exists:

```bash
rm -rf ~/.openclaw/extensions/openclaw-xmtp
```

5. Optionally delete XMTP local state from this repository:
   `.env`, `data/`, `xmtp-dev-*.db3*`, and `knowledge.md` if the user wants a full local reset.

For the complete uninstall checklist, read `references/uninstall.md`.

## Files To Read When Needed

- `references/install.md` for full install and recovery flows
- `references/uninstall.md` for full removal and cleanup flows
- `references/self-test.md` for a zero-to-working user validation flow
- `references/release-checklist.md` for release readiness criteria

## Important Constraints

- Keep all commands local to the repository unless uninstalling from `~/.openclaw`.
- Do not claim installation succeeded until both `openclaw status` and `npx tsx src/cli.ts status --json` are healthy.
- Treat OpenClaw Gateway as the production process owner for XMTP lifecycle.
- Do not treat standalone `xmtp-agent start` as part of the required production setup.
- Do not tell the user to use `xmtp init`, `xmtp conversation send-text`, `xmtp conversations create-group`, or any other raw XMTP CLI command.
- Do not silently delete user state outside the repository unless the user explicitly asked for full uninstall or cleanup.
