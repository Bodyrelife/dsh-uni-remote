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

export function listLocalInbox(homeDir, { unreadOnly = false, from } = {}) {
  const inbox = path.join(uniMailboxRoot(homeDir), 'inbox')
  if (!existsSync(inbox)) return []
  const mails = []
  for (const sender of readdirSync(inbox)) {
    if (sender.startsWith('.')) continue
    const dir = path.join(inbox, sender)
    let files
    try { files = readdirSync(dir) } catch { continue }
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      try {
        const mail = JSON.parse(readFileSync(path.join(dir, f), 'utf8'))
        mail.dir = sender
        if (mail.readAt === undefined && from && mail.from !== from) continue
        if (unreadOnly && mail.readAt !== undefined) continue
        mails.push(mail)
      } catch { /* torn file → skip; writer uses atomic end() */ }
    }
  }
  mails.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
  return mails
}

export function readLocalMail(homeDir, id) {
  const inbox = path.join(uniMailboxRoot(homeDir), 'inbox')
  if (!existsSync(inbox)) return undefined
  for (const sender of readdirSync(inbox)) {
    if (sender.startsWith('.')) continue
    const file = path.join(inbox, sender, `${id}.json`)
    if (!existsSync(file)) continue
    const mail = JSON.parse(readFileSync(file, 'utf8'))
    if (mail.readAt === undefined) {
      mail.readAt = new Date().toISOString()
      writeFileSync(file, JSON.stringify(mail, null, 2) + '\n')
    }
    return mail
  }
  return undefined
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

// ── tool factory ───────────────────────────────────────────────────────────

/**
 * Build the uni_* mailbox tools.
 * @param deps.store     machines store ({list, currentId})
 * @param deps.poolForMachine(machine) → SshPool
 * @param deps.resolveHome(pool) → remote home dir (detectRemoteProfile-like)
 * @param deps.machineName sender identity override (default hostname)
 * @param deps.homeDir   local home for the local half of the mailbox
 */
export function createUniMailTools(deps = {}) {
  const { store, poolForMachine, resolveHome, machineName, homeDir } = deps
  const from = () => senderIdentity(machineName)

  const findMachine = (raw) => {
    const key = String(raw || '').trim().toLowerCase()
    const list = (store && store.list) || []
    if (!key) throw new Error('machine is required (saved machine name, id, or host — see rw_machines)')
    return list.find((m) => m.id === key || String(m.name || '').toLowerCase() === key || String(m.host || '').toLowerCase() === key)
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
        'Send a follow-up mail message to agents/machines on ANOTHER server (cross-machine mailbox). ' +
        'Delivery = a JSON file in the remote machine\'s ~/.dsh/uni-remote mailbox; agents there read it with uni_inbox/uni_read on their own turns. ' +
        'Address machines by saved name/id/host (see rw_machines). For messages within THIS machine use the harness\'s own messaging instead.',
      parameters: {
        type: 'object',
        properties: {
          machine: { type: 'string', required: true },
          to: { type: 'string' },
          subject: { type: 'string' },
          body: { type: 'string', required: true },
        },
      },
      output,
      async execute(args) {
        const machine = findMachine(args.machine)
        const pool = poolForMachine(machine)
        const home = await resolveHome(pool)
        const mail = {
          id: newMailId(),
          from: from(),
          to: String(args.to || '').trim() || '*',
          subject: String(args.subject || '').trim() || '(no subject)',
          body: String(args.body || ''),
          createdAt: new Date().toISOString(),
        }
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
        'List mail received from OTHER machines in the cross-machine mailbox (unread first). ' +
        'Call this at the start of a turn when a task might originate from another server, and whenever asked to check for remote messages.',
      parameters: {
        type: 'object',
        properties: {
          unreadOnly: { type: 'boolean' },
          from: { type: 'string' },
        },
      },
      output,
      async execute(args) {
        const mails = listLocalInbox(homeDir, { unreadOnly: args.unreadOnly === true, from: args.from ? String(args.from) : undefined })
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
