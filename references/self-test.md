# Self-Test Guide

This guide is for a new user starting from zero.

## 1. Check Prerequisites

Open a terminal in the fixed repository path and run:

```bash
cd ~/.openclaw/repos/openclaw-xmtp
npx tsx src/cli.ts preflight --json
```

Do not continue until:

- Node.js is `>=22`
- npm and npx are present

If OpenClaw is not installed yet, install OpenClaw before expecting automatic replies.

## 2. Install Repository Dependencies

```bash
npm install
```

## 3. Initialize Local Files

```bash
npx tsx src/cli.ts init
```

This creates:

- `.env`
- `knowledge.md`
- `data/`

These are created in the XMTP base directory, which defaults to:

```bash
~/.openclaw/state/openclaw-xmtp/runtime
```

## 4. Edit `knowledge.md`

Replace placeholder content with a real persona and knowledge scope.

## 5. Install the OpenClaw Plugin

```bash
openclaw plugins install ~/.openclaw/repos/openclaw-xmtp
openclaw gateway restart
```

Then verify:

```bash
npx tsx src/cli.ts status --json
openclaw status
openclaw channels list
```

## 6. Run Repository Tests

```bash
npm run typecheck
npm run test:plugin
```

Both must pass.

## 7. Run Live End-to-End Test

```bash
npm run test:live
```

Expected final output:

```json
{"stage":"reply", ...}
```

That confirms a real XMTP message entered the embedded plugin, OpenClaw replied, and the reply was delivered back over XMTP.

## 8. Manual Sanity Check

Optional:

```bash
openclaw logs --plain
```

Look for `openclaw-xmtp` entries with `inbound`, `dispatch`, and `deliver ok`.

## 9. Basic Daily Commands

- Check status:
  `npx tsx src/cli.ts status --json`
- Check inbox:
  `npx tsx src/cli.ts inbox --json`
- Stop agent:
  `npx tsx src/cli.ts stop`
- Restart agent:
  `npx tsx src/cli.ts stop && npx tsx src/cli.ts start`
