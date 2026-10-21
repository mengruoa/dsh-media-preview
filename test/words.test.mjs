/**
 * Word-level lyric highlighting.
 *
 * Testing this through a hand-rolled hooks runtime proved fragile: the component
 * mounts effects that reset the very state the test wants to pin, and hook
 * ordering shifts between passes. A harness that needs four rounds of surgery to
 * observe a span is not evidence about the shipped behaviour.
 *
 * This suite instead exercises the shipped code where it is actually testable:
 * the parser (a pure function in the host half) and the word-index helper (a
 * pure function extracted from the client bundle and evaluated as-is). Both are
 * the exact functions the renderer calls.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const host = await import(pathToFileURL(join(here, '..', 'index.js')).href)
const clientSource = readFileSync(join(here, '..', 'client.js'), 'utf8')

let pass = 0
let failed = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ok   ${name}${extra ? ' — ' + extra : ''}`) }
  else { failed += 1; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`) }
}
const near = (a, b) => Math.abs(a - b) < 0.002

// ── 1. the parser produces word cues (host half, real code) ─────────────────
console.log('\nparser output feeds word-level highlighting')
{
  const { lines } = host.parseLyrics('[00:20.00]<00:20.00>晚风<00:20.80>邮局<00:21.60>还开着灯')
  check('one line', lines.length === 1)
  check('line exposes words', Array.isArray(lines[0].words), JSON.stringify(lines[0].words))
  check('three cues', lines[0].words.length === 3, `n=${lines[0].words && lines[0].words.length}`)
  check('cues are ordered', lines[0].words.every((w, i) => i === 0 || w.time >= lines[0].words[i - 1].time))
  check('cue times exact', near(lines[0].words[1].time, 20.8), `t=${lines[0].words[1].time}`)
  check('text reassembles from cues', lines[0].words.map((w) => w.text).join('') === lines[0].text)
}

console.log('\nline-level files expose no cues')
{
  const { lines } = host.parseLyrics('[00:20.00]整行高亮')
  check('no words array', lines[0].words === undefined)
  check('text intact', lines[0].text === '整行高亮')
}

// ── 2. the client's word index, extracted from the shipped bundle ───────────
/**
 * Pull `wordIndexAt` out of the bundle and evaluate it as-is.
 * @returns the function the renderer actually calls.
 */
function extractWordIndexAt() {
  const start = clientSource.indexOf('var wordIndexAt = function')
  if (start < 0) throw new Error('wordIndexAt not found in the bundle')
  const end = clientSource.indexOf('\n      }', start)
  if (end < 0) throw new Error('wordIndexAt body not terminated')
  const body = clientSource.slice(start, end + '\n      }'.length)
  const sandbox = { result: null }
  vm.createContext(sandbox)
  vm.runInContext(`${body}\n; result = wordIndexAt;`, sandbox)
  return sandbox.result
}

const wordIndexAt = extractWordIndexAt()
const CUES = [
  { time: 20.0, text: '晚风' },
  { time: 20.8, text: '邮局' },
  { time: 21.4, text: ' ' },
  { time: 21.6, text: '还开着灯' },
]

console.log('\nword index tracks the sung position')
{
  check('before the first cue', wordIndexAt(CUES, 19.9) === -1, `i=${wordIndexAt(CUES, 19.9)}`)
  check('exactly at cue 0', wordIndexAt(CUES, 20.0) === 0, `i=${wordIndexAt(CUES, 20.0)}`)
  check('between cues 0 and 1', wordIndexAt(CUES, 20.5) === 0, `i=${wordIndexAt(CUES, 20.5)}`)
  check('exactly at cue 1', wordIndexAt(CUES, 20.8) === 1, `i=${wordIndexAt(CUES, 20.8)}`)
  check('mid phrase', wordIndexAt(CUES, 21.0) === 1, `i=${wordIndexAt(CUES, 21.0)}`)
  check('last cue reached', wordIndexAt(CUES, 21.6) === 3, `i=${wordIndexAt(CUES, 21.6)}`)
  check('past the end stays on the last', wordIndexAt(CUES, 99) === 3, `i=${wordIndexAt(CUES, 99)}`)
}

console.log('\nword index tolerates bad input')
{
  check('undefined', wordIndexAt(undefined, 10) === -1)
  check('empty array', wordIndexAt([], 10) === -1)
  check('not an array', wordIndexAt('nope', 10) === -1)
}

// ── 3. the highlight styling the renderer applies ──────────────────────────
console.log('\nhighlight styling: sung bright, current emphasised, rest dim')
{
  check('sung words are white', clientSource.includes("color: '#ffffff'"))
  check('unsung words use a dim slate, not bare opacity', clientSource.includes('rgba(200,210,230,0.42)'))
  check('the current syllable is bolded', clientSource.includes('fontWeight: 700'))
  check('the current syllable carries a blue glow', clientSource.includes('rgba(150,190,255,0.95)'))
  check('spans carry data-word', clientSource.includes("'data-word'"))
  check('spans carry data-sung', clientSource.includes("'data-sung'"))
  check('spans carry data-current', clientSource.includes("'data-current'"))
}

