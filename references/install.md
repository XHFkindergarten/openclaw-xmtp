# Installation and Recovery

## Supported Setup

- Node.js `>=22`
- npm and npx available in `PATH`
- OpenClaw installed for automatic replies
- Repository checked out locally at `~/.openclaw/repos/openclaw-xmtp`

## Do This First

From the fixed repository path:

```bash
cd ~/.openclaw/repos/openclaw-xmtp
npx tsx src/cli.ts preflight --json
```

### If preflight fails

- Node.js missing:
  Install Node.js 22 or newer, then rerun preflight.
- Node.js version too old:
  Upgrade Node.js, then rerun preflight.
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

3. Edit the generated `knowledge.md` in the XMTP base directory.

By default this file is:

```bash
~/.openclaw/state/openclaw-xmtp/runtime/knowledge.md
```

4. Install the OpenClaw plugin:

```bash
openclaw plugins install ~/.openclaw/repos/openclaw-xmtp
openclaw gateway restart
```

5. Verify OpenClaw and XMTP identity:

```bash
npx tsx src/cli.ts status --json
openclaw status
openclaw channels list
```

Expected result:

- `openclaw-xmtp` appears in `openclaw status`
- channel state is `OK`
- `npx tsx src/cli.ts status --json` reports `configured: true`
- `npx tsx src/cli.ts status --json` returns `address` and `chatUrl`

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
openclaw gateway restart
```

### Case: stale `openclaw.json` blocks reinstall

Symptoms:

- OpenClaw reports `plugins.allow: plugin not found: openclaw-xmtp`

Recovery:

```bash
npx tsx src/cli.ts repair-openclaw-config --json
openclaw plugins install ~/.openclaw/repos/openclaw-xmtp
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
