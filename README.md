# openclaw-xmtp

`openclaw-xmtp` runs XMTP directly inside OpenClaw's native channel runtime.

The production path is:

`XMTP -> openclaw-xmtp plugin (embedded XMTP SDK) -> OpenClaw reply pipeline -> XMTP`

The canonical local checkout path is:

`~/.openclaw/repos/openclaw-xmtp`

`npx tsx src/cli.ts init` creates runtime files under the XMTP base directory, not in the repository root.
By default that directory is `~/.openclaw/state/openclaw-xmtp/runtime`, and it contains `.env` plus the generated `knowledge.md`.
This `init` step already auto-generates the XMTP wallet key and DB encryption key. Users should not be asked to create them manually.

## Requirements

- macOS or Linux with local filesystem access
- Node.js 22 LTS or 24 LTS
- npm / npx
- OpenClaw installed if you want automatic replies inside OpenClaw

XMTP dependency versions are intentionally pinned in this repository to avoid a broken upstream native binding release on macOS arm64. Tell users to run plain `npm install` from this repo and do not suggest changing XMTP package versions manually.

## Quick Start

```bash
mkdir -p ~/.openclaw/repos
cd ~/.openclaw/repos
git clone <repo-url> openclaw-xmtp
cd ~/.openclaw/repos/openclaw-xmtp
npm install
npx tsx src/cli.ts preflight --json
npx tsx src/cli.ts init
openclaw plugins install ~/.openclaw/repos/openclaw-xmtp
npx tsx src/cli.ts status --json
openclaw status
```

If the plugin is not yet active in `openclaw status`, restart the Gateway once and then verify:

```bash
openclaw gateway restart
openclaw status
npx tsx src/cli.ts status --json
npm run test:plugin
npm run test:live
```

If the restart is being triggered from an active OpenClaw installation conversation, do not run `openclaw gateway restart` inside that conversation. The user must run it manually in their own terminal, then run:

```bash
npx tsx src/cli.ts status --json
```

The `chatUrl` field from that output is the XMTP Web test URL.

After install, the user-facing output should focus on:

- the `chatUrl` from `npx tsx src/cli.ts status --json`, which they can open directly in XMTP Web
- one OpenClaw chat example for sending to another XMTP service, with:
  - target XMTP address or inboxId
  - message text

Do not tell end users to install `@xmtp/cli`, install `xmtp-cli` skills, or manage raw XMTP CLI commands.
Do not tell installers to start a standalone XMTP agent or fix the package `bin` path during normal plugin setup.
If a Gateway restart is needed, print the user-facing XMTP Web URL and usage guidance only after the restart is complete.
If the restart would interrupt the current conversation, stop and instruct the user to run `openclaw gateway restart` manually, then `npx tsx src/cli.ts status --json`, then use the returned `chatUrl` and the OpenClaw outbound demo.

## Main Commands

- `npx tsx src/cli.ts preflight --json`
- `npx tsx src/cli.ts init`
- `npx tsx src/cli.ts status --json`
- `npx tsx src/cli.ts repair-openclaw-config --json`
- `npm run test:live`

## Documents

- [Single-Doc OpenClaw Initialization](./OPENCLAW_INIT.md)
- [Installation and Recovery](./references/install.md)
- [Self-Test Guide](./references/self-test.md)
- [Uninstall Guide](./references/uninstall.md)
- [Release Checklist](./references/release-checklist.md)

## Notes

- Automatic OpenClaw replies require the OpenClaw plugin to be installed and enabled.
- Gateway startup owns the production XMTP lifecycle.
- A local-binding warning during plugin install is not a blocker if `openclaw status` shows `openclaw-xmtp` enabled/OK and `npx tsx src/cli.ts status --json` returns `address` plus `chatUrl`.
- The old raw Gateway WebSocket bridge is no longer part of the supported design.
- `knowledge.md` controls what the OpenClaw-side persona should know and answer.
