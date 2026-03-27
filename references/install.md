# Installation and Recovery

## Supported Setup

- Node.js `22 LTS` or `24 LTS`
- npm and npx available in `PATH`
- OpenClaw installed for automatic replies
- Repository checked out locally at `~/.openclaw/repos/openclaw-xmtp`

XMTP dependency versions are intentionally pinned in this repository to avoid a broken upstream native binding release. Users should run plain `npm install` and should not be told to change XMTP package versions manually.

## Do This First

From the fixed repository path:

```bash
cd ~/.openclaw/repos/openclaw-xmtp
npx tsx src/cli.ts preflight --json
```

### If preflight fails

- Node.js missing:
  Install Node.js 22 LTS or 24 LTS, then rerun preflight.
- Node.js version too old:
  Upgrade to Node.js 22 LTS or 24 LTS, then rerun preflight.
- npm or npx missing:
  Repair the Node.js installation, then rerun preflight.
- OpenClaw missing:
  Install OpenClaw first if the user wants automatic XMTP replies from OpenClaw.
- Dependencies missing:
  Run `npm install`.

## Required Repository Path

Use this exact path:

```bash
~/.openclaw/repos/openclaw-xmtp
```

If needed:

```bash
mkdir -p ~/.openclaw/repos
cd ~/.openclaw/repos
git clone <repo-url> openclaw-xmtp
cd ~/.openclaw/repos/openclaw-xmtp
```

## Fresh Install

1. Install dependencies:

```bash
npm install
```

2. Initialize local secrets and templates:

```bash
npx tsx src/cli.ts init
```

This step already auto-generates:

- the XMTP wallet private key
- the XMTP DB encryption key
- `knowledge.md`
- runtime state directories

Do not ask the user to manually create XMTP wallet/key material after running it.

3. Edit the generated `knowledge.md` in the XMTP base directory.

By default this file is:

```bash
~/.openclaw/state/openclaw-xmtp/runtime/knowledge.md
```

4. Install the OpenClaw plugin:

```bash
openclaw plugins install ~/.openclaw/repos/openclaw-xmtp
```

5. Verify OpenClaw and XMTP identity before restarting:

```bash
npx tsx src/cli.ts status --json
openclaw status
openclaw channels list
```

6. Only if the plugin is not yet active, tell the user to restart Gateway manually in their own terminal. Do not run it for them. After the user has done that, rerun the same checks:

```bash
openclaw gateway restart
npx tsx src/cli.ts status --json
openclaw status
openclaw channels list
```

Expected result:

- `openclaw-xmtp` appears in `openclaw status`
- channel state is `OK`
- `npx tsx src/cli.ts status --json` reports `configured: true`
- `npx tsx src/cli.ts status --json` returns `address` and `chatUrl`
- the final user output includes the `chatUrl` plus one example OpenClaw instruction for sending to another XMTP service using a target address or inboxId and message text
- `running = false` in `status --json` is acceptable before the first inbound message
- a local-binding warning during install/restart is acceptable if the checks above are healthy

Do not replace this flow with `@xmtp/cli`, `xmtp-cli` skills, or raw XMTP CLI usage.
Do not switch to `xmtp-agent start`, `inbox`, `send`, PID hunting, or `package.json` edits during normal installation.
Do not run `openclaw gateway restart` yourself from inside the active installation conversation; the user must run it manually.
Do not print final user-facing XMTP test instructions until after any required Gateway restart has finished.

## Recovery Cases

### Case: plugin already exists

Symptoms:

- `openclaw plugins install ...` fails with `plugin already exists`

Recovery:

```bash
openclaw plugins uninstall openclaw-xmtp
rm -rf ~/.openclaw/extensions/openclaw-xmtp
npx tsx src/cli.ts repair-openclaw-config --json
openclaw plugins install ~/.openclaw/repos/openclaw-xmtp
```

Then rerun:

```bash
npx tsx src/cli.ts status --json
openclaw status
openclaw channels list
```

Only if still unhealthy, tell the user to run manually in their own terminal:

```bash
openclaw gateway restart
```

### Case: stale `openclaw.json` blocks reinstall

Symptoms:

- OpenClaw reports `plugins.allow: plugin not found: openclaw-xmtp`

Recovery:

```bash
npx tsx src/cli.ts repair-openclaw-config --json
openclaw plugins install ~/.openclaw/repos/openclaw-xmtp
```

Then rerun:

```bash
npx tsx src/cli.ts status --json
openclaw status
openclaw channels list
```

Only if still unhealthy, tell the user to run manually in their own terminal:

```bash
openclaw gateway restart
```

### Case: XMTP identity is not initialized

Symptoms:

- `npx tsx src/cli.ts status --json` returns no `address`
- OpenClaw start fails with `XMTP is not initialized`

Recovery:

```bash
npx tsx src/cli.ts init
```

Then rerun:

```bash
npx tsx src/cli.ts status --json
openclaw status
```

### Case: automatic reply still does not happen

Check these in order:

1. `openclaw status` shows `openclaw-xmtp` enabled and OK.
2. `npx tsx src/cli.ts status --json` shows an `address` and `chatUrl`.
3. `openclaw logs --plain` shows:
   - `[xmtp] inbound`
   - `[xmtp] route`
   - `[xmtp] recorded`
   - `[xmtp] dispatch start`
   - `[xmtp] deliver ok`
4. `npm run test:live` ends with `"stage":"reply"`.

If `dispatch` happens but reply quality is poor or unstable, treat the model/context configuration as the next problem, not the XMTP bridge itself.
