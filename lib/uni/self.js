/**
 * uni-self: version display + git-based self-update (uni.8).
 *
 * The fork disables the upstream auto-updater (DEFAULT_UPDATE_MODE='off',
 * UNI_SELF_UPDATE guards in update.js/self-heal.js). This module provides the
 * EXPLICIT replacement: a settings-page header that shows the installed
 * version/commit, checks the GitHub remote for newer commits, and performs a
 * user-initiated `git pull --ff-only`. Restarting DSH activates the pulled
 * code — the running process keeps the old modules until then.
 *
 * Requirements: the install must be a git clone (the documented manual `link:`
 * install is one). npm/market installs have no .git and report that clearly.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

const GIT_TIMEOUT = 30000
const FETCH_TIMEOUT = 45000

async function git(root, args, timeoutMs = GIT_TIMEOUT) {
  try {
    const { stdout } = await exec('git', args, { cwd: root, timeout: timeoutMs })
    return { ok: true, stdout: String(stdout || '').trim() }
  } catch (err) {
    const reason = err && err.killed ? 'timeout' : String((err && err.stderr) || err.message || err).trim().split('\n').pop()
    return { ok: false, error: reason }
  }
}

/**
 * Collect install + git state for the settings header.
 * @returns {Promise<{name, version, branch, commit, dirty, ahead, behind, remoteError?}>}
 *   `behind: null` = could not compare (no network / fetch failed).
 */
export async function uniGitInfo(root) {
  const info = { name: 'dsh-uni-remote', version: null, branch: null, commit: null, dirty: 0, behind: null, remoteError: null }
  try {
    const fs = await import('node:fs')
    const pkg = JSON.parse(fs.readFileSync(`${root}/package.json`, 'utf8'))
    info.name = pkg.name || info.name
    info.version = pkg.version
  } catch { /* keep defaults */ }

  const isRepo = await git(root, ['rev-parse', '--is-inside-work-tree'])
  if (!isRepo.ok || isRepo.stdout !== 'true') {
    info.remoteError = 'not a git checkout — reinstall via git clone to enable updates'
    return info
  }

  const branch = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const commit = await git(root, ['rev-parse', '--short', 'HEAD'])
  info.branch = branch.ok ? branch.stdout : null
  info.commit = commit.ok ? commit.stdout : null

  const status = await git(root, ['status', '--porcelain'])
  info.dirty = status.ok ? status.stdout.split('\n').filter(Boolean).length : -1

  const fetch = await git(root, ['fetch', 'origin'], FETCH_TIMEOUT)
  if (!fetch.ok) {
    info.remoteError = `fetch failed: ${fetch.error}`
    return info
  }
  const rev = await git(root, ['rev-list', '--left-right', '--count', `HEAD...origin/${info.branch || 'main'}`])
  if (rev.ok) {
    const [ahead, behind] = rev.stdout.split('\t').map(Number)
    info.ahead = ahead
    info.behind = behind
  } else {
    info.remoteError = `compare failed: ${rev.error}`
  }
  return info
}

/**
 * Update to the latest origin commit. Fast-forward only — a dirty tree or
 * diverged history refuses instead of merging anything.
 */
export async function uniGitUpdate(root) {
  const info = await uniGitInfo(root)
  if (info.remoteError && info.remoteError.startsWith('not a git')) return { ok: false, error: info.remoteError }
  if (info.dirty > 0) return { ok: false, error: `working tree has ${info.dirty} local change(s) — refusing to pull`, info }
  const branch = info.branch || 'main'
  const pull = await git(root, ['pull', '--ff-only', 'origin', branch], GIT_TIMEOUT * 2)
  if (!pull.ok) return { ok: false, error: `pull failed: ${pull.error}`, info }
  const after = await uniGitInfo(root)
  return { ok: true, output: pull.stdout, info: after }
}
