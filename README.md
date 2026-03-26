# openclaw-xmtp

`openclaw-xmtp` runs XMTP directly inside OpenClaw's native channel runtime.

The production path is:

`XMTP -> openclaw-xmtp plugin (embedded XMTP SDK) -> OpenClaw reply pipeline -> XMTP`

The canonical local checkout path is:

`~/.openclaw/repos/openclaw-xmtp`

`npx tsx src/cli.ts init` creates runtime files under the XMTP base directory, not in the repository root.
By default that directory is `~/.openclaw/state/openclaw-xmtp/runtime`, and it contains `.env` plus the generated `knowledge.md`.

## Requirements

- macOS or Linux with local filesystem access
- Node.js 22 or newer
- npm / npx
- OpenClaw installed if you want automatic replies inside OpenClaw

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
openclaw gateway restart
```

Then verify:

```bash
npx tsx src/cli.ts status --json
openclaw status
npm run test:plugin
npm run test:live
```

## Main Commands

- `npx tsx src/cli.ts preflight --json`
- `npx tsx src/cli.ts init`
- `npx tsx src/cli.ts status --json`
- `npx tsx src/cli.ts repair-openclaw-config --json`
- `npm run test:live`

Optional standalone debug commands:
- `npx tsx src/cli.ts start`
- `npx tsx src/cli.ts stop`
- `npx tsx src/cli.ts inbox --json`
- `npx tsx src/cli.ts send --to <address-or-inboxId> --msg "<text>" --json`

## Documents

- [Single-Doc OpenClaw Initialization](./OPENCLAW_INIT.md)
- [Installation and Recovery](./references/install.md)
- [Self-Test Guide](./references/self-test.md)
- [Uninstall Guide](./references/uninstall.md)
- [Release Checklist](./references/release-checklist.md)

## Notes

- Automatic OpenClaw replies require the OpenClaw plugin to be installed and enabled.
- Gateway startup owns the production XMTP lifecycle. `xmtp-agent start` is only for standalone debugging.
- The old raw Gateway WebSocket bridge is no longer part of the supported design.
- `knowledge.md` controls what the OpenClaw-side persona should know and answer.
