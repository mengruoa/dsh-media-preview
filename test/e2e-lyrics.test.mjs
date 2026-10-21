/**
 * End-to-end: real host route -> real client normalization -> word spans.
 *
 * The regression this guards was a seam BETWEEN two correct pieces: the host
 * emitted word cues, the renderer understood them, and the client's
 * normalization silently rebuilt each line without the field. Testing either
 * side alone misses it, so this runs the whole pipe against the real
 * 晚风信.lrc and asserts that per-word spans actually come out the far end.
 */
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const LRC = join(root, '晚风信.lrc')
const MP3 = join(root, '晚风信.mp3')

const host = await import(pathToFileURL(join(here, '..', 'index.js')).href)
const clientSource = readFileSync(join(here, '..', 'client.js'), 'utf8')

let pass = 0
let failed = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ok   ${name}${extra ? ' — ' + extra : ''}`) }
  else { failed += 1; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`) }
}

// ── 1. the real host route serves the real file ────────────────────────────
console.log('\nhost route emits word cues for the real file')
let handler = null
host.apply({
  sessions: { get: () => ({ header: { cwd: root } }) },
  get: () => undefined,
  webServer: { register: (entry) => { handler = entry.handler; return () => {} } },
  effect: (fn) => { fn(); return () => {} },
})
const server = createServer((req, res) => handler(req, res))
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`
const lyricsUrl = `${base}/media-preview/lyrics?sessionId=s&path=${encodeURIComponent(MP3)}`

let envelope = null
{
  const response = await fetch(lyricsUrl)
  envelope = await response.json()
  check('endpoint 200 + ok', response.status === 200 && envelope.ok === true)
  check('found the sidecar', envelope.value.found === true, envelope.value.name)
  check('29 timed lines', envelope.value.lines.length === 29, `n=${envelope.value.lines.length}`)
  const withWords = envelope.value.lines.filter((l) => Array.isArray(l.words) && l.words.length > 0)
  check('every line carries word cues', withWords.length === 29, `${withWords.length}/29`)
  check('first line has 9 characters', envelope.value.lines[0].words.length === 9, `n=${envelope.value.lines[0].words.length}`)
}

// ── 2. run the SHIPPED client normalization over that envelope ─────────────
console.log('\nclient normalization preserves those cues')
let normalized = null
{
  const mapStart = clientSource.indexOf('.map(function (line) {')
  const mapEnd = clientSource.indexOf('}),', mapStart)
  const mapperSource = clientSource.slice(mapStart, mapEnd + 2)
  const sandbox = { value: envelope.value, result: null }
  vm.createContext(sandbox)
  vm.runInContext(
    `result = value.lines
       .filter(function (line) { return line && typeof line.time === 'number' && typeof line.text === 'string' })
       ${mapperSource};`,
    sandbox,
  )
  normalized = sandbox.result
  check('same line count after rebuild', normalized.length === 29, `n=${normalized.length}`)
  const stillWorded = normalized.filter((l) => Array.isArray(l.words) && l.words.length > 0)
  check('word cues survive end to end', stillWorded.length === 29, `${stillWorded.length}/29`)
  check('first line keeps its 9 cues', normalized[0].words.length === 9, `n=${normalized[0].words.length}`)
  check('cue text matches the line', normalized[0].words.map((w) => w.text).join('') === normalized[0].text)
}

// ── 3. the renderer would split them: index helper over real cues ──────────
console.log('\nthe word index resolves positions on the real data')
{
  const start = clientSource.indexOf('var wordIndexAt = function')
  const end = clientSource.indexOf('\n      }', start)
  const sandbox = { result: null }
  vm.createContext(sandbox)
  vm.runInContext(`${clientSource.slice(start, end + '\n      }'.length)}\n; result = wordIndexAt;`, sandbox)
  const wordIndexAt = sandbox.result

  const first = normalized[0]
  check('before line 1 start, no cue', wordIndexAt(first.words, first.time - 0.1) === -1)
  check('at the first cue', wordIndexAt(first.words, first.time) === 0)
  check('third cue reached', wordIndexAt(first.words, first.words[2].time) === 2, `i=${wordIndexAt(first.words, first.words[2].time)}`)
  check('last cue reached', wordIndexAt(first.words, first.words[8].time) === 8)
}

server.close()
console.log(`\n${pass} checks passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
