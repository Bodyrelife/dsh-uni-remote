// uni steer — P3 M5 live session injection on THIS machine (host seam).
//
// First-party pattern (dsh-cordis-host-runner):
//   const agent = ctx.get('agents')?.get(sessionId)
//   agent.steer(createUserMessage({ content: [{ type: 'text', text }], source: { kind } }))
// Agent API (dsh-agent-loop): followup(input) queues next-turn + wake,
// steer(input) queues next-step + wake (interrupt), inject(input) queues
// next-step without wake. All take a message from createUserMessage
// (@deepseek-ai/dsh-llm, resolved from the host app tree like dsh-tools).
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { listLocalInbox } from './mailbox.js'

const AUTO_MODES = new Set(['followup', 'inject', 'steer'])

function agentLabel(agent) {
  return agent?.name || agent?.title || agent?.label || agent?.persona?.name || ''
}

/**
 * Resolve the local agents registry defensively: only .get(id) is a contract;
 * enumeration APIs are probed so uni_agents degrades to an empty list rather
 * than throwing on future host versions.
 */
function agentsRegistry(ctx) {
  try { return ctx.get('agents') || null } catch { return null }
}

function iterAgents(reg) {
  const out = []
  try {
    if (typeof reg.values === 'function') { for (const a of reg.values()) out.push(a); return out }
    if (typeof reg[Symbol.iterator] === 'function') { for (const a of reg) out.push(a); return out }
  } catch { /* fallthrough */ }
  return out
}

export function createUniSteer({ ctx, homeDir, log }) {
  const info = (msg) => { try { log?.('info', msg) } catch { /* log seam optional */ } }

  async function loadCreateUserMessage() {
    const mod = await import('@deepseek-ai/dsh-llm')
    if (typeof mod.createUserMessage !== 'function') throw new Error('@deepseek-ai/dsh-llm did not export createUserMessage')
    return mod.createUserMessage
  }

  function listAgents() {
    const reg = agentsRegistry(ctx)
    if (!reg) return []
    return iterAgents(reg).map((a) => ({
      id: a?.id,
      name: agentLabel(a) || undefined,
      status: typeof a?.status === 'string' ? a.status : undefined,
    })).filter((a) => a.id)
  }

  function resolveAgent(ref) {
    const reg = agentsRegistry(ctx)
    if (!reg) throw new Error('host agents registry unavailable (ctx.get("agents") returned nothing)')
    const key = String(ref || '').trim()
    if (!key) throw new Error('session reference required (id or name; list with uni_agents)')
    const direct = reg.get(key)
    if (direct !== undefined && direct !== null) return direct
    const lower = key.toLowerCase()
    const hit = iterAgents(reg).find((a) => String(agentLabel(a) || '').toLowerCase() === lower)
    if (!hit) {
      const known = listAgents().map((a) => `${a.id}${a.name ? ` (${a.name})` : ''}`).join(', ')
      throw new Error(`no live session matches "${key}"${known ? ` — live sessions: ${known}` : ' — no live sessions enumerated'}`)
    }
    return hit
  }

  async function deliver(mode, sessionRef, body) {
    const m = String(mode || '').toLowerCase()
    if (!AUTO_MODES.has(m)) throw new Error(`mode must be one of followup|inject|steer (got "${mode}")`)
    const agent = resolveAgent(sessionRef)
    const createUserMessage = await loadCreateUserMessage()
    const message = createUserMessage({
      content: [{ type: 'text', text: String(body || '') }],
      source: { kind: 'uni-remote' },
    })
    if (ctx.get('agents')?.get(agent.id) !== agent) throw new Error(`session "${agent.id}" was disposed before delivery`)
    agent[m](message)
    return agent.id
  }

  // ── mailbox watcher: auto-deliver followup/inject/steer mail ──────────────
  // Mail with mode 'mail' (default) stays passive (recipient polls uni_inbox).
  // Auto modes are delivered into the named local session the moment this
  // process sees the file — that is the cross-machine inject/steer channel:
  // the REMOTE machine's own watcher does the injecting over there.
  let timer = null
  const seen = new Set() // mail ids already handled this process lifetime

  function markDelivered(file, id) {
    try {
      const mail = JSON.parse(fs.readFileSync(file, 'utf8'))
      mail.deliveredAt = new Date().toISOString()
      fs.writeFileSync(file, JSON.stringify(mail, null, 2) + '\n')
    } catch (err) { info(`[dsh-uni-remote] watcher: could not mark ${id} delivered: ${String((err && err.message) || err)}`) }
  }

  function findMailFile(id) {
    // listLocalInbox returns plain objects; locate the backing file by walking
    // the inbox tree (same layout contract as mailbox.js).
    const root = path.join(homeDir || os.homedir(), '.dsh', 'uni-remote', 'mailbox', 'inbox')
    if (!fs.existsSync(root)) return undefined
    let found
    const walk = (dir) => {
      if (found) return
      let entries
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        if (found) return
        if (e.name.startsWith('.')) continue
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (e.name === `${id}.json`) found = p
      }
    }
    walk(root)
    return found
  }

  function pollOnce() {
    const mails = listLocalInbox(homeDir, { unreadOnly: true })
    for (const mail of mails) {
      const mode = String(mail.mode || 'mail').toLowerCase()
      if (seen.has(mail.id)) continue
      if (!AUTO_MODES.has(mode)) continue // passive mail: agents poll it themselves
      seen.add(mail.id)
      const target = String(mail.to || '').trim()
      if (!target || target === '*') {
        info(`[dsh-uni-remote] watcher: mail ${mail.id} asks ${mode} but targets "*" — auto modes need a named session; left for uni_read`)
        continue
      }
      deliver(mode, target, mail.body)
        .then((sessionId) => {
          info(`[dsh-uni-remote] watcher: ${mode} mail ${mail.id} delivered into session ${sessionId}`)
          const file = findMailFile(mail.id)
          if (file) markDelivered(file, mail.id)
        })
        .catch((err) => info(`[dsh-uni-remote] watcher: ${mode} mail ${mail.id} failed: ${String((err && err.message) || err)}`))
    }
  }

  function startWatcher(pollMs = 5000) {
    if (timer) return
    timer = setInterval(pollOnce, Math.max(1000, pollMs))
    if (typeof timer.unref === 'function') timer.unref()
    info(`[dsh-uni-remote] mailbox watcher started (poll ${Math.max(1000, pollMs)}ms, modes followup/inject/steer)`)
  }

  function stopWatcher() {
    if (timer) { clearInterval(timer); timer = null }
  }

  return { listAgents, resolveAgent, deliver, startWatcher, stopWatcher, pollOnce }
}

