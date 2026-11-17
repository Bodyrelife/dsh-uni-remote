// uni mailbox — P3 M4 cross-machine agent messaging (file mailbox, followup only).
//
// Layout (both ends): <home>/.dsh/uni-remote/mailbox/
//   inbox/<fromMachine>/<ts>-<rand>.json   mail delivered to THIS machine
//   sent/<ts>-<rand>.json                  copy of everything we sent
// Mail JSON: { id, from, to, subject, body, createdAt, readAt? }
// Delivery is "followup only": the receiving agent polls with uni_inbox /
// uni_read on its own turn (its dsh-uni-remote exposes the same tools).
// Inject/steer + HTTP transport = M5 (DESIGN.md §5 plan A).
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'

const DIR_NAME_BAD = /[^A-Za-z0-9._-]+/g

export function uniMailboxRoot(homeDir) {
  const base = homeDir || process.env.UNI_MAILBOX_HOME || os.homedir()
  return path.join(base, '.dsh', 'uni-remote', 'mailbox')
}

export function senderIdentity(explicit) {
  const raw = explicit || process.env.UNI_MAILBOX_NAME || os.hostname()
  return String(raw).replace(DIR_NAME_BAD, '-').slice(0, 64) || 'unknown'
}

export function newMailId() {
  return `${Date.now()}-${randomBytes(4).toString('hex')}`
}

// ── local inbox (pure fs) ──────────────────────────────────────────────────

// ── local inbox (pure fs) ──────────────────────────────────────────────────

export function listLocalInbox(homeDir, { unreadOnly = false, from, to } = {}) {
  const inbox = path.join(uniMailboxRoot(homeDir), 'inbox')
  if (!existsSync(inbox)) return []
  // Walk the whole inbox tree: remote mail lands at inbox/<fromMachine>/*.json,
  // local mail at inbox/_local/<agent>/*.json — one level deeper.
  const files = []
  const walk = (dir) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.json')) files.push(p)
    }
  }
  walk(inbox)
  const mails = []
  for (const file of files) {
    try {
      const mail = JSON.parse(readFileSync(file, 'utf8'))
      mail.dir = path.basename(path.dirname(file))
      if (from && mail.from !== from) continue
      // Addressing: to='*' is a broadcast; a named `to` only matches itself
      // (case-insensitive), so an agent polling for its own name never sees
      // other agents' addressed mail but always sees broadcasts.
      if (to && String(mail.to || '*').toLowerCase() !== '*' && String(mail.to).toLowerCase() !== String(to).toLowerCase()) continue
      if (unreadOnly && mail.readAt !== undefined) continue
      mails.push(mail)
    } catch { /* torn file → skip; writer uses atomic end() */ }
  }
  mails.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
  return mails
}

export function readLocalMail(homeDir, id) {
  const inbox = path.join(uniMailboxRoot(homeDir), 'inbox')
  if (!existsSync(inbox)) return undefined
  const wanted = String(id || '').trim()
  let found
  const walk = (dir) => {
    if (found) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (found) return
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { if (!e.name.startsWith('.')) walk(p); continue }
      if (e.name !== `${wanted}.json`) continue
      const mail = JSON.parse(readFileSync(p, 'utf8'))
      if (mail.readAt === undefined) {
        mail.readAt = new Date().toISOString()
        writeFileSync(p, JSON.stringify(mail, null, 2) + '\n')
      }
      found = mail
    }
  }
  walk(inbox)
  return found
}

// ── remote delivery (pool = dsh-remote SshPool) ────────────────────────────

/** Absolute remote mailbox dir for mail TO the remote, FROM senderIdentity. */
export function remoteInboxDir(homeDir, fromMachine) {
  return `${homeDir}/.dsh/uni-remote/mailbox/inbox/${fromMachine}`
}

