/**
 * Route regression suite for the host half — self-contained, no fixtures, no
 * ffmpeg. Fabricates a byte file, mounts the real route against a real node
 * http server, and pins the wire contract.
 *
 *   node test/route.test.mjs
 */
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const here = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const mod = await import(pathToFileURL(join(here, '..', 'index.js')).href)

const root = mkdtempSync(join(tmpdir(), 'dsh-media-preview-'))
const audioFile = join(root, 'clip.mp3')
const videoFile = join(root, 'clip.mp4')
const otherFile = join(root, 'notes.txt')
const bytes = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 31 + 7) % 256))
writeFileSync(audioFile, bytes)
writeFileSync(videoFile, bytes)
writeFileSync(otherFile, bytes)
const size = bytes.length

let handler = null
const fakeCtx = {
  sessions: { get: (id) => (id === 'sess-1' ? { header: { cwd: root } } : undefined) },
  get: (key) => (key === 'connection' ? { trustedHosts: [] } : undefined),
  webServer: { register: (entry) => { handler = entry.handler; return () => {} } },
  effect: (fn) => { fn(); return () => {} },
}
mod.apply(fakeCtx)
if (handler === null) throw new Error('route was not registered')

const server = createServer((req, res) => handler(req, res))
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`
const mediaUrl = (file) => `${base}/media-preview/media?sessionId=sess-1&path=${encodeURIComponent(file)}`
const metaUrl = (file) => `${base}/media-preview/meta?sessionId=sess-1&path=${encodeURIComponent(file)}`

let pass = 0
let failed = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ok   ${name}${extra ? ' — ' + extra : ''}`) }
  else { failed += 1; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`) }
}
const req = (url, opts) => fetch(url, opts).then(async (res) => ({
  status: res.status,
  headers: res.headers,
  buf: Buffer.from(await res.arrayBuffer()),
}))

// ── metadata probe ──────────────────────────────────────────────────────────
const m1 = await req(metaUrl(audioFile))
check('meta 200', m1.status === 200)
const m1body = JSON.parse(m1.buf.toString('utf8'))
check('meta ok envelope', m1body.ok === true)
check('meta reports audio kind', m1body.value.kind === 'audio')
check('meta reports mime', m1body.value.mime === 'audio/mpeg')
check('meta reports size', m1body.value.size === size)

const m2 = await req(metaUrl(videoFile))
const m2body = JSON.parse(m2.buf.toString('utf8'))
check('meta reports video kind', m2body.value.kind === 'video')
check('meta reports mp4 mime', m2body.value.mime === 'video/mp4')

// ── the always-206 contract ─────────────────────────────────────────────────
// A request WITHOUT Range must still answer 206 + Content-Range: the desktop
// shell strips Content-Length from forwarded responses, and a length-less 200
// leaves the media element with seekable [0,0].
const r1 = await req(mediaUrl(videoFile))
check('no-range answers 206', r1.status === 206)
check('no-range carries content-range', r1.headers.get('content-range') === `bytes 0-${size - 1}/${size}`)
check('no-range carries content-length', r1.headers.get('content-length') === String(size))
check('accept-ranges bytes', r1.headers.get('accept-ranges') === 'bytes')
check('full body equals file', r1.buf.equals(bytes))

// ── range semantics ─────────────────────────────────────────────────────────
const r2 = await req(mediaUrl(videoFile), { headers: { range: 'bytes=0-99' } })
check('range 206', r2.status === 206)
check('range content-range', r2.headers.get('content-range') === `bytes 0-99/${size}`)
check('range slice', r2.buf.equals(bytes.subarray(0, 100)))

const r3 = await req(mediaUrl(videoFile), { headers: { range: 'bytes=100-' } })
check('open-ended 206', r3.status === 206)
check('open-ended slice', r3.buf.equals(bytes.subarray(100)))

const r4 = await req(mediaUrl(videoFile), { headers: { range: 'bytes=-50' } })
check('suffix 206', r4.status === 206)
check('suffix slice', r4.buf.equals(bytes.subarray(size - 50)))

const r5 = await req(mediaUrl(videoFile), { headers: { range: 'bytes=999999-' } })
check('unsatisfiable 416', r5.status === 416)
check('416 content-range', r5.headers.get('content-range') === `bytes */${size}`)

const r6 = await req(mediaUrl(videoFile), { headers: { range: 'not-a-range' } })
check('unparsable range serves whole file', r6.status === 206 && r6.buf.equals(bytes))

// ── extension whitelist ─────────────────────────────────────────────────────
const r7 = await req(mediaUrl(otherFile))
check('non-media extension 403', r7.status === 403)
const r7body = JSON.parse(r7.buf.toString('utf8'))
check('non-media error code', r7body.error.code === 'unsupported-media')

// ── the shell origin (what the fixed client sends) ──────────────────────────
const shellHeaders = { origin: 'dsh-app://app', 'sec-fetch-site': 'cross-site' }
const r8 = await req(mediaUrl(audioFile), { headers: { ...shellHeaders, range: 'bytes=0-' } })
check('shell origin admitted (cross-site)', r8.status === 206)
check('shell origin gets CORS', r8.headers.get('access-control-allow-origin') === 'dsh-app://app')
check('shell origin exposes ranges', (r8.headers.get('access-control-expose-headers') ?? '').includes('content-range'))

const m8 = await req(metaUrl(audioFile), { headers: shellHeaders })
check('shell origin meta 200', m8.status === 200)
check('shell origin meta CORS', m8.headers.get('access-control-allow-origin') === 'dsh-app://app')

const opt = await req(mediaUrl(audioFile), { method: 'OPTIONS', headers: shellHeaders })
check('preflight 204', opt.status === 204)
check('preflight allows range', (opt.headers.get('access-control-allow-headers') ?? '').includes('range'))

// ── security: everything else stays out ─────────────────────────────────────
const r9 = await req(mediaUrl(videoFile), { headers: { origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' } })
check('foreign origin 403', r9.status === 403)
check('foreign origin gets no CORS', r9.headers.get('access-control-allow-origin') === null)

const r10 = await req(mediaUrl(videoFile), { headers: { 'sec-fetch-site': 'cross-site' } })
check('cross-site without origin 403', r10.status === 403)

// ── methods / HEAD / errors ─────────────────────────────────────────────────
const r11 = await req(mediaUrl(videoFile), { method: 'HEAD' })
check('HEAD 206', r11.status === 206)
check('HEAD content-range', r11.headers.get('content-range') === `bytes 0-${size - 1}/${size}`)
check('HEAD empty body', r11.buf.length === 0)

const r12 = await req(mediaUrl(videoFile), { method: 'POST' })
check('POST 405', r12.status === 405)

const r13 = await req(`${base}/media-preview/media?sessionId=sess-1&path=${encodeURIComponent(join(root, 'missing.mp4'))}`)
check('missing file 404', r13.status === 404)

const r14 = await req(`${base}/media-preview/media?sessionId=sess-1`)
check('missing path 400', r14.status === 400)

const r15 = await req(`${base}/media-preview/nope`)
check('unknown route 404', r15.status === 404)

// ── download route is the media route (no separate branch to drift) ─────────
const r16 = await req(mediaUrl(audioFile), { headers: { range: 'bytes=0-0' } })
check('single byte range', r16.status === 206 && r16.buf.length === 1)

server.close()
console.log(`\n${pass} checks passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
