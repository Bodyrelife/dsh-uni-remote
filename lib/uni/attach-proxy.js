// uni: same-origin reverse proxy in front of every attached remote DSH Web UI.
//
// Why: a remote DSH web issues `SameSite=Strict` auth cookies, which the
// browser never sends from inside a cross-site <iframe>. Serving each attached
// UI under OUR OWN origin (/dsh-remote/attach/<machineId>/...) keeps the page
// same-origin, and the cookie never needs to leave the server: this proxy
// keeps a per-machine cookie jar and injects it into every upstream request.
//
// The embedded frontend resolves its WebSocket mux path relative to
// document.baseURI (openConnectionWebSocket: `new URL(path.slice(1), base)`),
// so under /dsh-remote/attach/<id>/ it hits
// /dsh-remote/attach/<id>/api/remote.mux — one exact upgrade route per
// machine, registered here, piped raw into the SSH tunnel.

import net from 'node:net'

export const ATTACH_PROXY_PREFIX = '/dsh-remote/attach'
const WS_TAIL = '/api/remote.mux'
const MAX_PROXY_BYTES = 64 * 1024 * 1024 // v1: buffer whole bodies

/** machineId → { cookies: Map<name,value>, port } */
const jars = new Map()

function jarFor(machineId, port) {
  let jar = jars.get(machineId)
  if (!jar) {
    jar = { cookies: new Map(), port: 0 }
    jars.set(machineId, jar)
  }
  if (port > 0) jar.port = port
  return jar
}

function parseSetCookie(header, jar) {
  // Only the first pair matters (session cookie); drop attributes server-side.
  const pair = header.split(';', 1)[0]
  const eq = pair.indexOf('=')
  if (eq > 0) {
    const name = pair.slice(0, eq).trim()
    const value = pair.slice(eq + 1).trim()
    if (name) jar.cookies.set(name, value)
  }
}

function cookieHeaderFor(jar) {
  if (jar.cookies.size === 0) return undefined
  return Array.from(jar.cookies).map(([name, value]) => `${name}=${value}`).join('; ')
}

const STRIP_REQ_HEADERS = new Set([
  'host', 'cookie', 'origin', 'referer', 'connection', 'upgrade',
  'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions',
  'sec-websocket-protocol', 'content-length', 'accept-encoding', 'if-none-match', 'if-modified-since',
])

const STRIP_RES_HEADERS = new Set([
  'set-cookie', 'content-security-policy', 'content-security-policy-report-only',
  'x-frame-options', 'content-encoding', 'content-length', 'transfer-encoding',
  'strict-transport-security', 'connection', 'keep-alive',
])

/** Rewrite absolute-path references so the embedded SPA stays under the prefix. */
function rewriteHtml(body, prefix) {
  return body
    .replaceAll('href="/', `href="${prefix}/`)
    .replaceAll('src="/', `src="${prefix}/`)
    .replaceAll('href=\'/', `href='${prefix}/`)
    .replaceAll('src=\'/', `src='${prefix}/`)
    .replaceAll('action="/', `action="${prefix}/`)
}

function rewriteLocation(value, prefix) {
  if (!value) return value
  if (value.startsWith('/')) return prefix + value
  return value
}

