// dsh-uni-remote — P4 one-click plugin push engine (scaffold).
//
// Charter (DESIGN.md §6.1, repo UNI.md): ONE button, ONE-WAY push, local is
// the single source of truth. Clicking "同步插件" on a connected machine row
// pushes the local plugin environment to that machine.
//
// What gets pushed — the three registration artifacts (verified 2026-11-13
// against dsh-mnemon/dsh-remote installs):
//   1. profile package.json `dependencies`        (package presence + versions)
//   2. profile package.json `dsh.profile.bundles` (activation list; a missing
//      row = the bundle's own cordis.patch.yml layer never loads)
//   3. the user patch layer (profile cordis.patch.yml) — top-level `- id:`
//      overlay rows carrying per-plugin settings.
//     ⚠️ NEVER copy a bundle's own cordis.patch.yml insert block into the
//     user layer: duplicate entry IDs break Settings saving (upstream
//     issue #470). Only user overlay rows are replicated.
//
// Machine-specific fields (SSH hosts, listen ports, absolute paths) must not
// be pushed verbatim; sanitizeOverlayRows() strips the known ones.
//
// This module is PURE: no SSH, no fs writes outside arguments it is given.
// lib/uni/plugin.js wires it into the host; M6 (DESIGN.md) connects it to
// dsh-remote's rw_* exec/upload transports.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'

/** Default profile dir layout: ~/.dsh/profiles/<profile>/ */
export function profilePaths(profileDir) {
  return {
    packageJsonPath: join(profileDir, 'package.json'),
    patchPath: join(profileDir, 'cordis.patch.yml'),
  }
}

/**
 * Collect the local three-piece profile state.
 * @param {string} profileDir absolute path of the local DSH profile
 * @returns {{ dependencies: Record<string,string>, bundles: string[],
 *             overlayRows: Array<{id: string, yml: string}> }}
 */
export function collectLocalProfile(profileDir) {
  const { packageJsonPath, patchPath } = profilePaths(profileDir)
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
  const dsh = pkg.dsh ?? {}
  const bundles = Array.isArray(dsh.profile?.bundles) ? dsh.profile.bundles.slice() : []
  const overlayRows = readUserOverlayRows(patchPath)
  return { dependencies: { ...(pkg.dependencies ?? {}) }, bundles, overlayRows }
}

/**
 * Parse the USER patch layer into top-level `- id:` rows.
 * The user layer must only contain overlay rows (never bundle insert blocks);
 * rows are kept verbatim as YAML text so the remote side receives settings
 * exactly as authored locally.
 * @returns {Array<{id: string, yml: string}>}
 */
export function readUserOverlayRows(patchPath) {
  let text
  try {
    text = readFileSync(patchPath, 'utf8')
  } catch {
    return []
  }
  const doc = parse(text)
  if (!Array.isArray(doc)) return []
  const rows = []
  for (const entry of doc) {
    if (entry && typeof entry === 'object' && typeof entry.id === 'string') {
      rows.push({ id: entry.id, yml: entry })
    }
  }
  return rows
}

/**
 * Field-level diff of the three pieces against the remote profile state.
 * Exact-version matches are skipped (bandwidth saver, invisible to the user).
 * @param {{dependencies,bundles,overlayRows}} local
 * @param {{dependencies:Record<string,string>,bundles:string[],overlayRowIds:string[]}} remote
 */
export function diffProfile(local, remote) {
  const depsToInstall = []
  const depsUpToDate = []
  for (const [name, want] of Object.entries(local.dependencies)) {
    const have = remote.dependencies?.[name]
    if (have === want) depsUpToDate.push(name)
    else depsToInstall.push({ name, want, have: have ?? null })
  }
  const bundlesToAdd = local.bundles.filter((b) => !(remote.bundles ?? []).includes(b))
  const rowsToPush = local.overlayRows.filter((r) => !(remote.overlayRowIds ?? []).includes(r.id))
  return { depsToInstall, depsUpToDate, bundlesToAdd, rowsToPush, changed: depsToInstall.length + bundlesToAdd.length + rowsToPush.length > 0 }
}

/**
 * Strip machine-specific values from an overlay row before pushing.
 * Conservative deny-list for v0.1; extend as real profiles teach us more.
 */
const MACHINE_SPECIFIC_KEYS = [
  'host', 'port', 'webAttachPortStart', 'listen', 'bind', 'url', 'endpoint',
  'cliPath', 'dataDir', 'homeDir', 'workdir', 'cwd',
]

export function sanitizeOverlayRow(row) {
  if (!row || typeof row !== 'object') return row
  const out = structuredClone(row)
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    for (const key of Object.keys(node)) {
      if (MACHINE_SPECIFIC_KEYS.includes(key)) delete node[key]
      else if (typeof node[key] === 'object') walk(node[key])
    }
  }
  walk(out)
  return out
}

/**
 * Build the remote execution plan (M6 wires the transports).
 * Registry-installable specs go to `npmInstall` (remote `npm install`).
 * git/file/link specs (e.g. `github:…`, `file:/…`, `link:/…`) can't be
 * resolved on a remote host — they land in `nonRegistrySpecs` for the offline
 * channel (local npm pack / vendored copy + SFTP upload) or a warning.
 */
export function buildSyncPlan(diff) {
  const npmInstall = []
  const nonRegistrySpecs = []
  for (const d of diff.depsToInstall) {
    // registry spec: optional ^/~ prefix + optional @scope/ + version, no colon, no path slash
    if (/^[~^]?(@[\w.-]+\/)?[\w.-]+$/.test(d.want)) npmInstall.push(`${d.name}@${d.want}`)
    else nonRegistrySpecs.push({ name: d.name, spec: d.want })
  }
  return {
    npmInstall,
    nonRegistrySpecs,
    bundlesAppend: diff.bundlesToAdd,
    overlayRows: diff.rowsToPush.map((r) => ({ id: r.id, yml: sanitizeOverlayRow(r.yml) })),
    skippedUpToDate: diff.depsUpToDate,
    restartRemoteDsh: diff.changed,
  }
}
