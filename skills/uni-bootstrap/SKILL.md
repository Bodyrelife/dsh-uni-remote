---
name: uni-bootstrap
description: Bootstrap DeepSeek Harness + dsh-uni-remote on a fresh remote machine over SSH (rw_* tools), so its web UI and uni mailbox/watcher become reachable via webAttach. Use when the user asks to set up a new remote server for remote workspaces, or when uni tools report the remote lacks dsh/uni-remote.
---

# uni-bootstrap: bring a fresh SSH machine online

Drive everything through the rw_* tools (rw_connect already done → the machine
is `store`-current). Idempotent: every step checks before acting. Report each
step's outcome; stop and report on the first hard failure with the exact
stderr. Never `sudo` unless the user said it is allowed.

## 1. Probe the machine

```
uname -s && node --version 2>/dev/null; command -v dsh; ls ~/.dsh-web-url 2>/dev/null; cat ~/.dsh-web-url 2>/dev/null
```

- Windows (uname fails / no shell uname): STOP — not supported by this skill.
- `node --version` ≥ v20.12 → skip step 2 (older major → step 2; v25/v26 fine).

## 2. Install Node (only if needed)

Pick by libc: `ldd --version 2>/dev/null | head -1` (glibc) else musl.

- glibc x64/arm64: download the official tarball
  `https://nodejs.org/dist/v22.20.0/node-v22.20.0-linux-{arch}-linux.tar.xz`
  (proxy `http://<host>:7897` is NOT valid remotely — use direct; if GitHub/
  nodejs.org is blocked from the remote, ask the user for a mirror).
- Extract to `~/.local/node` and add `~/.local/node/bin` to `~/.profile`,
  `~/.bashrc` and `~/.zshrc` PATH lines (guard against duplicates).
- Re-probe `node --version` in a FRESH `pool.exec` (each exec is a new shell).

## 3. Install dsh + dsh-uni-remote

```
npm install -g @deepseek-ai/dsh dsh-uni-remote
```

- npm registry unreachable → report and stop; do not invent mirrors.
- Verify: `command -v dsh && dsh --version`.
- Init if missing: `dsh init 2>&1 | tail -2` (skip when `~/.dsh` exists).

## 4. Start the web server (background, survives disconnect)

```
[ -f ~/.dsh-web-url ] && kill $(cat ~/.dsh-web-url.pid 2>/dev/null) 2>/dev/null
nohup dsh web --host 127.0.0.1 > ~/.dsh-web.log 2>&1 & echo $! > ~/.dsh-web-url.pid
```

- Wait ~3s, then extract the URL: `grep -m1 -o 'http://[^ ]*' ~/.dsh-web.log`.
- Persist it: `echo '<url>' > ~/.dsh-web-url` — webAttachDiscoverCommand and
  reconnect reuse this, so the tunnel re-attaches after SSH drops.
- Confirm alive: `curl -s -o /dev/null -w '%{http_code}' <url>` (any code ≠
  connection refused is fine — auth lives in the browser cookie).

## 5. Verify the uni layer

- `ls ~/.dsh/uni-remote` (mailbox root appears on first use; absent is OK).
- Tell the user: connect from the desktop app (设置→远程工作区, or
  rw_connect) and press 「同步插件」 on this machine row (P4) to converge its
  plugin profile with local; then `uni_send {machine: '<name>', body: 'ping'}`
  from any local session should appear in `uni_inbox` there, and the remote's
  watcher honors `mode: 'followup'|'inject'|'steer'` for live delivery.

## Failure handling

- Every remote command must not be piped (`$?` belongs to the last pipeline
  element); check exit codes via the echoed marker per the uni-sync convention.
- If port 3088+ is taken by an old dsh web, kill by pid file first, else the
  new instance just picks the next port — always re-read the URL from the log.
- node < 20.12 without glibc tarball access: report the exact blocker; do not
  attempt custom builds.
