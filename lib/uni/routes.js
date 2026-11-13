// dsh-uni-remote — uni-sync HTTP surface (P4 one-click plugin push).
//
// Charter: ONE button, ONE-WAY push, local is the single source of truth
// (DESIGN.md §6.1 / UNI.md). The settings-page button POSTs here per machine;
// the server drives the REMOTE machine through dsh-remote's own connection
// pool (poolForMachine → SshPool.exec + sftp) so no second SSH stack exists.
//
// Push = three registration artifacts + self delivery:
//   1. profile package.json `dependencies`        (npm install on remote)
//   2. profile package.json `dsh.profile.bundles` (activation rows appended)
//   3. user patch overlay rows                    (cordis.patch.yml appended,
//      sanitized — never a bundle's own insert block, issue #470)
//   + dsh-uni-remote itself cannot come from a registry spec locally
//     (`link:/…` workspace); the offline channel packs it with `npm pack`
//     and uploads the tarball via SFTP (remote dep = `file:uni-packs/<tgz>`).
//
// Everything here is idempotent: re-running with an unchanged local profile
// produces an empty plan and a no-op push. Backups are written before every
// remote file mutation (.bak-<ts>).

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, realpathSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stringify as yamlStringify, parse as yamlParse } from 'yaml'
import {
  profilePaths,
  collectLocalProfile,
  diffProfile,
  buildSyncPlan,
  sanitizeOverlayRow,
} from './sync.js'

const execFileP = promisify(execFile)

export const UNI_SYNC_PATH = '/dsh-remote/uni-sync'

/** Local profile dir the plan is built from. Env override for tests. */
export function uniLocalProfileDir() {
  return process.env.DSH_PROFILE_DIR || join(process.env.HOME || '', '.dsh', 'profiles', 'desktop')
}

/** This package's own root (lib/uni/routes.js → package root, 3 dirnames). */
export function uniSelfRoot() {
  return resolveReal(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
}

function resolveReal(p) {
  try { return realpathSync(p) } catch { return p }
}

/** This package's name/version (settings header). */
export function uniSelfInfo(root) {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    return { name: pkg.name, version: pkg.version }
  } catch { return { name: 'dsh-uni-remote', version: null } }
}

/** Timestamped backup suffix shared by every remote mutation. */
const bakSuffix = () => `.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`

/**
 * Run a command on the remote machine with a trailing exit marker so the
 * real exit status survives (never pipe on the remote — $? would be the
 * pipe's last stage, not the command's).
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
async function remoteRun(pool, command, timeoutMs) {
  const marked = `${command}; echo __UNI_EXIT__$?`
  const res = await pool.exec(marked, { timeoutMs })
  const stdout = String(res.stdout || '')
  const m = stdout.match(/__UNI_EXIT__(\d+)\s*$/)
  return {
    code: m ? Number(m[1]) : (res.code ?? 1),
    stdout: stdout.replace(/__UNI_EXIT__\d+\s*$/, ''),
    stderr: String(res.stderr || ''),
  }
}

/** `cat` a remote text file (base64-safe for unicode content). */
async function remoteReadFile(pool, filePath) {
  const r = await remoteRun(pool, `base64 "${filePath}" 2>/dev/null || echo __UNI_MISSING__`, 20000)
  if (r.stdout.includes('__UNI_MISSING__')) return null
  const b64 = r.stdout.replace(/\s+/g, '')
  try { return Buffer.from(b64, 'base64').toString('utf8') } catch { return null }
}

/**
 * Detect the remote DSH profile. POSIX only for v1 (Windows remotes get a
 * clean unsupported message — the uni-bootstrap skill bootstraps those).
 * @returns {{home: string, name: string, dir: string} | {error: string}}
 */
async function detectRemoteProfile(pool) {
  const uname = await remoteRun(pool, 'uname -s', 15000)
  if (uname.code !== 0) return { error: 'uni-sync v1 仅支持 POSIX 远端（macOS/Linux）；Windows 远端请用 uni-bootstrap 引导' }
  const homeRes = await remoteRun(pool, 'printf %s "$HOME"', 15000)
  const home = homeRes.stdout.trim()
  if (!home) return { error: '无法确定远端 $HOME' }
  const ls = await remoteRun(pool, 'ls -1d "$HOME"/.dsh/profiles/*/ 2>/dev/null', 15000)
  const names = ls.stdout.split('\n').map((l) => l.trim().replace(/\/$/, '')).filter(Boolean)
    .map((p) => p.split('/').pop())
  if (!names.length) return { error: '远端未发现 ~/.dsh/profiles/*——先在远端安装并启动一次 dsh（uni-bootstrap 一键引导在 M7）' }
  const name = names.includes('desktop') ? 'desktop' : names[0]
  return { home, name, dir: `${home}/.dsh/profiles/${name}` }
}

