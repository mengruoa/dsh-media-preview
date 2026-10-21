/**
 * dsh-media-preview — host half.
 *
 * ONE prefix route serving both preview kinds, so the two viewers share a
 * single implementation and cannot drift apart:
 *
 *   GET  /media-preview/meta?sessionId&path&cwd   → JSON file facts (size, mime)
 *   GET  /media-preview/media?sessionId&path&cwd  → bytes, Range-capable (206)
 *   HEAD /media-preview/media?...                 → headers only
 *
 * Three deliberate design points, each of them a bug this plugin exists to not
 * have — all three were live in shipped plugins before it:
 *
 * 1. **No `webRuntime` in `inject`.** Older plugin rows declared
 *    `inject: ['webServer', 'sessions', 'webRuntime']`, but the kernel stopped
 *    providing `webRuntime`. Cordis parks a plugin whose injected service never
 *    appears in `pending` — permanently, with no error — so `apply` never ran,
 *    the route was never registered, and every request fell through to the SPA
 *    static fallback. The symptom is not an error but a dead URL. This plugin
 *    injects only services that actually exist.
 *
 * 2. **Always 206 + `Content-Range`, even without a `Range` request.** The
 *    Electron desktop shell forwards app routes through `forwardWebRequest`,
 *    which deletes `Content-Length` (it is in `WITHHELD_RESPONSE_HEADERS`) and
 *    re-wraps the body as a `ReadableStream`. A `200` stripped of its length
 *    has an UNKNOWN size, so Chromium reports `seekable = [0, 0]`: playback
 *    works, the progress bar cannot be dragged. `Content-Range` carries the
 *    total size, so a 206 keeps a complete seekable window no matter what the
 *    shell does to `Content-Length`. (Measured: identical bytes as `200`
 *    without length → `seekable [0,0]`; as `206` → `[0, duration]`.)
 *
 * 3. **The shell's own page is admitted, cross-site marker included.** The
 *    client resolves media against the Host's REAL origin (`streamBaseUrl`) —
 *    that is precisely what keeps `2.` out of the shell's forwarding path — so
 *    its requests carry `Origin: dsh-app://app` and `Sec-Fetch-Site:
 *    cross-site`. Identity is still decided by the Host check below, so
 *    admitting the shell origin grants no capability an in-page request lacked.
 *
 * @module dsh-media-preview
 */
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, isAbsolute, join, resolve } from 'node:path'

/** Plugin identity for cordis.yml rows / loader diagnostics. */
export const name = 'dsh-media-preview'

/**
 * Services required before mounting. Only services the kernel really provides:
 * the webserver for the route, and the session store for the authoritative cwd.
 */
export const inject = ['webServer', 'sessions']

/** Prefix every endpoint lives under. */
const ROUTE_PREFIX = '/media-preview'

/** Metadata probe endpoint (JSON). */
const META_PATH = `${ROUTE_PREFIX}/meta`

/** Media endpoint (bytes, Range-capable). */
const MEDIA_PATH = `${ROUTE_PREFIX}/media`

/**
 * Origin of the Electron desktop shell's application page. The shell serves the
 * GUI from this custom scheme and forwards only its own page requests, so a
 * page-initiated media request carries this Origin while its Host is the Host's
 * loopback authority — an authority match is impossible by construction.
 */
const SHELL_APP_ORIGIN = 'dsh-app://app'

/** Audio extensions this plugin previews (lowercase, no dot). */
const AUDIO_EXTS = [
  'mp3', 'wav', 'wave', 'ogg', 'oga', 'opus', 'flac', 'm4a', 'aac',
  'wma', 'aif', 'aiff', 'amr', 'ape', 'caf', 'mka', 'weba',
]

/**
 * Video extensions this plugin previews (lowercase, no dot).
 *
 * `.ts` is deliberately ABSENT. In a transport-stream sense it is a video
 * container, but in this harness `.ts` is overwhelmingly a TypeScript source
 * file, and an extension match here would shadow the built-in code viewer (the
 * same collision the sibling plugin hit upstream). M2TS/MTS remain: they are
 * unambiguous.
 */
