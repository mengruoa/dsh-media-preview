/**
 * LRC parsing and the sidecar-lyrics endpoint.
 *
 * The parser is a pure function, so most cases are table-driven; the endpoint
 * is exercised against the real fixture `晚风邮局.lrc` when it is present, and
 * against fabricated files otherwise, so the suite passes on a clean checkout.
 */
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const mod = await import(pathToFileURL(join(here, '..', 'index.js')).href)
const parseLyrics = mod.parseLyrics

let pass = 0
let failed = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ok   ${name}${extra ? ' — ' + extra : ''}`) }
  else { failed += 1; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`) }
}
const near = (a, b) => Math.abs(a - b) < 0.002

// ── basic timestamps ────────────────────────────────────────────────────────
console.log('\nbasic timestamps')
{
  const { lines } = parseLyrics('[00:13.80]路灯把影子拉得很长\n[00:19.55]旧信箱')
  check('two lines parsed', lines.length === 2)
  check('first time', near(lines[0].time, 13.8), `t=${lines[0].time}`)
  check('first text', lines[0].text === '路灯把影子拉得很长')
  check('second time', near(lines[1].time, 19.55), `t=${lines[1].time}`)
}

console.log('\ncentisecond and millisecond fractions')
{
  check('two-digit fraction', near(parseLyrics('[00:01.50]a').lines[0].time, 1.5))
  check('three-digit fraction', near(parseLyrics('[00:01.500]a').lines[0].time, 1.5))
  check('one-digit fraction is tenths', near(parseLyrics('[00:01.5]a').lines[0].time, 1.5))
  check('no fraction', near(parseLyrics('[00:05]a').lines[0].time, 5))
  check('colon separator', near(parseLyrics('[00:05:25]a').lines[0].time, 5.25))
}

console.log('\nminute overflow beyond 59 is not special-cased away')
{
  // Some files write [01:75.00]; the value is simply 1*60+75.
  check('parse keeps arithmetic', near(parseLyrics('[01:75.00]a').lines[0].time, 135))
}

// ── metadata ────────────────────────────────────────────────────────────────
console.log('\nmetadata tags are captured, not rendered')
{
  const { lines, meta } = parseLyrics('[ti:晚风邮局]\n[ar:AI 男声]\n[length:02:46]\n[00:01.00]hello')
  check('title captured', meta.ti === '晚风邮局')
  check('artist captured', meta.ar === 'AI 男声')
  check('only the timed line is a lyric', lines.length === 1, `n=${lines.length}`)
}

console.log('\noffset shifts timestamps')
{
  // Positive LRC offset means the lyric should appear EARLIER.
  const early = parseLyrics('[offset:500]\n[00:10.00]a')
  check('positive offset advances', near(early.lines[0].time, 9.5), `t=${early.lines[0].time}`)
  const late = parseLyrics('[offset:-500]\n[00:10.00]a')
  check('negative offset delays', near(late.lines[0].time, 10.5), `t=${late.lines[0].time}`)
  const clamp = parseLyrics('[offset:20000]\n[00:01.00]a')
  check('never goes negative', clamp.lines[0].time === 0, `t=${clamp.lines[0].time}`)
}

// ── repeated timestamps ─────────────────────────────────────────────────────
console.log('\nmultiple timestamps on one line')
{
  const { lines } = parseLyrics('[00:10.00][01:20.00]chorus')
  check('two occurrences', lines.length === 2, `n=${lines.length}`)
  check('same text', lines[0].text === 'chorus' && lines[1].text === 'chorus')
  check('times differ', near(lines[0].time, 10) && near(lines[1].time, 80))
}

// ── section markers ─────────────────────────────────────────────────────────
console.log('\nsection markers')
{
  // The real file's shape: the marker shares a timestamp with the next line.
  const { lines } = parseLyrics('[00:13.80][Verse 1]\n[00:13.80]路灯把影子拉得很长\n[00:19.55]旧信箱')
  check('marker line is not a duplicate lyric', lines.length === 2, `n=${lines.length}`)
  check('section attached to the following line', lines[0].section === 'Verse 1', `s=${lines[0].section}`)
  check('section cleared after use', lines[1].section === null, `s=${lines[1].section}`)
}

console.log('\ninline section marker on the same line as the text')
{
  const { lines } = parseLyrics('[00:13.80][Verse 1]路灯把影子拉得很长')
  check('one lyric', lines.length === 1, `n=${lines.length}`)
  check('section captured', lines[0].section === 'Verse 1', `s=${lines[0].section}`)
  check('text excludes the marker', lines[0].text === '路灯把影子拉得很长', `t=${lines[0].text}`)
}

// ── robustness ──────────────────────────────────────────────────────────────
console.log('\nCRLF and BOM')
{
  const { lines } = parseLyrics('\uFEFF[00:01.00]a\r\n[00:02.00]b\r\n')
  check('BOM stripped, both lines kept', lines.length === 2, `n=${lines.length}`)
  check('first line not swallowed', lines[0].text === 'a')
}

