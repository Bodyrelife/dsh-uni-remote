// uni memory — P2 cross-machine Memory Spaces sync (DESIGN.md §4).
//
// Transport = mnemon CLI on BOTH ends over the dsh-remote SSH channel:
//   export/pull:  mnemon --data-dir <dir> --store <id> --readonly recall "" --basic --limit 100000
//                 (same dump the provider UI uses: allNativeInsights)
//   import/push:  mnemon --data-dir <dir> --store <id> import <draft.json> --no-diff
//                 (faithful import, no semantic dedupe skips)
// Draft schema (provider's own): { schema_version: "1", source, insights: [{ content,
//   category, importance, source, tags?, entities? }] }
// Provenance: pulled insights get tags +["origin:remote-<machine>"]; pushed get
// +["origin:local"] — prevents ping-pong on re-sync (identical content is
// skipped by import's content-level dedupe when --no-diff is off; with
// --no-diff the origin tag keeps re-imports visible and auditable).
//
// CLI discovery mirrors dsh-mnemon's native-cli.js: $UNI_MNEMONIC_CLI, PATH,
// then common paths (~/.local/bin, /opt/homebrew/bin, /usr/local/bin,
// /usr/bin, ~/go/bin). A JS launcher (bin/mnemon.js) is executed with the
// host's own node (ELECTRON_RUN_AS_NODE=1).
import { execFile } from 'node:child_process'
import { accessSync, constants, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { uniMailboxRoot } from './mailbox.js'

const CLI_COMMON_UNIX = [
  '~/.local/bin/mnemon',
  '/opt/homebrew/bin/mnemon',
  '/usr/local/bin/mnemon',
  '/usr/bin/mnemon',
  '~/go/bin/mnemon',
]

function expandHome(p, home) {
  if (p === '~') return home
  if (p.startsWith('~/')) return path.join(home, p.slice(2))
  return p
}

// ── local CLI discovery + execution ─────────────────────────────────────────

export function findMnemonLocal(home = os.homedir()) {
  const candidates = []
  const envCli = process.env.UNI_MNEMONIC_CLI || process.env.MNEMON_CLI_PATH
  if (envCli) candidates.push(expandHome(envCli, home))
  const pathDirs = (process.env.PATH || '').split(':').filter(Boolean)
  for (const dir of pathDirs) candidates.push(path.join(dir, 'mnemon'))
  for (const p of CLI_COMMON_UNIX) candidates.push(expandHome(p, home))
  for (const c of candidates) {
    if (!c) continue
    try {
      accessSync(c, constants.X_OK)
      return c
    } catch { /* next */ }
  }
  return undefined
}

function runLocal(cli, args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const isJs = cli.endsWith('.js')
    const command = isJs ? process.execPath : cli
    const finalArgs = isJs ? [cli, ...args] : args
    const env = isJs ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : { ...process.env }
    execFile(command, finalArgs, { timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024, env, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err && stdout === undefined) return reject(err)
      resolve({ code: err ? (err.code || 1) : 0, stdout: stdout || '', stderr: stderr || '' })
    })
  })
}

// ── remote CLI discovery + execution (pool = dsh-remote SshPool) ────────────

const REMOTE_FIND = `command -v mnemon || for p in "$HOME/.local/bin/mnemon" /opt/homebrew/bin/mnemon /usr/local/bin/mnemon /usr/bin/mnemon "$HOME/go/bin/mnemon"; do [ -x "$p" ] && echo "$p" && break; done; echo __UNI_DONE__$?`

export async function findMnemonRemote(pool) {
  const res = await pool.exec(REMOTE_FIND, { timeoutMs: 15000 })
  const out = (res.stdout || '').trim()
  const lines = out.split('\n').filter((l) => !l.startsWith('__UNI_DONE__'))
  const bin = lines[lines.length - 1]?.trim()
  if (!bin || bin.includes('not found') || bin === 'command -v mnemon') return undefined
  return bin
}

