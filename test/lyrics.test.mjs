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

// ── Enhanced LRC: word-level timestamps ─────────────────────────────────────
console.log('\nEnhanced LRC word timestamps')
{
  const { lines } = parseLyrics('[00:12.50]<00:12.50>I <00:12.90>see <00:13.40>trees')
  check('one line', lines.length === 1, `n=${lines.length}`)
  check('line carries words', Array.isArray(lines[0].words), `words=${lines[0].words}`)
  check('three words', lines[0].words.length === 3, `n=${lines[0].words.length}`)
  check('word text preserved', lines[0].words.map((w) => w.text).join('') === 'I see trees', JSON.stringify(lines[0].words.map((w) => w.text)))
  check('word times parsed', near(lines[0].words[1].time, 12.9), `t=${lines[0].words[1].time}`)
  check('plain text still available', lines[0].text === 'I see trees', `t=${lines[0].text}`)
  check('line time unchanged', near(lines[0].time, 12.5))
}

console.log('\nleading text before the first word timestamp keeps the line time')
{
  const { lines } = parseLyrics('[00:10.00]Oh <00:10.50>baby')
  check('two segments', lines[0].words.length === 2, `n=${lines[0].words.length}`)
  check('leading segment at line time', near(lines[0].words[0].time, 10), `t=${lines[0].words[0].time}`)
  check('leading text kept', lines[0].words[0].text.trim() === 'Oh', JSON.stringify(lines[0].words[0].text))
}

console.log('\nChinese word timestamps')
{
  // The shape Chinese karaoke files use: one timestamp per character/run.
  const { lines } = parseLyrics('[00:13.80]<00:13.80>路灯<00:14.50>把影子<00:15.20>拉得很长')
  check('three runs', lines[0].words.length === 3, `n=${lines[0].words.length}`)
  check('characters preserved', lines[0].words.map((w) => w.text).join('') === '路灯把影子拉得很长')
  check('second run timed', near(lines[0].words[1].time, 14.5))
}

console.log('\nline-level files are unaffected')
{
  // The regression that matters most: no word markers must mean no `words`.
  const { lines } = parseLyrics('[00:13.80]路灯把影子拉得很长')
  check('no words array', lines[0].words === undefined, `words=${lines[0].words}`)
  check('text intact', lines[0].text === '路灯把影子拉得很长')
}

console.log('\nmultiple timestamps repeat word timings')
{
  const { lines } = parseLyrics('[00:10.00][00:50.00]<00:10.00>la <00:10.40>la')
  check('two lines', lines.length === 2, `n=${lines.length}`)
  check('both carry words', lines.every((l) => Array.isArray(l.words) && l.words.length === 2))
}

console.log('\nword timestamps combine with a section marker')
{
  const { lines } = parseLyrics('[00:13.80][Chorus]<00:13.80>晚风<00:14.20>邮局')
  check('section captured', lines[0].section === 'Chorus', `s=${lines[0].section}`)
  check('marker not in the text', lines[0].text === '晚风邮局', `t=${lines[0].text}`)
  check('words clean of markers', lines[0].words.length === 2, `n=${lines[0].words.length}`)
}

console.log('\noffset shifts word timestamps too')
{
  const { lines } = parseLyrics('[offset:500]\n[00:10.00]<00:10.00>a <00:11.00>b')
  // The line moved to 9.5; words follow the same shift so highlighting stays aligned.
  check('line shifted', near(lines[0].time, 9.5), `t=${lines[0].time}`)
  check('words shifted with it', near(lines[0].words[0].time, 9.5), `t=${lines[0].words[0].time}`)
}

console.log('\nmalformed word timestamps degrade to text')
{
  const { lines } = parseLyrics('[00:10.00]unclosed <00:11.00 tag')
  check('no crash, text preserved', lines.length === 1 && lines[0].words === undefined, `words=${lines[0].words}`)
  check('literal text kept', lines[0].text.includes('tag'), `t=${lines[0].text}`)
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