console.log('\nunsorted input is sorted by time')
{
  const { lines } = parseLyrics('[00:30.00]c\n[00:10.00]a\n[00:20.00]b')
  check('sorted', lines.map((l) => l.text).join('') === 'abc')
}

console.log('\nblank and untimed lines are ignored')
{
  const { lines } = parseLyrics('\n\n[00:01.00]a\n\nplain text without a timestamp\n')
  check('only timed lines', lines.length === 1, `n=${lines.length}`)
}

console.log('\nempty text after a timestamp is dropped')
{
  const { lines } = parseLyrics('[00:01.00]\n[00:02.00]b')
  check('empty lyric dropped', lines.length === 1 && lines[0].text === 'b', `n=${lines.length}`)
}

console.log('\ntext containing brackets is preserved')
{
  const { lines } = parseLyrics('[00:01.00]she said [hello] softly')
  check('inner brackets kept', lines[0].text === 'she said [hello] softly', `t=${lines[0].text}`)
}

// ── the real fixture ────────────────────────────────────────────────────────
console.log('\nreal fixture 晚风邮局.lrc')
{
  const fixture = join(here, '..', '..', '晚风邮局.lrc')
  if (existsSync(fixture)) {
    const text = (await import('node:fs')).readFileSync(fixture, 'utf8')
    const { lines, meta } = parseLyrics(text)
    check('title from the file', meta.ti === '晚风邮局')
    check('a reasonable number of lyric lines', lines.length >= 20 && lines.length <= 40, `n=${lines.length}`)
    check('first lyric is the first verse', lines[0].text === '路灯把影子拉得很长', `t=${lines[0].text}`)
    check('first lyric timed at 13.80', near(lines[0].time, 13.8), `t=${lines[0].time}`)
    check('chorus section present', lines.some((l) => l.section === 'Chorus'))
    check('no lyric is a bare section label', lines.every((l) => !/^\[.*\]$/.test(l.text)))
    check('strictly non-decreasing times', lines.every((l, i) => i === 0 || l.time >= lines[i - 1].time))
  } else {
    console.log('  (fixture not present; skipped)')
  }
}

// ── the endpoint ────────────────────────────────────────────────────────────
console.log('\nsidecar lyrics endpoint')
{
  const root = mkdtempSync(join(tmpdir(), 'dsh-lyrics-'))
  const song = join(root, 'song.mp3')
  writeFileSync(song, Buffer.alloc(512, 3))
  writeFileSync(join(root, 'song.lrc'), '[ti:Song]\n[00:01.00]line one\n[00:02.50]line two\n', 'utf8')

  const bare = join(root, 'bare.mp3')
  writeFileSync(bare, Buffer.alloc(512, 4))

  const casing = join(root, 'Case.mp3')
  writeFileSync(casing, Buffer.alloc(512, 5))
  writeFileSync(join(root, 'Case.LRC'), '[00:03.00]upper case file\n', 'utf8')

  let handler = null
  mod.apply({
    sessions: { get: () => ({ header: { cwd: root } }) },
    get: () => undefined,
    webServer: { register: (entry) => { handler = entry.handler; return () => {} } },
    effect: (fn) => { fn(); return () => {} },
  })
  const server = createServer((req, res) => handler(req, res))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  const lyricsUrl = (file) => `${base}/media-preview/lyrics?sessionId=s&path=${encodeURIComponent(file)}`

  const found = await (await fetch(lyricsUrl(song))).json()
  check('found true', found.ok === true && found.value.found === true)
  check('lines returned', found.value.lines.length === 2, `n=${found.value.lines?.length}`)
  check('meta returned', found.value.meta.ti === 'Song')
  check('time is seconds', near(found.value.lines[0].time, 1))
  check('sidecar name reported', found.value.name === 'song.lrc', found.value.name)

  const missing = await (await fetch(lyricsUrl(bare))).json()
  check('missing lrc is found:false, not an error', missing.ok === true && missing.value.found === false)

  const upper = await (await fetch(lyricsUrl(casing))).json()
  check('uppercase .LRC is discovered', upper.value.found === true && upper.value.lines.length === 1)

  const notMedia = await fetch(`${base}/media-preview/lyrics?sessionId=s&path=${encodeURIComponent(join(root, 'x.txt'))}`)
  check('non-media path refused', notMedia.status === 403)

  const shell = await fetch(lyricsUrl(song), { headers: { origin: 'dsh-app://app', 'sec-fetch-site': 'cross-site' } })
  check('shell origin admitted', shell.status === 200)
  check('shell origin gets CORS', shell.headers.get('access-control-allow-origin') === 'dsh-app://app')

  server.close()
}

console.log(`\n${pass} checks passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
