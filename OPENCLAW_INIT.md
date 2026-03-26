# openclaw-xmtp Initialization Playbook

This is the single document to hand to OpenClaw.

Goal:

- install and initialize this repository from zero
- install and enable the `openclaw-xmtp` OpenClaw plugin
- verify the channel is healthy
- print the final `chatUrl`

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
  Run `npx tsx src/cli.ts init`.
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

Then inspect `knowledge.md`.

The generated file lives under the XMTP base directory reported by `preflight --json`.
By default that is `~/.openclaw/state/openclaw-xmtp/runtime/knowledge.md`.

- If it still contains placeholder text, tell the user they must replace the placeholder knowledge before they expect meaningful replies.
- If the user wants installation only, continue anyway.

## Phase 3: Install OpenClaw Plugin

Install this repository into OpenClaw:

```bash
openclaw plugins install ~/.openclaw/repos/openclaw-xmtp
openclaw gateway restart
```

Then verify:

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

### If install fails because plugin already exists

Do this:

```bash
openclaw plugins uninstall openclaw-xmtp
rm -rf ~/.openclaw/extensions/openclaw-xmtp
npx tsx src/cli.ts repair-openclaw-config --json
openclaw plugins install ~/.openclaw/repos/openclaw-xmtp
openclaw gateway restart
```

### If install fails because `openclaw.json` contains stale `openclaw-xmtp` records

Run:

```bash
npx tsx src/cli.ts repair-openclaw-config --json
openclaw plugins install ~/.openclaw/repos/openclaw-xmtp
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

The user should be told to open the returned `chatUrl` directly and start chatting there.

## Uninstall

If the user later asks to remove this tool completely, follow:

1. `npx tsx src/cli.ts stop`
2. `openclaw plugins uninstall openclaw-xmtp`
3. `openclaw gateway restart`
4. If needed, run `npx tsx src/cli.ts repair-openclaw-config --json`
5. If the user wants a full local reset, delete `.env`, `knowledge.md`, `data/`, and `xmtp-dev-*.db3*`
