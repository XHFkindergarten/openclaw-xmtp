# Release Checklist

## Code

- `npm run typecheck` passes
- `npm run test:plugin` passes
- live XMTP E2E reaches `"stage":"reply"`
- no deprecated raw Gateway WebSocket integration remains in the supported path

## Docs

- `README.md` explains what the project is
- `SKILL.md` tells OpenClaw how to install, validate, troubleshoot, and uninstall
- install, self-test, and uninstall references exist

## Runtime

- `openclaw status` shows `openclaw-xmtp` as enabled and OK
- `npx tsx src/cli.ts status --json` shows `configured: true` with `address` and `chatUrl`
- OpenClaw logs show `inbound -> route -> dispatch -> deliver ok`

## Cleanup

- local uninstall flow is documented
- stale OpenClaw plugin records are handled in documentation

## Known Operational Risk

- model context pressure on the default OpenClaw agent still needs operator attention if production conversations grow large
