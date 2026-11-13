# dsh-uni-remote — fork charter & roadmap

One fork of **dsh-remote@0.8.94** that grows into a unified local↔remote
plugin: P1 remote base (inherited) + P2 memory sync + P3 cross-machine agent
messaging + P4 one-click plugin push. Full design: workspace
`remote-memory-sync/DESIGN.md`.

## Fork policy

- **Base**: upstream `dsh-remote@0.8.94` (MIT, © dsh-remote contributors —
  LICENSE preserved). Published lib is unminified; fork edits are surgical.
- **Internal ids keep upstream spelling** (`dsh-remote`): settings slots,
  keychain SERVICE, SELF_ENTRY_NAMES all match on them — configs and saved
  credentials survive the swap. Only the package name is `dsh-uni-remote`;
  the bundle patch mounts it under entry id `dsh-remote` plus a second entry
  `dsh-uni-sync` for the uni layer (`lib/uni/`).
- **Self-update is hard-disabled** (the one mandatory fork edit). Upstream's
  `auto` update would re-download npm `dsh-remote` — the fork BASE — and
  silently revert this tree. `DEFAULT_UPDATE_MODE = 'off'`, and
  `fetchLatestVersion` / `applyUpdate` / `repairInstall` refuse unless env
  `UNI_SELF_UPDATE=1`. Update the fork via upstream sync, never in place.
- **Upstream sync procedure**: `npm pack dsh-remote@<ver>` → diff against
  `lib/` → re-apply the four guarded edits + `cordis.patch.yml` + `lib/uni/`
  → bump version to `<ver>-uni.<n>`.

## Pillar status

| Pillar | Status | Where |
|---|---|---|
| P1 remote base (SSH / rw_* / webAttach) | ✅ inherited upstream 0.8.94 | `lib/` (fork edits: update guards only) |
| P2 memory sync (dsh-mnemon + bidirectional) | 📋 designed, M2-M4 | DESIGN.md §4-5 |
| P3 cross-machine agent messaging | 📋 designed, M4-M5 | DESIGN.md (mailbox V1/V2) |
| P4 one-click plugin push | 🚧 scaffold (`lib/uni/sync.js`), M6 | DESIGN.md §6.1 |

## P4 push engine (what the button pushes)

Local profile is the single source of truth. Push = three pieces
(profile `package.json` `dependencies` + `dsh.profile.bundles` + user patch
overlay rows), exact-version skip, machine-specific fields sanitized,
remote dsh web restarted on change. See `lib/uni/sync.js` header for the
full contract and the issue-#470 warning.