/** Read remote profile state in the shape diffProfile() expects. */
async function readRemoteProfileState(pool, dir) {
  const pkgText = await remoteReadFile(pool, `${dir}/package.json`)
  let dependencies = {}
  let bundles = []
  if (pkgText) {
    try {
      const pkg = JSON.parse(pkgText)
      dependencies = pkg.dependencies ?? {}
      bundles = Array.isArray(pkg.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : []
    } catch { /* corrupt remote json → treated as empty; push overwrites */ }
  }
  const patchText = await remoteReadFile(pool, `${dir}/cordis.patch.yml`)
  let overlayRowIds = []
  if (patchText) {
    try {
      const doc = yamlParse(patchText)
      if (Array.isArray(doc)) overlayRowIds = doc.filter((e) => e && typeof e.id === 'string').map((e) => e.id)
    } catch { /* unreadable patch → rows considered missing; backup is taken */ }
  }
  return { dependencies, bundles, overlayRowIds, hasPackageJson: !!pkgText }
}

/**
 * Offline channel: pack a local directory into a versioned tarball.
 * @returns {Promise<{tgzPath: string, fileName: string}>}
 */
async function npmPackDir(localDir) {
  const dest = join(tmpdir(), `uni-sync-pack-${Date.now()}`)
  await execFileP('mkdir', ['-p', dest])
  const { stdout } = await execFileP('npm', ['pack', localDir, '--pack-destination', dest], { timeoutMs: 120000 })
  const fileName = stdout.trim().split('\n').pop().trim()
  return { tgzPath: join(dest, fileName), fileName }
}

/**
 * Resolve a non-registry spec to a local directory we can `npm pack`.
 * file:<path> → that path; link:<pkg> → local profile node_modules real path;
 * anything else (github:…) → null (skipped with a reason).
 */
function resolveSpecToLocalDir(spec, localProfileDir) {
  const m = /^(?:file|link):(.+)$/.exec(spec)
  if (!m) return null
  let p = m[1]
  if (!p.startsWith('/')) p = join(localProfileDir, p) // relative file: spec
  if (!existsSync(p)) return null
  return resolveReal(p)
}

/** SFTP upload (promisified fastPut). */
async function sftpUpload(pool, localPath, remotePath) {
  const sftp = await pool.sftp()
  const fastPut = promisify(sftp.fastPut.bind(sftp))
  try { await fastPut(localPath, remotePath) } finally { try { sftp.end() } catch { /* already closed */ } }
}

async function sftpWriteFile(pool, remotePath, data) {
  const sftp = await pool.sftp()
  const write = promisify(sftp.writeFile.bind(sftp))
  try { await write(remotePath, data, 'utf8') } finally { try { sftp.end() } catch { /* already closed */ } }
}

/**
 * Build the push plan for one machine (no remote side effects).
 * Shared by `plan` and `push` so the UI preview cannot drift from execution.
 */
async function buildMachinePlan({ pool, localProfileDir, selfRoot }) {
  const profile = await detectRemoteProfile(pool)
  if (profile.error) return { error: profile.error }
  const local = collectLocalProfile(localProfileDir)
  const remote = await readRemoteProfileState(pool, profile.dir)
  // The fork itself is handled by the offline channel, never as a registry dep.
  const selfSpec = local.dependencies['dsh-uni-remote']
  const depsForDiff = Object.fromEntries(
    Object.entries(local.dependencies).filter(([n]) => n !== 'dsh-uni-remote'))
  const plan = buildSyncPlan(diffProfile(
    { dependencies: depsForDiff, bundles: local.bundles, overlayRows: local.overlayRows },
    remote))
  plan.skipped = []
  let selfDelivery = null
  if (selfSpec) {
    const localDir = (selfSpec.startsWith('file:') || selfSpec.startsWith('link:'))
      ? (resolveSpecToLocalDir(selfSpec, localProfileDir) || selfRoot)
      : selfRoot
    selfDelivery = { spec: selfSpec, localDir }
  }
  return { profile, plan, selfDelivery, remote }
}

/**
 * Execute a push. Steps are reported individually; a failed step stops the
 * run (remote files stay consistent: package.json is written in one shot,
 * previous file kept as .bak-<ts>).
 */
async function executePush({ pool, profile, plan, selfDelivery, localProfileDir, steps }) {
  const dir = profile.dir
  const ts = bakSuffix()

  // ── step: self tarball upload ──────────────────────────────────────────
  let selfRemoteDep = null
  if (selfDelivery) {
    const step = { step: 'pack-self', ok: false }
    steps.push(step)
    try {
      const packed = await npmPackDir(selfDelivery.localDir)
      await remoteRun(pool, `mkdir -p "${dir}/uni-packs"`, 15000)
      await sftpUpload(pool, packed.tgzPath, `${dir}/uni-packs/${packed.fileName}`)
      selfRemoteDep = `file:uni-packs/${packed.fileName}`
      step.ok = true
      step.detail = packed.fileName
    } catch (err) {
      step.detail = String((err && err.message) || err)
      return { error: `uni-sync: 自打包上传失败：${step.detail}` }
    }
  }

  // ── step: merge + write remote package.json ────────────────────────────
  const stepPkg = { step: 'write-package-json', ok: false }
  steps.push(stepPkg)
  try {
    const pkgText = await remoteReadFile(pool, `${dir}/package.json`)
    const pkg = pkgText ? JSON.parse(pkgText) : { name: 'dsh-profile', private: true }
    pkg.dependencies = { ...(pkg.dependencies ?? {}) }
    pkg.dsh = { ...(pkg.dsh ?? {}), profile: { ...(pkg.dsh?.profile ?? {}), bundles: [...(pkg.dsh?.profile?.bundles ?? [])] } }
    for (const spec of plan.npmInstall) {
      const at = spec.lastIndexOf('@')
      pkg.dependencies[spec.slice(0, at)] = spec.slice(at + 1)
    }
    for (const { name, spec } of plan.nonRegistrySpecs) {
      const localDir = resolveSpecToLocalDir(spec, localProfileDir)
      if (!localDir) { plan.skipped.push({ name, reason: `非 registry 且本地无对应目录可打包：${spec}` }); continue }
      const packed = await npmPackDir(localDir)
      await remoteRun(pool, `mkdir -p "${dir}/uni-packs"`, 15000)
      await sftpUpload(pool, packed.tgzPath, `${dir}/uni-packs/${packed.fileName}`)
      pkg.dependencies[name] = `file:uni-packs/${packed.fileName}`
    }
    if (selfRemoteDep) pkg.dependencies['dsh-uni-remote'] = selfRemoteDep
    for (const b of plan.bundlesAppend) if (!pkg.dsh.profile.bundles.includes(b)) pkg.dsh.profile.bundles.push(b)
    if (pkgText) await remoteRun(pool, `cp "${dir}/package.json" "${dir}/package.json${ts}"`, 15000)
    await sftpWriteFile(pool, `${dir}/package.json`, JSON.stringify(pkg, null, 2) + '\n')
    stepPkg.ok = true
    stepPkg.detail = `dependencies=${Object.keys(pkg.dependencies).length} bundles=${pkg.dsh.profile.bundles.length}`
  } catch (err) {
    stepPkg.detail = String((err && err.message) || err)
    return { error: `uni-sync: 远端 package.json 写入失败（原文件备份于 ${ts}）：${stepPkg.detail}` }
  }

  // ── step: overlay rows append ──────────────────────────────────────────
  if (plan.overlayRows.length) {
    const stepPatch = { step: 'append-overlay-rows', ok: false }
    steps.push(stepPatch)
    try {
      const existing = await remoteReadFile(pool, `${dir}/cordis.patch.yml`)
      const doc = existing ? yamlParse(existing) : []
      const rows = Array.isArray(doc) ? doc : []
      const have = new Set(rows.filter((e) => e && typeof e.id === 'string').map((e) => e.id))
      let added = 0
      for (const row of plan.overlayRows) {
        if (have.has(row.id)) continue
        rows.push(sanitizeOverlayRow(row.yml))
        added++
      }
      if (added > 0) {
        if (existing) await remoteRun(pool, `cp "${dir}/cordis.patch.yml" "${dir}/cordis.patch.yml${ts}" 2>/dev/null`, 15000)
        await sftpWriteFile(pool, `${dir}/cordis.patch.yml`, yamlStringify(rows))
      }
      stepPatch.ok = true
      stepPatch.detail = `added=${added} skipped=${plan.overlayRows.length - added}`
    } catch (err) {
      stepPatch.detail = String((err && err.message) || err)
      return { error: `uni-sync: 覆盖行写入失败：${stepPkg.detail} / ${stepPatch.detail}` }
    }
  }

  // ── step: remote npm install ───────────────────────────────────────────
  const stepInst = { step: 'npm-install', ok: false }
  steps.push(stepInst)
  const inst = await remoteRun(pool,
    `cd "${dir}" && npm install --no-audit --no-fund --loglevel=error`,
    300000)
  stepInst.ok = inst.code === 0
  stepInst.detail = inst.stdout.trim().split('\n').slice(-4).join('\n') || '(no output)'
  if (inst.code !== 0) {
    return { error: `uni-sync: 远端 npm install 失败（exit ${inst.code}）：${stepInst.detail}` }
  }

  return {
    ok: true,
    restartHint: '远程 dsh 进程重启后新插件生效（webAttach 已在跑的实例不自动重启）',
  }
}

/**
 * Route factory. Deps come from the dsh-remote entry's apply() closure so the
 * uni layer reuses THE connection pool (no second SSH stack, no credential
 * duplication).
 * @param {object} deps
 * @param {(res: object, status: number, body: object) => void} deps.sendJson
 * @param {(req: object) => Promise<string>} deps.readBody
 * @param {Array<object>} deps.machines - registry records (store.list)
 * @param {() => string|null} deps.getCurrentId - store.currentId accessor
 * @param {(machine: object) => object} deps.poolForMachine - SshPool accessor
 * @param {() => string} [deps.localProfileDir] - override for tests
 */
export function createUniSyncRoutes(deps = {}) {
  const sendJson = deps.sendJson
  const readBody = deps.readBody
  const machines = () => deps.machines || []
  const localProfileDir = deps.localProfileDir || uniLocalProfileDir
  const selfRoot = deps.selfRoot || uniSelfRoot

  const resolveMachine = (machineId) => {
    const list = machines()
    if (machineId) return list.find((m) => String(m.id) === String(machineId)) || null
    const cur = deps.getCurrentId ? deps.getCurrentId() : null
    return (cur && list.find((m) => String(m.id) === String(cur))) || list[0] || null
  }

  return [
    {
      kind: 'exact',
      path: UNI_SYNC_PATH,
      handler: async (req, res) => {
        if (req.method === 'GET') {
          try {
            const dir = localProfileDir()
            const local = collectLocalProfile(dir)
            return sendJson(res, 200, {
              ok: true,
              self: uniSelfInfo(selfRoot()),
              localProfile: {
                dir,
                dependencies: local.dependencies,
                bundles: local.bundles,
                overlayRows: local.overlayRows.map((r) => r.id),
              },
            })
          } catch (err) {
            return sendJson(res, 500, { ok: false, error: `uni-sync: 本机 profile 读取失败：${String((err && err.message) || err)}` })
          }
        }
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })

        let body = {}
        try { body = JSON.parse((await readBody(req)) || '{}') } catch { /* keep {} */ }
        const action = body.action === 'push' ? 'push' : 'plan'
        const machine = resolveMachine(body.machineId)
        if (!machine) return sendJson(res, 400, { ok: false, error: 'uni-sync: 未找到目标机器（先在「远程工作区」保存并连接一台服务器）' })

        try {
          const pool = deps.poolForMachine(machine)
          const built = await buildMachinePlan({ pool, localProfileDir: localProfileDir(), selfRoot: selfRoot() })
          if (built.error) return sendJson(res, 400, { ok: false, error: built.error })

          if (action === 'plan') {
            return sendJson(res, 200, {
              ok: true,
              action: 'plan',
              machine: { id: machine.id, host: machine.host, username: machine.username },
              profile: built.profile,
              plan: built.plan,
              selfDelivery: built.selfDelivery ? { spec: built.selfDelivery.spec } : null,
            })
          }

          const steps = []
          const result = await executePush({
            pool,
            profile: built.profile,
            plan: built.plan,
            selfDelivery: built.selfDelivery,
            localProfileDir: localProfileDir(),
            steps,
          })
          if (result.error) {
            return sendJson(res, 500, { ok: false, action: 'push', machine: { id: machine.id }, steps, error: result.error })
          }
          return sendJson(res, 200, {
            ok: true,
            action: 'push',
            machine: { id: machine.id, host: machine.host },
            steps,
            skipped: built.plan.skipped,
            upToDate: built.plan.skippedUpToDate,
            ...result,
          })
        } catch (err) {
          return sendJson(res, (err && err.httpStatus) || 500, { ok: false, error: `uni-sync: ${String((err && err.message) || err)}` })
        }
      },
    },
  ]
}

// re-exported so plugin.js/tests reuse the pipeline without deep imports
export { collectLocalProfile, buildSyncPlan, profilePaths, uniSelfInfo as selfInfo }