async function runRemote(pool, cli, args, timeoutMs = 120000) {
  const quote = (s) => `'${String(s).replaceAll("'", `'\\''`)}'`
  const cmd = `${quote(cli)} ${args.map(quote).join(' ')}; echo __UNI_EXIT__$?`
  const res = await pool.exec(cmd, { timeoutMs })
  const out = (res.stdout || '')
  const m = out.match(/__UNI_EXIT__(\d+)\s*$/)
  const code = m ? Number(m[1]) : (res.code ?? 1)
  const stdout = out.replace(/__UNI_EXIT__(\d+)\s*$/, '').trim()
  return { code, stdout, stderr: res.stderr || '' }
}

async function runRemoteJson(pool, cli, args, timeoutMs) {
  const res = await runRemote(pool, cli, args, timeoutMs)
  if (res.code !== 0) throw new Error(`remote mnemon exited ${res.code}: ${(res.stderr || res.stdout || '').slice(0, 400)}`)
  try { return JSON.parse(res.stdout) } catch (err) {
    throw new Error(`remote mnemon returned non-JSON output (${String(err.message).slice(0, 120)}): ${res.stdout.slice(0, 200)}`)
  }
}

async function runLocalJson(cli, args, timeoutMs) {
  const res = await runLocal(cli, args, timeoutMs)
  if (res.code !== 0) throw new Error(`mnemon exited ${res.code}: ${(res.stderr || res.stdout || '').slice(0, 400)}`)
  try { return JSON.parse(res.stdout) } catch (err) {
    throw new Error(`mnemon returned non-JSON output (${String(err.message).slice(0, 120)}): ${res.stdout.slice(0, 200)}`)
  }
}

// ── shared helpers ──────────────────────────────────────────────────────────

function archiveDir(home) {
  const dir = path.join(uniMailboxRoot(home), '..', 'memory')
  mkdirSync(dir, { recursive: true })
  return dir
}

function normalizeInsights(payload) {
  const arr = Array.isArray(payload) ? payload : (Array.isArray(payload?.results) ? payload.results : [])
  const out = []
  for (const item of arr) {
    const core = item?.insight || item
    if (typeof core?.id !== 'string' || typeof core?.content !== 'string') continue
    out.push({
      id: core.id,
      content: core.content,
      category: typeof core.category === 'string' ? core.category : undefined,
      importance: typeof core.importance === 'number' ? core.importance : undefined,
      source: typeof core.source === 'string' ? core.source : undefined,
      tags: Array.isArray(core.tags) ? core.tags.filter((t) => typeof t === 'string') : undefined,
      entities: Array.isArray(core.entities) ? core.entities.filter((e) => typeof e === 'string') : undefined,
      createdAt: typeof core.created_at === 'string' ? core.created_at : undefined,
    })
  }
  return out
}

function toDraft(insights, originTag) {
  return {
    schema_version: '1',
    source: 'dsh-uni-remote-sync',
    insights: insights.map((it) => ({
      content: it.content,
      ...(it.category !== undefined ? { category: it.category } : {}),
      ...(it.importance !== undefined ? { importance: it.importance } : {}),
      ...(it.source !== undefined ? { source: it.source } : {}),
      tags: [...new Set([...(it.tags || []), originTag])],
      ...(it.entities !== undefined && it.entities.length > 0 ? { entities: it.entities } : {}),
    })),
  }
}

async function recallStore(runJson, dataDir, store) {
  const payload = await runJson(['--data-dir', dataDir, '--store', store, '--readonly', 'recall', '', '--basic', '--limit', '100000'], 180000)
  return normalizeInsights(payload)
}

async function importStore(runJson, dataDir, store, draft) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'uni-remote-mem-'))
  const draftPath = path.join(tmp, 'memory-draft.json')
  writeFileSync(draftPath, JSON.stringify(draft))
  const summary = await runJson(['--data-dir', dataDir, '--store', store, 'import', draftPath, '--no-diff'], 180000)
  return {
    imported: Number(summary?.imported ?? 0),
    updated: Number(summary?.updated ?? 0),
    skipped: Number(summary?.skipped ?? 0),
    errors: Number(summary?.errors ?? 0),
  }
}

// ── tool factory ────────────────────────────────────────────────────────────

export function createUniMemoryTools(deps = {}) {
  const { store, poolForMachine, resolveHome, homeDir } = deps
  const text = (v) => [{ type: 'text', text: v }]
  const output = {
    schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
    render: (_a, v) => text(v.text),
  }
  const isLocalTarget = (raw) => {
    const v = String(raw || '').trim().toLowerCase()
    return v === '' || ['local', 'this', 'self', '本机'].includes(v)
  }
  const findMachine = (raw) => {
    const key = String(raw || '').trim().toLowerCase()
    if (isLocalTarget(key)) return undefined
    const list = (store && store.list) || []
    const hit = list.find((m) => m.id === key || String(m.name || '').toLowerCase() === key || String(m.host || '').toLowerCase() === key)
    if (!hit) throw new Error(`no saved machine matches "${raw}" (see rw_machines); omit machine for this machine's own spaces`)
    return hit
  }
  // End binding: { runJson } executes CLI commands on the right side.
  async function bindEnd(rawMachine) {
    const machine = findMachine(rawMachine)
    if (!machine) {
      const cli = findMnemonLocal()
      if (!cli) throw new Error('mnemon CLI not found on this machine (searched $UNI_MNEMONIC_CLI/$MNEMON_CLI_PATH, PATH, ~/.local/bin, /opt/homebrew/bin, /usr/local/bin, /usr/bin, ~/go/bin). Install it (go install) or set UNI_MNEMONIC_CLI.')
      return { cli, runJson: (args, t) => runLocalJson(cli, args, t) }
    }
    const pool = poolForMachine(machine)
    const cli = await findMnemonRemote(pool)
    if (!cli) throw new Error(`mnemon CLI not found on "${machine.name || machine.host}" (searched PATH + common paths). Install it there or push the binary with rw tools first.`)
    return { cli, machine, runJson: (args, t) => runRemoteJson(pool, cli, args, t) }
  }

  const defaultDataDir = () => process.env.UNI_MNEMON_DATA_DIR || path.join(os.homedir(), '.mnemon', 'sources')
  const defaultRemoteDataDir = '~/.mnemon/sources'

  return [
    {
      name: 'uni_mem_status',
      description: 'Check Memory Spaces availability on one end: mnemon CLI presence, data dir, stores on disk. machine omitted/"local" = this machine; otherwise a saved machine name/id/host (rw_machines).',
      parameters: {
        type: 'object',
        properties: {
          machine: { type: 'string' },
          dataDir: { type: 'string', description: 'mnemon --data-dir override; default ~/.mnemon/sources' },
        },
      },
      output,
      async execute(args) {
        const dataDir = args.dataDir || defaultDataDir()
        const end = await bindEnd(args.machine)
        const where = end.machine ? `remote ${end.machine.name || end.machine.host}` : 'this machine'
        const lines = [`cli: ${end.cli}`, `where: ${where}`, `dataDir: ${dataDir}`]
        try {
          const status = await end.runJson(['--data-dir', dataDir, 'status'], 30000)
          lines.push(`status: ${JSON.stringify(status).slice(0, 500)}`)
        } catch (err) {
          lines.push(`status: failed — ${String(err.message).slice(0, 300)}`)
        }
        return { text: lines.join('\n') }
      },
    },
    {
      name: 'uni_mem_pull',
      description: 'Pull a Memory Space from a machine into this one: remote `mnemon recall` dump → saved archive under ~/.dsh/uni-remote/memory/ → optional faithful import (--no-diff) into a local space tagged origin:remote-<machine>. Local side needs the mnemon CLI unless import=false.',
      parameters: {
        type: 'object',
        properties: {
          machine: { type: 'string', required: true, description: 'saved machine name/id/host to pull FROM' },
          store: { type: 'string', required: true, description: 'Memory Space id on that machine' },
          dataDir: { type: 'string', description: 'remote --data-dir override; default ~/.mnemon/sources' },
          localStore: { type: 'string', description: 'local space id to import into; default remote-<machine>' },
          import: { type: 'boolean', description: 'import locally after download (default true)' },
        },
      },
      output,
      async execute(args) {
        const machine = findMachine(args.machine)
        if (!machine) throw new Error('pass a saved machine to pull FROM (not "local")')
        const remote = await bindEnd(args.machine)
        const rDataDir = args.dataDir || defaultRemoteDataDir
        const insights = await recallStore(
          (a, t) => remote.runJson(a, t),
          rDataDir,
          String(args.store),
        )
        const archive = path.join(archiveDir(homeDir), `${(machine.name || machine.host).replace(/[^\w.-]+/g, '-')}-${args.store}-${Date.now()}.json`)
        writeFileSync(archive, JSON.stringify({ pulledAt: new Date().toISOString(), machine: machine.name || machine.host, store: args.store, insights }, null, 2))
        const lines = [`pulled ${insights.length} insight(s) from ${machine.name || machine.host}/${args.store}`, `archive: ${archive}`]
        if (args.import === false) return { text: lines.join('\n') }
        const localCli = findMnemonLocal()
        if (!localCli) return { text: lines.join('\n') + '\nlocal import skipped: mnemon CLI not found locally (set UNI_MNEMONIC_CLI or install)' }
        const localStore = args.localStore || `remote-${String(machine.name || machine.host).replace(/[^\w.-]+/g, '-')}`
        const summary = await importStore((a, t) => runLocalJson(localCli, a, t), defaultDataDir(), localStore, toDraft(insights, `origin:remote-${machine.name || machine.host}`))
        lines.push(`imported into local space "${localStore}": ${JSON.stringify(summary)}`)
        return { text: lines.join('\n') }
      },
    },
    {
      name: 'uni_mem_push',
      description: 'Push a local Memory Space to a machine: local `mnemon recall` dump → draft tagged origin:local → faithful import (--no-diff) into a remote space. Both ends need the mnemon CLI.',
      parameters: {
        type: 'object',
        properties: {
          machine: { type: 'string', required: true, description: 'saved machine name/id/host to push TO' },
          localStore: { type: 'string', required: true, description: 'local Memory Space id to push FROM' },
          store: { type: 'string', description: 'remote space id to import into; default same as localStore' },
          dataDir: { type: 'string', description: 'remote --data-dir override; default ~/.mnemon/sources' },
        },
      },
      output,
      async execute(args) {
        const machine = findMachine(args.machine)
        if (!machine) throw new Error('pass a saved machine to push TO (not "local")')
        const localCli = findMnemonLocal()
        if (!localCli) throw new Error('mnemon CLI not found locally — cannot read the local space (set UNI_MNEMONIC_CLI or install)')
        const insights = await recallStore((a, t) => runLocalJson(localCli, a, t), defaultDataDir(), String(args.localStore))
        const remote = await bindEnd(args.machine)
        const pool = poolForMachine(machine)
        const home = await resolveHome(pool)
        const rDataDir = args.dataDir || defaultRemoteDataDir
        const draft = JSON.stringify(toDraft(insights, 'origin:local'))
        const remotePath = `${home}/.dsh/uni-remote/memory/push-${Date.now()}.json`
        const mkdir = await pool.exec(`mkdir -p '$(dirname "${remotePath}")'`, { timeoutMs: 15000 })
        if (mkdir.code !== 0) throw new Error(`remote mkdir failed: ${(mkdir.stderr || '').slice(0, 200)}`)
        let sftp
        try {
          sftp = await pool.sftp()
          await new Promise((resolve, reject) => {
            const ws = sftp.createWriteStream(remotePath)
            ws.on('error', reject)
            ws.end(draft + '\n', resolve)
          })
        } finally {
          try { sftp?.end() } catch { /* closed */ }
        }
        const summary = await (async () => {
          const res = await runRemote(pool, remote.cli, ['--data-dir', rDataDir, '--store', args.store || args.localStore, 'import', remotePath, '--no-diff'], 180000)
          if (res.code !== 0) throw new Error(`remote import exited ${res.code}: ${(res.stderr || res.stdout || '').slice(0, 400)}`)
          try { return JSON.parse(res.stdout) } catch { throw new Error(`remote import returned non-JSON: ${res.stdout.slice(0, 200)}`) }
        })()
        return {
          text: `pushed ${insights.length} insight(s) → ${machine.name || machine.host}/${args.store || args.localStore}: ${JSON.stringify(summary)}`,
        }
      },
    },
  ]
}