export function createUniSteerTools(steer) {
  const text = (v) => [{ type: 'text', text: v }]
  const output = {
    schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
    render: (_a, v) => text(v.text),
  }
  return [
    {
      name: 'uni_agents',
      description: 'List live agent sessions on THIS machine that can receive uni_inject/uni_steer/uni_followup (ids and names for addressing).',
      parameters: { type: 'object', properties: {} },
      output,
      async execute() {
        const agents = steer.listAgents()
        if (agents.length === 0) return { text: 'no live sessions enumerated (registry exposes none or enumeration unsupported)' }
        const lines = agents.map((a) => `${a.id}${a.name ? ` — ${a.name}` : ''}${a.status ? ` [${a.status}]` : ''}`)
        return { text: `${agents.length} live session(s):\n${lines.join('\n')}` }
      },
    },
    {
      name: 'uni_inject',
      description: 'Queue a message into a live session on THIS machine without waking it (lands on its next step). Cross-machine: uni_send with mode="inject" instead. to = session id or name from uni_agents.',
      parameters: {
        type: 'object',
        properties: { to: { type: 'string', required: true }, body: { type: 'string', required: true } },
      },
      output,
      async execute(args) {
        const id = await steer.deliver('inject', args.to, args.body)
        return { text: `injected into session ${id} (consumed on its next step)` }
      },
    },
    {
      name: 'uni_steer',
      description: 'Interrupt a live session on THIS machine and steer it with a message (delivered at its next step, run woken). Cross-machine: uni_send with mode="steer". Use sparingly — it changes what the session does next.',
      parameters: {
        type: 'object',
        properties: { to: { type: 'string', required: true }, body: { type: 'string', required: true } },
      },
      output,
      async execute(args) {
        const id = await steer.deliver('steer', args.to, args.body)
        return { text: `steered session ${id} (message lands at its next step)` }
      },
    },
    {
      name: 'uni_followup',
      description: 'Queue a user-turn message into a live session on THIS machine and wake it (it processes the message after its current turn). Cross-machine: uni_send with mode="followup".',
      parameters: {
        type: 'object',
        properties: { to: { type: 'string', required: true }, body: { type: 'string', required: true } },
      },
      output,
      async execute(args) {
        const id = await steer.deliver('followup', args.to, args.body)
        return { text: `followup queued into session ${id} (session woken)` }
      },
    },
  ]
}