const VIDEO_EXTS = [
  'mp4', 'm4v', 'webm', 'ogv', 'mov', 'qt', 'mkv', 'avi', 'wmv', 'flv',
  'mpeg', 'mpg', '3gp', '3g2', 'm2ts', 'mts',
]

/** Media types by extension. */
const MEDIA_TYPES = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  wave: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  weba: 'audio/webm',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wma: 'audio/x-ms-wma',
  aif: 'audio/aiff',
  aiff: 'audio/aiff',
  amr: 'audio/amr',
  ape: 'audio/x-ape',
  caf: 'audio/x-caf',
  mka: 'audio/x-matroska',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mov: 'video/quicktime',
  qt: 'video/quicktime',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  wmv: 'video/x-ms-wmv',
  flv: 'video/x-flv',
  mpeg: 'video/mpeg',
  mpg: 'video/mpeg',
  '3gp': 'video/3gpp',
  '3g2': 'video/3gpp2',
  m2ts: 'video/mp2t',
  mts: 'video/mp2t',
  ts: 'video/mp2t',
}

/** Every extension this route is willing to serve. */
const MEDIA_EXT_SET = new Set([...AUDIO_EXTS, ...VIDEO_EXTS])

// ── browser-trust fence ─────────────────────────────────────────────────────
//
// Mirrors the `/api` gateway's Host/Origin policy. Inlined so the plugin
// carries no dependency on an internal package.

function header(headers, key) {
  const value = headers[key]
  return typeof value === 'string' ? value : undefined
}