export function createUniAttachProxy({ ctx, webAttaches, machines, sendJson }) {
  function resolveMachine(ref) {
    const needle = String(ref ?? '').toLowerCase()
    return machines().find((machine) => {
      const id = machine.id ?? ''
      return (
        String(id).toLowerCase() === needle ||
        String(machine.name ?? '').toLowerCase() === needle ||
        String(machine.host ?? '').toLowerCase() === needle
      )
    })
  }

  function activePort(machineId) {
    const attach = webAttaches.get(machineId)
    const describe = attach?.describe?.()
    if (!describe || !describe.active || !describe.localPort) return null
    return { port: describe.localPort, url: describe.url ?? attach.url ?? '' }
  }

  async function readBody(req) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_PROXY_BYTES) throw new Error('uni-attach: request body too large')
      chunks.push(chunk)
    }
    return Buffer.concat(chunks)
  }

  async function handler(req, res) {
    const parsed = new URL(req.url ?? '/', 'http://x')
    const match = parsed.pathname.match(new RegExp(`^${ATTACH_PROXY_PREFIX}/([^/]+)(/.*)?$`))
    if (!match) {
      sendJson(res, 404, { ok: false, error: 'uni-attach: no machine id in path' })
      return
    }
    const rawId = decodeURIComponent(match[1])
    const machine = resolveMachine(rawId)
    if (!machine) {
      sendJson(res, 404, { ok: false, error: `uni-attach: unknown machine "${rawId}"` })
      return
    }
    const machineId = machine.id
    const upstream = activePort(machineId)
    if (!upstream) {
      sendJson(res, 409, {
        ok: false,
        error: `uni-attach: "${machine.name ?? machineId}" has no active web attach — open it first`,
      })
      return
    }
    const prefix = `${ATTACH_PROXY_PREFIX}/${encodeURIComponent(machineId)}`
    const jar = jarFor(machineId, upstream.port)
    const rest = match[2] || '/'
    // First visit with an empty jar: the remote web only admits the ?token=
    // carried by the attach URL, so splice it in — its Set-Cookie response
    // fills the jar and every later request authenticates normally.
    let search = parsed.search
    if (jar.cookies.size === 0) {
      try {
        const tokenUrl = new URL(upstream.url)
        const token = tokenUrl.searchParams.get('token')
        if (token && !new URLSearchParams(search || '').has('token')) {
          const params = new URLSearchParams(search || '')
          params.set('token', token)
          search = `?${params.toString()}`
        }
      } catch { /* no usable attach URL — fall through unauthenticated */ }
    }
    const target = `http://127.0.0.1:${upstream.port}${rest}${search}`
    const headers = {}
    for (const [name, value] of Object.entries(req.headers)) {
      if (STRIP_REQ_HEADERS.has(name)) continue
      headers[name] = value
    }
    headers.host = `127.0.0.1:${upstream.port}`
    const cookie = cookieHeaderFor(jar)
    if (cookie) headers.cookie = cookie

    let body
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      try {
        body = await readBody(req)
      } catch (error) {
        sendJson(res, 413, { ok: false, error: String(error?.message ?? error) })
        return
      }
    }

    let upstreamRes
    try {
      upstreamRes = await fetch(target, {
        method: req.method,
        headers,
        body: body && body.length > 0 ? body : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(30000),
      })
    } catch (error) {
      sendJson(res, 502, { ok: false, error: `uni-attach: upstream unreachable — ${String(error?.message ?? error)}` })
      return
    }

    for (const setCookie of upstreamRes.headers.getSetCookie?.() ?? []) parseSetCookie(setCookie, jar)

    const contentType = upstreamRes.headers.get('content-type') ?? ''
    const isHtml = contentType.includes('text/html')

    res.writeHead(upstreamRes.status, {
      'content-type': contentType || 'application/octet-stream',
      'cache-control': 'no-store',
    })

    if (req.method === 'HEAD') {
      res.end()
      return
    }

    const location = upstreamRes.headers.get('location')
    if (location) res.setHeader('location', rewriteLocation(location, prefix))

    const buf = Buffer.from(await upstreamRes.arrayBuffer())
    if (isHtml) {
      res.end(Buffer.from(rewriteHtml(buf.toString('utf8'), prefix)))
    } else {
      res.end(buf)
    }
  }

  const routes = [
    { kind: 'prefix', path: ATTACH_PROXY_PREFIX, handler },
    {
      kind: 'exact',
      path: '/dsh-remote/uni-attach/status',
      handler(req, res) {
        // Any throw here surfaces as a bare HTTP 400 (webServer converts
        // handler rejections to 400 with no body) — catch and report instead.
        try {
          // Late-registered machines get their WS route on first status poll.
          ensureAllUpgradeRoutes(ctx)
          const list = machines().map((machine) => {
            const describe = webAttaches.get(machine.id)?.describe?.()
            return {
              id: machine.id,
              name: machine.name,
              host: machine.host,
              attached: Boolean(describe?.active),
              localPort: describe?.localPort ?? null,
              error: describe?.error ?? '',
            }
          })
          sendJson(res, 200, { ok: true, machines: list })
        } catch (error) {
          sendJson(res, 200, { ok: true, machines: [], statusError: String((error && error.stack) || error) })
        }
      },
    },
  ]

  /**
   * Register the exact WS upgrade route for one machine. Idempotent: the
   * webserver throws on duplicate paths, which we swallow (first wins).
   */
  function ensureUpgradeRoute(ctx, machineId) {
    const path = `${ATTACH_PROXY_PREFIX}/${encodeURIComponent(machineId)}${WS_TAIL}`
    try {
      const webServer = ctx.get('webServer')
      if (!webServer?.registerUpgrade) return
      const jar = jarFor(machineId, 0)
      webServer.registerUpgrade({
        path,
        handler(req, socket, head) {
          const attach = webAttaches.get(machineId)
          const describe = attach?.describe?.()
          if (!describe?.active) {
            socket.destroy()
            return
          }
          jar.port = describe.localPort
          const upstream = net.connect(describe.localPort, '127.0.0.1')
          upstream.on('connect', () => {
            // Rebuild the handshake: strip our prefix, restore the remote path,
            // inject the machine's cookie jar.
            const parsed = new URL(req.url ?? '/', 'http://x')
            const rewritten = parsed.search
              ? `${WS_TAIL}${parsed.search}`
              : WS_TAIL
            const lines = [`GET ${rewritten} HTTP/1.1`]
            for (const [name, value] of Object.entries(req.headers)) {
              if (STRIP_REQ_HEADERS.has(name)) continue
              lines.push(`${name}: ${Array.isArray(value) ? value.join(', ') : value}`)
            }
            lines.push(`host: 127.0.0.1:${describe.localPort}`)
            const cookie = cookieHeaderFor(jar)
            if (cookie) lines.push(`cookie: ${cookie}`)
            upstream.write(lines.join('\r\n') + '\r\n\r\n')
            if (head && head.length > 0) upstream.write(head)
            socket.pipe(upstream)
            upstream.pipe(socket)
          })
          const kill = () => {
            socket.destroy()
            upstream.destroy()
          }
          socket.on('error', kill)
          upstream.on('error', kill)
          socket.on('close', kill)
          upstream.on('close', kill)
        },
      })
    } catch {
      // duplicate registration — the first one still owns the path
    }
  }

  function ensureAllUpgradeRoutes(ctx) {
    for (const machine of machines()) ensureUpgradeRoute(ctx, machine.id)
  }

  return { routes, ensureUpgradeRoute, ensureAllUpgradeRoutes }
}