/** Write one mail into a remote inbox over the machine's SSH pool. */
export async function deliverRemoteMail(pool, remoteHome, fromMachine, mail) {
  const dir = remoteInboxDir(remoteHome, fromMachine)
  const res = await pool.exec(`mkdir -p '${dir}'`, { timeoutMs: 15000 })
  if (res.code !== 0) throw new Error(`mkdir failed on remote: ${(res.stderr || res.stdout || '').trim()}`)
  let sftp
  try {
    sftp = await pool.sftp()
    await new Promise((resolve, reject) => {
      const ws = sftp.createWriteStream(`${dir}/${mail.id}.json`)
      ws.on('error', reject)
      ws.end(JSON.stringify(mail, null, 2) + '\n', resolve)
    })
  } finally {
    try { sftp?.end() } catch { /* already closed */ }
  }
  return `${dir}/${mail.id}.json`
}

/**
 * Deliver one mail to THIS machine's inbox (same-machine session messaging).
 * The sender folder distinguishes the transport: `_local` marks machine-local
 * mail; the layout is otherwise identical to remote-delivered mail, so
 * uni_inbox/uni_read treat both uniformly.
 */
export function deliverLocalMail(homeDir, fromAgent, mail) {
  const dir = path.join(uniMailboxRoot(homeDir), 'inbox', '_local', fromAgent)
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${mail.id}.json`)
  writeFileSync(file, JSON.stringify(mail, null, 2) + '\n')
  return file
}

// ── tool factory ───────────────────────────────────────────────────────────

/**
 * Build the uni_* mailbox tools.
 * @param deps.store     machines store ({list, currentId})
 * @param deps.poolForMachine(machine) → SshPool
 * @param deps.resolveHome(pool) → remote home dir (detectRemoteProfile-like)
 * @param deps.machineName sender identity override (default hostname)
 * @param deps.homeDir   local home for the local half of the mailbox
 */export function createUniMailTools(deps = {}) {
  const { store, poolForMachine, resolveHome, machineName, homeDir } = deps
  const from = () => senderIdentity(machineName)
  const isLocalTarget = (raw) => {
    const v = String(raw || '').trim().toLowerCase()
    return v === '' || ['local', 'this', 'this machine', 'self', '本机'].includes(v)
  }

  const findMachine = (raw) => {
    const key = String(raw || '').trim().toLowerCase()
    if (isLocalTarget(key)) return undefined // local delivery
    const list = (store && store.list) || []
    const hit = list.find((m) => m.id === key || String(m.name || '').toLowerCase() === key || String(m.host || '').toLowerCase() === key)
    if (!hit) throw new Error(`no saved machine matches "${raw}" (see rw_machines); omit machine or use "local" for same-machine delivery`)
    return hit
  }

  const text = (v) => [{ type: 'text', text: v }]
  const output = {
    schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
    render: (_a, v) => text(v.text),
  }

  return [
    {
      name: 'uni_send',
      description:
        'Send a mailbox message to another agent or machine. ' +
        'SAME MACHINE: omit `machine` (or pass "local") and address `to` by agent/session name — delivered instantly to this machine\'s mailbox. ' +
        'OTHER MACHINE: pass a saved machine name/id/host (see rw_machines) — delivered as a JSON file in that machine\'s ~/.dsh/uni-remote mailbox, where agents read it with uni_inbox/uni_read on their own turns. ' +
        '`to` "*" (default) broadcasts; a named `to` is private to that recipient. ' +
        'mode: "mail" (default, passive — recipient polls uni_inbox) | "followup" | "inject" | "steer" — the three live modes are auto-delivered into the named target session by the receiving machine\'s mailbox watcher (requires dsh-uni-remote >= uni.7 running there; followup/inject/steer need a NAMED `to`, not "*").',
      parameters: {
        type: 'object',
        properties: {
          machine: { type: 'string' },
          to: { type: 'string' },
          subject: { type: 'string' },
          body: { type: 'string', required: true },
          mode: { type: 'string' },
          replyTo: { type: 'string', description: 'mail id this message answers (used by uni_task result routing)' },
        },
      },
      output,
      async execute(args) {
        const machine = findMachine(args.machine)
        const to = String(args.to || '').trim() || '*'
        const modeRaw = String(args.mode || 'mail').trim().toLowerCase()
        if (!['mail', 'followup', 'inject', 'steer'].includes(modeRaw)) throw new Error(`mode must be mail|followup|inject|steer (got "${args.mode}")`)
        const replyTo = String(args.replyTo || '').trim()
        const mail = {
          id: newMailId(),
          from: from(),
          to,
          subject: String(args.subject || '').trim() || '(no subject)',
          body: String(args.body || ''),
          createdAt: new Date().toISOString(),
          ...(modeRaw === 'mail' ? {} : { mode: modeRaw }),
          ...(replyTo ? { replyTo } : {}),
        }
        if (!machine) {
          // Live local modes go straight through the host seam when wired
          // (createUniMailTools receives deliverLocal from index.js); the mail
          // file is still recorded so uni_inbox/sent history stays complete.
          if (modeRaw !== 'mail' && typeof deps.deliverLocal === 'function') {
            const sessionId = await deps.deliverLocal(modeRaw, to, mail.body)
            const sentDir = path.join(uniMailboxRoot(homeDir), 'sent')
            mkdirSync(sentDir, { recursive: true })
            writeFileSync(path.join(sentDir, `${mail.id}.json`), JSON.stringify({ ...mail, deliveredSession: sessionId }, null, 2) + '\n')
            return { text: `sent ${mail.id} (${modeRaw}) → live session ${sessionId}; copy filed in sent/` }
          }
          const file = deliverLocalMail(homeDir, from(), mail)
          return { text: `sent ${mail.id} → ${to === '*' ? 'all local agents' : `local agent "${to}"`} (${file}); recipient reads it with uni_inbox/uni_read` }
        }
        const pool = poolForMachine(machine)
        const home = await resolveHome(pool)
        const remotePath = await deliverRemoteMail(pool, home, from(), mail)
        const sentDir = path.join(uniMailboxRoot(homeDir), 'sent')
        mkdirSync(sentDir, { recursive: true })
        writeFileSync(path.join(sentDir, `${mail.id}.json`), JSON.stringify({ ...mail, machine: machine.name, remotePath }, null, 2) + '\n')
        return { text: `sent ${mail.id} → ${machine.name || machine.host} (${remotePath}); recipient reads it with uni_inbox on that machine` }
      },
    },
    {
      name: 'uni_inbox',
      description:
        'List mail in the cross-agent/cross-machine mailbox: messages from other machines AND from other sessions on this machine. ' +
        'Call this at the start of a turn when a task might originate elsewhere, and whenever asked to check for messages. ' +
        '`to` filters addressing: broadcasts (to="*") always show; named mail only shows for the exact recipient name you pass.',
      parameters: {
        type: 'object',
        properties: {
          unreadOnly: { type: 'boolean' },
          from: { type: 'string' },
          to: { type: 'string' },
        },
      },
      output,
      async execute(args) {
        const mails = listLocalInbox(homeDir, {
          unreadOnly: args.unreadOnly === true,
          from: args.from ? String(args.from) : undefined,
          to: args.to ? String(args.to) : undefined,
        })
        if (mails.length === 0) return { text: 'mailbox empty (no mail matches)' }
        const lines = mails.map((m) => [
          `${m.id}`,
          `from=${m.from} to=${m.to}`,
          `${m.subject}`,
          `at=${m.createdAt}${m.readAt ? ' READ' : ' UNREAD'}`,
        ].join(' | '))
        return { text: `${mails.length} mail(s):\n${lines.join('\n')}` }
      },
    },
    {
      name: 'uni_read',
      description:
        'Read one mail from the cross-machine mailbox by id (uni_inbox lists ids). Marks the mail as read.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', required: true } },
      },
      output,
      async execute(args) {
        const mail = readLocalMail(homeDir, String(args.id || '').trim())
        if (!mail) return { text: `no mail with id ${args.id}` }
        return { text: JSON.stringify(mail, null, 2) }
      },
    },
  ]
}