function parseAuthority(authority) {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function canonicalAuthority(entry, entryUrl) {
  const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
  return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
}

function isTrustedAuthority(hostUrl, trustedHosts) {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

/**
 * Whether one request may reach this route.
 * @param request - the request headers (Host / Origin / sec-fetch-site).
 * @param trustedHosts - non-loopback authorities this deployment serves.
 * @returns true when the Host is ours, an attached Origin is ours, and no
 *   unrelated cross-site request is present.
 */
function isTrustedRequest(request, trustedHosts) {
  const host = header(request.headers, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false

  const origin = header(request.headers, 'origin')
  // The shell's own page: always admitted. See the module docs (point 3).
  if (origin === SHELL_APP_ORIGIN) return true
  if (header(request.headers, 'sec-fetch-site') === 'cross-site') return false
  // No Origin: a non-browser client (curl, a test, a media element in no-cors
  // mode). The Host check above already decided the request is ours.
  if (origin === undefined) return true
  try {
    return new URL(origin).hostname === hostUrl.hostname
  } catch {
    return false
  }
}

/**
 * CORS headers for a cross-origin media request, or an empty object otherwise.
 *
 * The shell page reading this route from the Host's real origin is
 * cross-origin, so its JSON `meta` probe is a CORS fetch and the media element
 * needs the range headers exposed to observe the total size. The allowed origin
 * is echoed so a loopback GUI tab and the shell page each get a header the
 * browser accepts — but only for origins this fence already trusts.
 * @param request - the incoming request headers.
 * @returns headers to merge into the response.
 */
function corsFor(request) {
  const origin = header(request.headers, 'origin')
  if (origin === undefined) return {}
  const allowed = origin === SHELL_APP_ORIGIN || loopbackOrigin(origin)
  if (!allowed) return {}
  return {
    'access-control-allow-origin': origin,
    vary: 'origin',
    'access-control-allow-headers': 'range, if-range',
    'access-control-allow-methods': 'GET, HEAD, OPTIONS',
    'access-control-expose-headers': 'content-range, content-length, accept-ranges',
  }
}

/** Whether an Origin header names a loopback page. */
function loopbackOrigin(origin) {
  try {
    return isLoopbackHostname(new URL(origin).hostname)
  } catch {
    return false
  }
}

// ── path resolution ─────────────────────────────────────────────────────────

/** Wire error with a stable code, mirroring better-sidebar's envelope. */
class MediaError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

/**
 * Resolve one request path against a base directory.
 * @param raw - the `path` parameter (absolute, relative, or `~`-anchored).
 * @param cwd - base directory for relative paths.
 * @returns the absolute, lexically normalized path.
 */
function resolveMediaPath(raw, cwd) {
  if (raw === '') throw new MediaError('bad-request', 'path is required')
  let value = raw
  if (value === '~' || value.startsWith('~/') || value.startsWith('~\\')) value = join(homedir(), value.slice(1))
  return isAbsolute(value) ? resolve(value) : resolve(cwd, value)
}

/**
 * Resolve the session's authoritative working directory.
 * @param sessions - the session store face (may be absent during hydration).
 * @param sessionId - the requesting session.
 * @param clientCwd - the caller's own cwd, used while the session is detached.
 * @returns the cwd to resolve relative paths against.
 */
function sessionCwdOf(sessions, sessionId, clientCwd) {
  const headerCwd = sessions?.get(sessionId)?.header?.cwd
  if (typeof headerCwd === 'string' && headerCwd !== '') return headerCwd
  if (typeof clientCwd === 'string' && clientCwd !== '') return resolve(clientCwd)
  return process.cwd()
}

/** Content type for one path. */
function contentTypeFor(path) {
  const ext = extname(path).slice(1).toLowerCase()
  return MEDIA_TYPES[ext] ?? 'application/octet-stream'
}

/**
 * Parse a single `Range` header against a known size.
 *
 * An unparsable header is ignored (RFC 9110) and the whole file served; a
 * request outside the file is `'unsatisfiable'`. Multi-range requests are
 * answered with the first range only, which the spec explicitly allows.
 * @param raw - the raw header value, or undefined when absent.
 * @param size - file size in bytes.
 * @returns `null`, `'unsatisfiable'`, or an inclusive byte window.
 */
function parseRange(raw, size) {
  if (raw === undefined) return null
  const match = /^bytes=(.+)$/i.exec(raw.trim())
  if (match === null) return null
  const first = (match[1] ?? '').split(',')[0]?.trim() ?? ''
  if (first === '') return null
  if (first.startsWith('-')) {
    const suffix = Number(first.slice(1))
    if (!Number.isInteger(suffix) || suffix <= 0) return null
    if (size === 0) return 'unsatisfiable'
    if (suffix >= size) return { start: 0, end: size - 1 }
    return { start: size - suffix, end: size - 1 }
  }
  const dash = first.indexOf('-')
  if (dash <= 0) return null
  const start = Number(first.slice(0, dash))
  const endText = first.slice(dash + 1)
  const end = endText === '' ? size - 1 : Number(endText)
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < 0) return null
  if (start >= size || end < start) return 'unsatisfiable'
  return { start, end: Math.min(end, size - 1) }
}

// ── responses ───────────────────────────────────────────────────────────────

/** Answer one wire error (or destroy the response when headers already went out). */
function writeError(response, status, code, message, extra = {}) {
  if (response.headersSent) {
    response.destroy()
    return
  }
  const body = Buffer.from(JSON.stringify({ ok: false, error: { code, message } }), 'utf8')
  response.writeHead(status, {
    ...extra,
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  })
  response.end(body)
}

/** Answer one JSON value. */
function writeJson(response, status, value, extra = {}) {
  const body = Buffer.from(JSON.stringify({ ok: true, value }), 'utf8')
  response.writeHead(status, {
    ...extra,
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  })
  response.end(body)
}

/** Read one query parameter as a non-empty string. */
function requireParam(url, key) {
  const value = url.searchParams.get(key)
  if (value === null || value === '') throw new MediaError('bad-request', `${key} is required`)
  return value
}

/**
 * Resolve, validate and stat the file one request names.
 * @param url - the parsed request URL.
 * @param ctx - the host context slice.
 * @returns the absolute path and its file facts.
 */
async function statRequestedFile(url, ctx) {
  const sessionId = requireParam(url, 'sessionId')
  const path = resolveMediaPath(
    requireParam(url, 'path'),
    sessionCwdOf(ctx.sessions, sessionId, url.searchParams.get('cwd') ?? undefined),
  )
  const ext = extname(path).slice(1).toLowerCase()
  if (!MEDIA_EXT_SET.has(ext)) {
    throw new MediaError(
      'unsupported-media',
      ext === '' ? 'this route serves audio and video files only' : `this route serves audio and video files only (got .${ext})`,
      403,
    )
  }
  let info
  try {
    info = await stat(path)
  } catch {
    throw new MediaError('fs-error', `cannot read "${path}"`, 404)
  }
  if (!info.isFile()) throw new MediaError('fs-error', `"${path}" is not a regular file`, 400)
  return { path, name: basename(path), size: info.size, mime: contentTypeFor(path), kind: AUDIO_EXTS.includes(ext) ? 'audio' : 'video' }
}

/** Answer the metadata probe. */
async function handleMeta(url, ctx, response, cors) {
  writeJson(response, 200, await statRequestedFile(url, ctx), cors)
}

/**
 * Answer a media request, streaming the whole file or the requested range.
 *
 * Always answers 206 with a `Content-Range`. See the module docs (point 2):
 * `Content-Range` is what keeps the player seekable once the desktop shell
 * strips `Content-Length` from the forwarded response.
 */
async function handleMedia(url, ctx, request, response, cors) {
  const facts = await statRequestedFile(url, ctx)

  if (facts.size === 0) {
    // A zero-length media file is an error state, but answer honestly instead
    // of inventing a `bytes 0--1/0` span.
    response.writeHead(200, { ...cors, 'content-type': facts.mime, 'content-length': '0', 'accept-ranges': 'bytes' })
    response.end()
    return
  }

  const range = parseRange(request.headers.range, facts.size)
  if (range === 'unsatisfiable') {
    response.writeHead(416, { ...cors, 'content-range': `bytes */${facts.size}`, 'accept-ranges': 'bytes' })
    response.end()
    return
  }

  const start = range === null ? 0 : range.start
  const end = range === null ? facts.size - 1 : range.end

  response.writeHead(206, {
    ...cors,
    'content-type': facts.mime,
    'accept-ranges': 'bytes',
    'content-range': `bytes ${start}-${end}/${facts.size}`,
    'content-length': String(end - start + 1),
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
  })

  if (request.method === 'HEAD') {
    response.end()
    return
  }

  const stream = createReadStream(facts.path, { start, end })
  request.on('close', () => stream.destroy())
  stream.on('error', (error) => {
    if (!response.headersSent) writeError(response, 500, 'fs-error', error.message, cors)
    else response.destroy()
  })
  stream.pipe(response)
}

/**
 * Dispatch one request against the prefix route.
 * @param request - node request.
 * @param response - node response.
 * @param ctx - the host context slice.
 */
async function handleRequest(request, response, ctx) {
  const cors = corsFor(request)

  if (!isTrustedRequest({ headers: request.headers }, ctx.get('connection')?.trustedHosts ?? [])) {
    writeError(response, 403, 'forbidden', 'refused by the browser-trust fence', cors)
    return
  }

  // A cross-origin media element may issue a CORS preflight; answer it without
  // touching the file so the real Range GET is allowed to follow.
  if (request.method === 'OPTIONS') {
    response.writeHead(204, cors)
    response.end()
    return
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { ...cors, allow: 'GET, HEAD' })
    response.end()
    return
  }

  const url = new URL(request.url ?? '/', 'http://dsh.internal')
  const pathname = url.pathname.replace(/\/+$/, '')

  try {
    if (pathname === META_PATH) {
      await handleMeta(url, ctx, response, cors)
      return
    }
    if (pathname === MEDIA_PATH) {
      await handleMedia(url, ctx, request, response, cors)
      return
    }
    writeError(response, 404, 'not-found', `unknown route ${url.pathname}`, cors)
  } catch (error) {
    if (error instanceof MediaError) writeError(response, error.status, error.code, error.message, cors)
    else writeError(response, 500, 'internal', error instanceof Error ? error.message : String(error), cors)
  }
}

/**
 * Mount the route.
 * @param ctx - the host plugin context (services ready per {@link inject}).
 */
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: (request, response) => {
      handleRequest(request, response, ctx).catch(() => {
        if (!response.headersSent) writeError(response, 500, 'internal', 'unhandled route failure')
        else response.destroy()
      })
    },
  }), 'dsh-media-preview: media routes')
}

export { AUDIO_EXTS, VIDEO_EXTS, MEDIA_EXT_SET, MEDIA_TYPES, parseRange, isTrustedRequest, corsFor }