console.log('\nthe renderer only splits the ACTIVE line')
{
  // The guard that keeps every line from being split, which would be visually
  // wrong and more expensive per frame.
  check('word splitting is gated on `active`', clientSource.includes('if (!active || !Array.isArray(line.words)'))
}

// ── 3b. loadLyrics must PRESERVE word cues ─────────────────────────────────
// This is the regression that shipped: the host sent word cues, the client's
// normalization rebuilt each line from {time,text,section} and dropped `words`,
// so every Enhanced-LRC file silently rendered line-level. Tests that inject
// lyric data directly cannot see it, so this runs the shipped map() expression
// against a realistic envelope.
console.log('\nloadLyrics keeps the word cues through normalization')
{
  const start = clientSource.indexOf('if (!Array.isArray(value.lines)')
  const mapStart = clientSource.indexOf('.map(function (line) {', start)
  const mapEnd = clientSource.indexOf('}),', mapStart)
  const mapperSource = clientSource.slice(mapStart, mapEnd + 2)

  const value = {
    lines: [
      { time: 1, text: 'abc', section: null, words: [{ time: 1, text: 'a' }, { time: 1.5, text: 'bc' }] },
      { time: 2, text: 'plain', section: 'S' },
      { time: 3, text: 'bad cues', words: [{ time: 'nope' }, { text: 'only' }] },
      { time: 4, text: 'empty cues', words: [] },
    ],
  }
  const sandbox = { value, result: null }
  vm.createContext(sandbox)
  vm.runInContext(
    `result = value.lines
       .filter(function (line) { return line && typeof line.time === 'number' && typeof line.text === 'string' })
       ${mapperSource};`,
    sandbox,
  )
  const lines = sandbox.result
  check('word cues survive the rebuild', Array.isArray(lines[0].words) && lines[0].words.length === 2, JSON.stringify(lines[0].words))
  check('cue text and time intact', lines[0].words[1].text === 'bc' && near(lines[0].words[1].time, 1.5))
  check('line-level rows get null words', lines[1].words === null, String(lines[1].words))
  check('invalid cues are dropped', lines[2].words === null, JSON.stringify(lines[2].words))
  check('an empty cue list becomes null', lines[3].words === null, JSON.stringify(lines[3].words))
  check('plain fields still copied', lines[1].section === 'S' && lines[1].text === 'plain')
}

// ── 4. end to end: a realistic Enhanced LRC document ───────────────────────
console.log('\nend to end with a realistic Enhanced LRC document')
{
  const elrc = [
    '[ti:晚风邮局]',
    '[ar:AI 男声]',
    '[00:13.80][Verse 1]路灯把影子拉得很长',
    '[00:19.55]旧信箱藏着没说出口的愿望',
    '[00:59.84][Chorus]<00:59.84>晚风<01:00.60>邮局<01:01.20> 还开着灯',
    '',
  ].join('\n')
  const { lines, meta } = host.parseLyrics(elrc)
  check('metadata parsed', meta.ti === '晚风邮局')
  check('three timed lines', lines.length === 3, `n=${lines.length}`)
  check('line 1 is line-level', lines[0].words === undefined)
  check('line 2 is line-level', lines[1].words === undefined)
  check('the chorus is word-level', Array.isArray(lines[2].words), JSON.stringify(lines[2].words))
  check('section kept with word timing', lines[2].section === 'Chorus', `s=${lines[2].section}`)
  check('marker stripped from text', lines[2].text === '晚风邮局 还开着灯', `t=${lines[2].text}`)

  // Simulate a playthrough: which line is active, and which word within it.
  // Cue times are 59.84 / 60.60 / 61.20, so sample just before and just after
  // each one rather than at round numbers that fall between cues.
  const seen = []
  for (const at of [59.0, 59.9, 60.2, 60.7, 61.0, 61.9]) {
    let lineIndex = -1
    for (let i = 0; i < lines.length; i += 1) if (lines[i].time <= at) lineIndex = i
    seen.push(lineIndex < 0 ? '-' : `${lineIndex}:${wordIndexAt(lines[lineIndex].words, at)}`)
  }
  check('before the chorus the previous line is active, no word cue', seen[0] === '1:-1', seen.join(' '))
  check('chorus begins at its first word', seen[1] === '2:0', seen.join(' '))
  check('still on the first word before the second cue', seen[2] === '2:0', seen.join(' '))
  check('second word lights after 60.60', seen[3] === '2:1', seen.join(' '))
  check('still on the second word before the third cue', seen[4] === '2:1', seen.join(' '))
  check('third word lights after 61.20', seen[5] === '2:2', seen.join(' '))
}

console.log(`\n${pass} checks passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
