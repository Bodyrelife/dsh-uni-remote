// uni: task delegation loop over the mailbox (P3 collaboration, goal ②).
//
// uni_task = uni_send with a reply contract + bounded result wait:
//   1. sends a task mail (mode=followup so a running uni.7+ remote watcher
//      drops it straight into the target session; falls back to passive mail)
//      carrying replyTo=<taskId>;
//   2. the receiving agent's delivery body has the reply contract appended
//      (steer.js taskDeliveryBody), so it answers with
//      uni_send { ..., replyTo: <taskId> };
//   3. uni_task polls the LOCAL inbox for a mail with that replyTo and returns
//      the result, or hands back a pending handle for uni_task_result.

import { listLocalInbox, readLocalMail, senderIdentity, newMailId, uniMailboxRoot, deliverRemoteMail, deliverLocalMail } from './mailbox.js'
import fs from 'node:fs'
import path from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function createUniTaskTools(deps = {}) {
  const { store, poolForMachine, resolveHome, machineName, homeDir } = deps
  const from = () => senderIdentity(machineName)
  const isLocalTarget = (raw) => {
    const v = String(raw || '').trim().toLowerCase()
    return v === '' || ['local', 'this', 'this machine', 'self', '本机'].includes(v)
  }
  const findMachine = (raw) => {
    const key = String(raw || '').trim().toLowerCase()
    if (isLocalTarget(key)) return undefined
    const list = (store && store.list) || []
    const hit = list.find((m) => m.id === key || String(m.name || '').toLowerCase() === key || String(m.host || '').toLowerCase() === key)
    if (!hit) throw new Error(`no saved machine matches "${raw}" (see rw_machines)`)
    return hit
  }
  const text = (v) => [{ type: 'text', text: v }]
  const output = {
    schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
    render: (_a, v) => text(v.text),
  }
  const sentDir = () => path.join(uniMailboxRoot(homeDir), 'sent')

  async function findReply(taskId) {
    const mails = listLocalInbox(homeDir, { unreadOnly: true })
    // The task mail ITSELF carries replyTo===taskId — exclude it (m.id !== taskId),
    // otherwise the delegation instantly "completes" with its own body.
    return mails.find((m) => m.replyTo === taskId && m.id !== taskId) ?? null
  }

  async function sendTask({ machine: machineRef, to, subject, body, mode }) {
    const machine = findMachine(machineRef)
    const taskId = newMailId()
    const mail = {
      id: taskId,
      from: from(),
      to: String(to || '').trim() || '*',
      subject: String(subject || '').trim() || `task ${taskId}`,
      body: String(body || ''),
      createdAt: new Date().toISOString(),
      replyTo: taskId,
      ...(mode ? { mode } : { mode: 'followup' }),
    }
    if (!machine) {
      // Local loop: same-machine delegation.
      const file = deliverLocalMail(homeDir, from(), mail)
      return { taskId, mail, where: `local mailbox (${file})` }
    }
    const pool = poolForMachine(machine)
    const home = await resolveHome(pool)
    const remotePath = await deliverRemoteMail(pool, home, from(), mail)
    mkdirSync(sentDir(), { recursive: true })
    writeFileSync(path.join(sentDir(), `${mail.id}.json`), JSON.stringify({ ...mail, machine: machine.name, remotePath }, null, 2) + '\n')
    return { taskId, mail, where: `${machine.name || machine.host} (${remotePath})` }
  }

  return [
    {
      name: 'uni_task',
      description:
        'Delegate a task to an agent session on ANOTHER machine (or another session on this machine) and wait for the result. ' +
        'Cross-server collaboration primitive: sends a reply-addressed task mail; if the target machine runs dsh-uni-remote >= uni.7 ' +
        'the mail is delivered live (followup) into the named session (`to` — see uni_agents on that machine; "*" is NOT valid for live delivery and falls back to passive mailbox), ' +
        'and the receiving agent is told to answer with uni_send { replyTo }. ' +
        'Waits up to `waitSec` (default 120, cap 570) for the result; on timeout returns a pending handle — fetch later with uni_task_result { taskId }.',
      parameters: {
        type: 'object',
        properties: {
          machine: { type: 'string', description: 'saved machine name/id/host (rw_machines), or "local" for same-machine delegation' },
          to: { type: 'string', description: 'target session name/id on that machine (required for live followup delivery)' },
          subject: { type: 'string' },
          body: { type: 'string', required: true, description: 'the task: what to do, and what a useful result summary looks like' },
          waitSec: { type: 'number', description: 'max seconds to block waiting for the reply (default 120, cap 570)' },
        },
      },
      output,
      async execute(args) {
        const body = String(args.body || '').trim()
        if (!body) throw new Error('body (the task) is required')
        const waitMs = Math.min(Math.max(Number(args.waitSec ?? 120), 0), 570) * 1000
        const { taskId, mail, where } = await sendTask({ machine: args.machine, to: args.to, subject: args.subject, body, mode: 'followup' })
        if (waitMs <= 0) {
          return { text: `task ${taskId} sent → ${where}; do not wait (fetch result with uni_task_result { taskId: "${taskId}" })` }
        }
        const deadline = Date.now() + waitMs
        while (Date.now() < deadline) {
          await sleep(3000)
          const reply = await findReply(taskId)
          if (reply) {
            const full = readLocalMail(homeDir, reply.id) // marks read
            return { text: `task ${taskId} done — reply from "${full.from}" (${full.createdAt}):\n${full.body}` }
          }
        }
        return { text: `task ${taskId} sent → ${where}, still pending after ${waitMs / 1000}s. Fetch later with uni_task_result { taskId: "${taskId}" }.` }
      },
    },
    {
      name: 'uni_task_result',
      description: 'Fetch the result of a uni_task delegation that is still pending (no reply arrived within its wait window). Reads the reply mail from the mailbox.',
      parameters: {
        type: 'object',
        properties: { taskId: { type: 'string', required: true } },
      },
      output,
      async execute(args) {
        const taskId = String(args.taskId || '').trim()
        if (!taskId) throw new Error('taskId required')
        const reply = await findReply(taskId)
        if (!reply) return { text: `no reply yet for task ${taskId}` }
        const full = readLocalMail(homeDir, reply.id)
        return { text: `task ${taskId} done — reply from "${full.from}" (${full.createdAt}):\n${full.body}` }
      },
    },
  ]
}
