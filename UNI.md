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
| P2 memory sync | ✅ tools (uni.7): uni_mem_status / uni_mem_pull / uni_mem_push via mnemon CLI both ends (CLI must exist on each end; graceful error otherwise) | `lib/uni/memory.js` |
| P3 cross-machine agent messaging | ✅ V1+M5 (uni.7): file mailbox (uni_send/uni_inbox/uni_read, mode=mail passive) + live channel (mode=followup/inject/steer auto-delivered by mailbox watcher; local tools uni_agents/uni_inject/uni_steer/uni_followup via host `ctx.get("agents")` seam) | `lib/uni/mailbox.js` + `lib/uni/steer.js` |
| P4 one-click plugin push | ✅ implemented (server RPC + settings button; 真机验证中) | `lib/uni/routes.js` + `lib/uni/sync.js` + `lib/client.js` UniSyncPage |

## Install (manual, from git)

```bash
git clone git@github.com:Bodyrelife/dsh-uni-remote.git <任意目录>
# 1) ~/.dsh/profiles/desktop/package.json
#    dependencies 加  "dsh-uni-remote": "link:<clone 目录>"
#    dsh.profile.bundles 加 "dsh-uni-remote"
# 2) 符号链接（与 dsh-session-composer 同款约定）
ln -sfn <clone 目录> ~/.dsh/profiles/desktop/node_modules/dsh-uni-remote
# 2b) 关键：仓库内 node_modules 自链接（缺它客户端设置栏会被静默剔除，见下）
ln -sfn .. <clone 目录>/node_modules/dsh-uni-remote
# 3) 重启 DSH 桌面端 → 设置页出现「插件同步」栏
```

The bundle is self-contained: committed `node_modules/` carries every runtime
import (`ssh2`, `@deepseek-ai/schemastery`, `iconv-lite`, `yaml`). Note: the
0.8.94-uni.1 tarball initially shipped WITHOUT schemastery/iconv-lite — fixed
in uni.2 when `yaml` was added for the uni layer (latent load blocker).

### Why step 2b exists (silent client-side drop)

The host mounts the plugin **by path** (server side works, plugin inventory
shows it enabled), but `@deepseek-ai/dsh-client-modules` re-resolves the row's
**bare package name** (`entry.options.name`) from the bundle tree base to find
`client.js`. With Node 24 resolve internals present, a failed resolution is
swallowed (`catch { return; }` in `locatePkgJson`) and the entry is silently
excluded from the client graph — no settings sections, no error anywhere.
A `link:` install realpaths to the clone dir, and nothing above it contains
`node_modules/dsh-uni-remote`, so the re-resolution fails. The in-repo
self-link `<clone>/node_modules/dsh-uni-remote -> ..` makes it resolve.
Market/pnpm installs (`dsh plugin --profile desktop add link:<dir>`) get this
for free from the `.pnpm` layout, so only manual `link:` installs need it.
Remote pushes via the uni-sync button ship a packed tarball through real
`npm install` and are unaffected.

## P4 push engine (what the button pushes)

Local profile is the single source of truth. Push = three pieces
(profile `package.json` `dependencies` + `dsh.profile.bundles` + user patch
overlay rows), exact-version skip, machine-specific fields sanitized,
remote dsh web restarted on change. See `lib/uni/sync.js` header for the
full contract and the issue-#470 warning.

## uni.7 — P3 M5 live channel + P2 memory sync tools (2026-11-16)

**P3 M5 (live injection).** Mail gains an optional `mode`: `mail` (default,
unchanged — recipient polls `uni_inbox`) or `followup|inject|steer`. Live mail
is auto-delivered by a mailbox watcher inside the plugin (5s poll of the local
inbox): the receiving machine's own dsh-uni-remote resolves the named target
session and calls the host agent seam — exactly the first-party pattern in
`dsh-cordis-host-runner`:

```js
const agent = ctx.get('agents')?.get(sessionId)
agent[mode](createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'uni-remote' } }))
```

(`followup` = queue next-turn + wake; `steer` = queue next-step + wake, i.e.
interrupt; `inject` = queue next-step without wake. Message factory is
`createUserMessage` from `@deepseek-ai/dsh-llm`, resolved from the host app
tree like `dsh-tools`.) Constraints: live modes need a NAMED `to` (a `*`
broadcast is left for `uni_read`); the remote machine must run uni-remote ≥
uni.7 for its watcher to honor the mode; same-machine live sends go straight
through the seam (no file round-trip wait) while still filing a `sent/` copy.
Local addressing tools: `uni_agents` (list live sessions), `uni_inject`,
`uni_steer`, `uni_followup` (`lib/uni/steer.js`).

**P2 (memory sync).** `uni_mem_status` / `uni_mem_pull` / `uni_mem_push`
(`lib/uni/memory.js`) drive the mnemon CLI over the dsh-remote SSH channel on
both ends: pull = `recall "" --basic --limit 100000` dump → archive under
`~/.dsh/uni-remote/memory/` → optional faithful `import --no-diff` into a
local space tagged `origin:remote-<machine>`; push = local dump → draft tagged
`origin:local` → SFTP → remote `import --no-diff`. CLI discovery mirrors
dsh-mnemon's `native-cli.js` (`UNI_MNEMONIC_CLI`/PATH/common paths, JS
launcher under the host node). **The mnemon CLI must exist on each end**;
missing CLI = clear actionable error, archives still land locally. This
machine currently has NO mnemon CLI — set `UNI_MNEMONIC_CLI` or install
before expecting pull/push to complete.
