# Uninstall and Full Cleanup

## Goal

Remove `openclaw-xmtp` from OpenClaw and optionally wipe all local XMTP state for this repository.

## Safe Uninstall

1. Stop the standalone debug agent if it is running:

```bash
npx tsx src/cli.ts stop
```

2. Uninstall the OpenClaw plugin:

```bash
openclaw plugins uninstall openclaw-xmtp
```

3. Restart the gateway:

```bash
openclaw gateway restart
```

4. Verify removal:

```bash
openclaw status
openclaw channels list
```

Expected result:

- `openclaw-xmtp` no longer appears in channel listings

## If OpenClaw Leaves Stale Records

Repair OpenClaw's plugin config:

```bash
npx tsx src/cli.ts repair-openclaw-config --json
```

Then delete leftover install files if present:

```bash
rm -rf ~/.openclaw/extensions/openclaw-xmtp
```

Restart OpenClaw again after cleanup:

```bash
openclaw gateway restart
```

## Optional Full Local Reset

Do this only if the user wants to remove all repository-local state.

Delete:

- `.env`
- `knowledge.md`
- `data/`
- `xmtp-dev-*.db3`
- `xmtp-dev-*.db3-shm`
- `xmtp-dev-*.db3-wal`
- `xmtp-dev-*.db3.sqlcipher_salt`

That removes:

- the local XMTP wallet secret reference
- the local encrypted XMTP database
- standalone debug audit and PID files
- the local knowledge template

## Post-Uninstall Check

After uninstall:

- `openclaw status` should not show `openclaw-xmtp`
- `npx tsx src/cli.ts status --json` should show `running: false`
- the repository may remain on disk, but it should no longer affect OpenClaw
