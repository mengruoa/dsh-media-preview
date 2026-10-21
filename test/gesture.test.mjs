/**
 * Gesture behaviour tests.
 *
 * The client bundle is a lazy-CJS closure that only needs `require('react')`
 * and `window.__ModuleLoader__`. This harness supplies a MINIMAL hooks runtime
 * plus a function-component resolver, so the REAL component runs and its REAL
 * pointer handlers are invoked with synthetic events — not a reimplementation
 * of the gesture maths.
 *
 * Pinned behaviours:
 *   - horizontal swipe seeks, proportional to stage width, clamped to bounds
 *   - vertical swipe changes volume, clamped to 0..1
 *   - diagonal swipe locks ONE axis
 *   - a tap toggles playback once, after a double-tap window
 *   - double tap skips ±10s (right half forward, left half back)
 *   - long press engages 3x and restores the PREVIOUS rate
 *   - a cancelled pointer never counts as a tap
 *   - the touch layout activates under a coarse pointer
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')

const ELEMENT = Symbol('element')

function h(type, props, ...children) {
  const flat = []
  const push = (value) => {
    if (value === null || value === undefined || value === false) return
    if (Array.isArray(value)) { for (const item of value) push(item); return }
    flat.push(value)
  }
  if (children.length === 1) push(children[0])
  else if (children.length > 1) push(children)
  return { [ELEMENT]: true, type, props: { ...(props ?? {}), children: flat.length <= 1 ? flat[0] : flat } }
}

/** Depth-first search. */
function find(node, predicate) {
  if (node === null || node === undefined || typeof node !== 'object') return undefined
  if (node[ELEMENT] && predicate(node)) return node
  const children = node[ELEMENT] ? node.props.children : undefined
  const list = Array.isArray(children) ? children : children === undefined ? [] : [children]
  for (const child of list) {
    const found = find(child, predicate)
    if (found !== undefined) return found
  }
  return undefined
}

let pass = 0
let failed = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ok   ${name}${extra ? ' — ' + extra : ''}`) }
  else { failed += 1; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`) }
}

/**
 * Mount the real video viewer.
 * @param options - media facts plus the stage rect the gestures measure against.
 * @returns the media double, the captured gesture handlers and the stage ref.
 */
function mount(options = {}) {
  const {
    duration = 300, currentTime = 100, volume = 0.5, paused = true, rate = 1,
    stageWidth = 400, stageHeight = 200, compact = false, kind = 'video',
  } = options

  const registrations = []
  const sandbox = {
    window: {
      __ModuleLoader__: { load(r) { registrations.push(r) } },
      matchMedia: (query) => ({ matches: compact, media: query, addEventListener() {}, removeEventListener() {} }),
    },
    console, setTimeout, clearTimeout, Date, Math, Number, Object, Array, String, JSON,
    isFinite, URLSearchParams,
    DOMException: class DOMException extends Error {},
    fetch: async () => { throw new Error('network disabled in tests') },
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client.js' })
  const registration = registrations[0]
  if (registration === undefined) throw new Error('bundle registered no factory')

  // ── media double ──────────────────────────────────────────────────────────
  const listeners = new Map()
  const media = {
    duration, currentTime, volume, muted: false, paused, playbackRate: rate,
    _plays: 0, _pauses: 0,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(fn)
    },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn) },
    play() { media.paused = false; media._plays += 1; return Promise.resolve() },
    pause() { media.paused = true; media._pauses += 1 },
  }

  // ── hooks ─────────────────────────────────────────────────────────────────
  const hooks = []
  let cursor = 0
  const handlers = {}
  let stageRefObject = null

  const React = {
    Fragment: 'Fragment',
    createElement(type, props, ...children) {
      const node = h(type, props, ...children)
      if (type === 'video' || type === 'audio') {
        node._media = true
        if (props && props.ref && typeof props.ref === 'object') props.ref.current = media
      }
      if (props && typeof props.onPointerDown === 'function') {
        handlers.pointerDown = props.onPointerDown
        handlers.pointerMove = props.onPointerMove
        handlers.pointerUp = props.onPointerUp
        handlers.pointerCancel = props.onPointerCancel
        handlers.gestureStyle = props.style
      }
      // The root carries the keyboard transport.
      if (props && typeof props.onKeyDown === 'function') handlers.keyDown = props.onKeyDown
      // Volume / mute / speed buttons, captured by their handler identity.
      if (props && typeof props.onChange === 'function' && props['aria-label'] === 'Volume') handlers.volumeChange = props.onChange
      if (props && typeof props.onClick === 'function' && (props['aria-label'] === 'Mute' || props['aria-label'] === 'Unmute')) handlers.muteClick = props.onClick
      if (props && typeof props.onClick === 'function' && props['aria-label'] === 'Playback speed') handlers.rateClick = props.onClick
      // The stage is the node whose ref the swipe maths measures.
      if (props && props.ref && typeof props.ref === 'object' && props.style && props.style.position === 'relative') {
        stageRefObject = props.ref
      }
      return node
    },
    useState(initial) {
      const index = cursor++
      if (hooks[index] === undefined) hooks[index] = { value: typeof initial === 'function' ? initial() : initial }
      const slot = hooks[index]
      const set = (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next
        if (!Object.is(value, slot.value)) { slot.value = value; slot.dirty = true }
      }
      return [slot.value, set]
    },
    useRef(initial) {
      const index = cursor++
      if (hooks[index] === undefined) hooks[index] = { current: initial }
      return hooks[index]
    },
    useEffect(fn, deps) {
      const index = cursor++
      const prev = hooks[index]
      if (prev === undefined) {
        const slot = { deps, run: fn, cleanup: undefined, pending: true }
        hooks[index] = slot
      } else if (deps === undefined || prev.deps === undefined || deps.length !== prev.deps.length || deps.some((d, i) => !Object.is(d, prev.deps[i]))) {
        prev.deps = deps
        prev.run = fn
        prev.pending = true
      }
    },
    useMemo(fn, deps) { return fn() },
    useCallback(fn) { return fn },
  }

  // ── resolve function components, running MediaSurface's hooks ────────────
  const render = (node) => {
    let current = node
    for (let guard = 0; guard < 16; guard += 1) {
      if (current === null || typeof current !== 'object' || !current[ELEMENT]) return current
      if (typeof current.type !== 'function') return current
      const produce = current.type
      current = produce(current.props)
      // Resolve children recursively is unnecessary here: we only need the
      // handler-bearing layer, which lives in MediaSurface's own output.
    }
    return current
  }

  const exportsObj = registration.factory((spec) => {
    if (spec === 'react') return React
    throw new Error(`unexpected require(${spec})`)
  })

  let descriptor = null
  exportsObj.apply({
    betterSidebar: {
      registerFileViewer(d) {
        if (String(d.id).includes(kind === 'audio' ? 'audio' : 'video')) descriptor = d
        return () => {}
      },
    },
    effect(fn) { fn() },
  })
  if (descriptor === null) throw new Error(`${kind} descriptor was not registered`)

  const props = {
    customData: { kind, url: '/media-preview/media?x=1', name: 'clip.' + (kind === 'audio' ? 'mp3' : 'mp4'), path: '/clip', size: 1000 },
    title: 'clip',
  }

  // Pass 1: Viewer → MediaSurface (hooks run here).
  cursor = 0
  let tree = render(descriptor.component(props))
  // Effects (event listeners) are installed on mount.
  for (const slot of hooks) {
    if (slot && slot.pending) { slot.pending = false; slot.cleanup = slot.run() }
  }
  // A state-setting effect may need one more pass to settle the tree.
  if (hooks.some((slot) => slot && slot.dirty)) {
    for (const slot of hooks) if (slot) slot.dirty = false
    cursor = 0
    tree = render(descriptor.component(props))
    for (const slot of hooks) {
      if (slot && slot.pending) { slot.pending = false; slot.cleanup = slot.run() }
    }
  }

  const stageElement = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: stageWidth, height: stageHeight, right: stageWidth, bottom: stageHeight }),
  }
  if (stageRefObject !== null) stageRefObject.current = stageElement

  return { media, handlers, tree, stage: stageElement }
}

/** Synthetic pointer event. */
function pointer(id, x, y) {
  return {
    pointerId: id, clientX: x, clientY: y, button: 0,
    currentTarget: { setPointerCapture() {}, releasePointerCapture() {} },
  }
}

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ── horizontal swipe ────────────────────────────────────────────────────────
console.log('\nhorizontal swipe seeks proportionally')
{
  const { media, handlers, stage } = mount({ duration: 300, currentTime: 100 })
  handlers.pointerDown(pointer(1, 100, 100))
  // Half the width → half of min(90s, 300s) = 45s.
  handlers.pointerMove(pointer(1, 100 + stage.getBoundingClientRect().width / 2, 100))
  check('swipe right seeks forward 45s', Math.abs(media.currentTime - 145) < 0.001, `ct=${media.currentTime}`)
  handlers.pointerUp(pointer(1, 300, 100))
}

console.log('\nswipe clamps at the start of the clip')
{
  const { media, handlers, stage } = mount({ duration: 300, currentTime: 10 })
  handlers.pointerDown(pointer(1, 100, 100))
  handlers.pointerMove(pointer(1, 100 - stage.getBoundingClientRect().width * 2, 100))
  check('cannot seek below 0', media.currentTime === 0, `ct=${media.currentTime}`)
  handlers.pointerUp(pointer(1, 0, 100))
}

console.log('\nswipe span is capped for short clips')
{
  const { media, handlers, stage } = mount({ duration: 20, currentTime: 5 })
  handlers.pointerDown(pointer(1, 100, 100))
  // Full width → full min(90, 20) = 20s → clamped at the end.
  handlers.pointerMove(pointer(1, 100 + stage.getBoundingClientRect().width, 100))
  check('clamped to duration', media.currentTime === 20, `ct=${media.currentTime}`)
  handlers.pointerUp(pointer(1, 500, 100))
}

// ── vertical swipe ──────────────────────────────────────────────────────────
console.log('\nvertical swipe changes volume')
{
  const { media, handlers, stage } = mount({ duration: 300, currentTime: 100, volume: 0.5 })
  const height = stage.getBoundingClientRect().height
  handlers.pointerDown(pointer(2, 100, 100))
  handlers.pointerMove(pointer(2, 100, 100 - height / 2))
  check('swipe up raises volume', Math.abs(media.volume - 1) < 0.001, `vol=${media.volume}`)
  handlers.pointerMove(pointer(2, 100, 100 + height))
  check('swipe down clamps at 0', media.volume === 0, `vol=${media.volume}`)
  check('seek untouched by volume gesture', media.currentTime === 100, `ct=${media.currentTime}`)
  handlers.pointerUp(pointer(2, 100, 300))
}

// ── axis lock ───────────────────────────────────────────────────────────────
console.log('\ndiagonal swipe locks one axis')
{
  const { media, handlers } = mount({ duration: 300, currentTime: 100, volume: 0.5 })
  handlers.pointerDown(pointer(3, 100, 100))
  handlers.pointerMove(pointer(3, 200, 108)) // mostly horizontal
  check('horizontal-dominant locks seek', media.currentTime > 100, `ct=${media.currentTime}`)
  check('vertical drift leaves volume alone', media.volume === 0.5, `vol=${media.volume}`)
  handlers.pointerUp(pointer(3, 200, 108))
}

console.log('\nvertical-dominant swipe never seeks')
{
  const { media, handlers } = mount({ duration: 300, currentTime: 100, volume: 0.5 })
  handlers.pointerDown(pointer(3, 100, 100))
  handlers.pointerMove(pointer(3, 108, 160)) // mostly vertical
  check('volume moved', media.volume !== 0.5, `vol=${media.volume}`)
  check('seek untouched', media.currentTime === 100, `ct=${media.currentTime}`)
  handlers.pointerUp(pointer(3, 108, 160))
}

// ── tap ─────────────────────────────────────────────────────────────────────
console.log('\nsingle tap toggles playback after the double-tap window')
{
  const { media, handlers } = mount({ duration: 300, currentTime: 100, paused: true })
  handlers.pointerDown(pointer(4, 100, 100))
  handlers.pointerUp(pointer(4, 100, 100))
  check('play deferred', media._plays === 0)
  await settle(320)
  check('single tap played once', media._plays === 1, `plays=${media._plays}`)
}

console.log('\nsingle tap pauses a playing clip')
{
  const { media, handlers } = mount({ duration: 300, currentTime: 100, paused: false })
  handlers.pointerDown(pointer(4, 100, 100))
  handlers.pointerUp(pointer(4, 100, 100))
  await settle(320)
  check('single tap paused', media._pauses === 1, `pauses=${media._pauses}`)
}

// ── double tap ──────────────────────────────────────────────────────────────
console.log('\ndouble tap on the right half skips forward')
{
  const { media, handlers } = mount({ duration: 300, currentTime: 100, paused: true })
  handlers.pointerDown(pointer(5, 300, 100))
  handlers.pointerUp(pointer(5, 300, 100))
  handlers.pointerDown(pointer(5, 300, 100))
  handlers.pointerUp(pointer(5, 300, 100))
  check('seeked +10s', Math.abs(media.currentTime - 110) < 0.001, `ct=${media.currentTime}`)
  await settle(320)
  check('did not toggle playback', media._plays === 0, `plays=${media._plays}`)
}

console.log('\ndouble tap on the left half skips back')
{
  const { media, handlers } = mount({ duration: 300, currentTime: 100, paused: true })
  handlers.pointerDown(pointer(6, 50, 100))
  handlers.pointerUp(pointer(6, 50, 100))
  handlers.pointerDown(pointer(6, 50, 100))
  handlers.pointerUp(pointer(6, 50, 100))
  check('seeked -10s', Math.abs(media.currentTime - 90) < 0.001, `ct=${media.currentTime}`)
}

console.log('\ndouble tap near the start clamps to 0')
{
  const { media, handlers } = mount({ duration: 300, currentTime: 4, paused: true })
  handlers.pointerDown(pointer(6, 50, 100))
  handlers.pointerUp(pointer(6, 50, 100))
  handlers.pointerDown(pointer(6, 50, 100))
  handlers.pointerUp(pointer(6, 50, 100))
  check('clamped at 0', media.currentTime === 0, `ct=${media.currentTime}`)
}

// ── long press ──────────────────────────────────────────────────────────────
console.log('\nlong press fast-forwards then restores the previous rate')
{
  const { media, handlers } = mount({ duration: 300, currentTime: 100, paused: true, rate: 1.5 })
  handlers.pointerDown(pointer(7, 100, 100))
  await settle(560)
  check('engaged 3x', media.playbackRate === 3, `rate=${media.playbackRate}`)
  handlers.pointerUp(pointer(7, 100, 100))
  check('restored 1.5x', media.playbackRate === 1.5, `rate=${media.playbackRate}`)
}

console.log('\nlong press on a playing clip keeps playing')
{
  const { media, handlers } = mount({ duration: 300, currentTime: 100, paused: false, rate: 1 })
  handlers.pointerDown(pointer(7, 100, 100))
  await settle(560)
  handlers.pointerUp(pointer(7, 100, 100))
  check('still playing', media.paused === false)
  check('rate back to 1', media.playbackRate === 1, `rate=${media.playbackRate}`)
}

console.log('\nmoving before the long-press timer cancels it')
{
  const { media, handlers } = mount({ duration: 300, currentTime: 100, paused: true, rate: 1 })
  handlers.pointerDown(pointer(7, 100, 100))
  handlers.pointerMove(pointer(7, 180, 100))
  await settle(600)
  check('no fast-forward from a swipe', media.playbackRate === 1, `rate=${media.playbackRate}`)
  handlers.pointerUp(pointer(7, 180, 100))
}

// ── cancel ──────────────────────────────────────────────────────────────────
console.log('\ncancelled pointer never counts as a tap')
{
  const { media, handlers } = mount({ duration: 300, currentTime: 100, paused: true })
  handlers.pointerDown(pointer(8, 100, 100))
  handlers.pointerCancel(pointer(8, 100, 100))
  await settle(320)
  check('never played', media._plays === 0, `plays=${media._plays}`)
}

console.log('\npointer of a different id is ignored')
{
  const { media, handlers } = mount({ duration: 300, currentTime: 100 })
  handlers.pointerDown(pointer(9, 100, 100))
  handlers.pointerMove(pointer(99, 300, 100)) // second finger
  check('foreign pointer does not seek', media.currentTime === 100, `ct=${media.currentTime}`)
  handlers.pointerUp(pointer(9, 100, 100))
}

// ── touch layout ────────────────────────────────────────────────────────────
console.log('\ntouch layout under a coarse pointer')
{
  const { handlers } = mount({ duration: 300, compact: true })
  const style = handlers.gestureStyle
  check('gesture layer disables browser panning', style && style.touchAction === 'none', String(style && style.touchAction))
}

console.log('\nno gesture layer for audio')
{
  const { handlers, tree } = mount({ kind: 'audio', duration: 200 })
  check('audio has no pointer handlers', handlers.pointerDown === undefined)
  const audio = find(tree, (node) => node.type === 'audio')
  check('audio element rendered', audio !== undefined)
}

// ── volume controls (mouse / keyboard mode) ─────────────────────────────────
console.log('\nmute button toggles and remembers the previous level')
{
  const { media, handlers } = mount({ duration: 300, volume: 0.6 })
  check('mute handler present', typeof handlers.muteClick === 'function')
  handlers.muteClick()
  check('muted', media.muted === true)
  check('volume preserved while muted', media.volume === 0.6, `vol=${media.volume}`)
  handlers.muteClick()
  check('unmuted restores level', media.muted === false && media.volume === 0.6, `vol=${media.volume}`)
}

console.log('\nunmuting from zero restores an audible level')
{
  const { media, handlers } = mount({ duration: 300, volume: 0.4 })
  // Enter the muted state through the button (which records the level), then
  // drag the slider to zero — the restorer must still hold the audible level.
  handlers.muteClick()
  check('muted via the button', media.muted === true)
  handlers.muteClick()
  check('back to the recorded level', media.muted === false && Math.abs(media.volume - 0.4) < 0.001, `vol=${media.volume}`)
  handlers.volumeChange({ target: { value: '0' } })
  check('slider to zero mutes', media.muted === true && media.volume === 0, `vol=${media.volume}`)
  handlers.muteClick()
  check('unmute restores the last audible level', media.muted === false && media.volume === 0.4, `vol=${media.volume}`)
}

console.log('\nvolume slider sets the level')
{
  const { media, handlers } = mount({ duration: 300, volume: 1 })
  handlers.volumeChange({ target: { value: '0.35' } })
  check('volume applied', Math.abs(media.volume - 0.35) < 0.001, `vol=${media.volume}`)
  check('not muted at nonzero volume', media.muted === false)
}

console.log('\nvolume slider also un-mutes')
{
  const { media, handlers } = mount({ duration: 300, volume: 0.5 })
  handlers.muteClick()
  check('precondition: muted', media.muted === true)
  handlers.volumeChange({ target: { value: '0.8' } })
  check('raising the slider unmutes', media.muted === false, `muted=${media.muted}`)
}

// ── keyboard shortcuts ─────────────────────────────────────────────────────
/** Synthetic keydown; `prevented` records whether the handler claimed it. */
function key(k, extra = {}) {
  const event = {
    key: k,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    target: { tagName: 'DIV', type: undefined },
    _prevented: false,
    preventDefault() { event._prevented = true },
    stopPropagation() {},
    ...extra,
  }
  return event
}

console.log('\nSpace and K toggle playback')
{
  const { media, handlers } = mount({ duration: 300, paused: true })
  const event = key(' ')
  handlers.keyDown(event)
  check('Space claimed by the player', event._prevented === true)
  await settle(320)
  check('Space played', media._plays === 1, `plays=${media._plays}`)
}

console.log('\narrow keys seek')
{
  const { media, handlers } = mount({ duration: 300, currentTime: 100 })
  handlers.keyDown(key('ArrowRight'))
  check('right +5s', Math.abs(media.currentTime - 105) < 0.001, `ct=${media.currentTime}`)
  handlers.keyDown(key('ArrowLeft'))
  check('left -5s', Math.abs(media.currentTime - 100) < 0.001, `ct=${media.currentTime}`)
}

console.log('\nshift+arrow seeks further')
{
  const { media, handlers } = mount({ duration: 300, currentTime: 100 })
  handlers.keyDown(key('ArrowRight', { shiftKey: true }))
  check('shift+right +30s', Math.abs(media.currentTime - 130) < 0.001, `ct=${media.currentTime}`)
}

console.log('\nJ and L jump 30s')
{
  const { media, handlers } = mount({ duration: 300, currentTime: 100 })
  handlers.keyDown(key('l'))
  check('L +30s', Math.abs(media.currentTime - 130) < 0.001, `ct=${media.currentTime}`)
  handlers.keyDown(key('j'))
  check('J -30s', Math.abs(media.currentTime - 100) < 0.001, `ct=${media.currentTime}`)
}

console.log('\narrow up/down change volume')
{
  const { media, handlers } = mount({ duration: 300, volume: 0.5 })
  handlers.keyDown(key('ArrowUp'))
  check('up +5%', Math.abs(media.volume - 0.55) < 0.001, `vol=${media.volume}`)
  handlers.keyDown(key('ArrowDown'))
  check('down -5%', Math.abs(media.volume - 0.5) < 0.001, `vol=${media.volume}`)
}

console.log('\nvolume keys clamp at the ends')
{
  const { media, handlers } = mount({ duration: 300, volume: 0.02 })
  handlers.keyDown(key('ArrowDown'))
  handlers.keyDown(key('ArrowDown'))
  check('clamped at 0', media.volume === 0, `vol=${media.volume}`)
  for (let i = 0; i < 30; i += 1) handlers.keyDown(key('ArrowUp'))
  check('clamped at 1', media.volume === 1, `vol=${media.volume}`)
}

console.log('\nM mutes')
{
  const { media, handlers } = mount({ duration: 300, volume: 0.7 })
  handlers.keyDown(key('m'))
  check('muted via M', media.muted === true)
  handlers.keyDown(key('m'))
  check('unmuted via M', media.muted === false)
}

console.log('\nHome and End jump to the ends')
{
  const { media, handlers } = mount({ duration: 300, currentTime: 100 })
  handlers.keyDown(key('End'))
  check('End goes to duration', Math.abs(media.currentTime - 300) < 0.001, `ct=${media.currentTime}`)
  handlers.keyDown(key('Home'))
  check('Home goes to 0', media.currentTime === 0, `ct=${media.currentTime}`)
}

console.log('\ndigit keys jump to a percentage')
{
  const { media, handlers } = mount({ duration: 300, currentTime: 0 })
  handlers.keyDown(key('5'))
  check('5 jumps to 50%', Math.abs(media.currentTime - 150) < 0.001, `ct=${media.currentTime}`)
  handlers.keyDown(key('0'))
  check('0 jumps to the start', media.currentTime === 0, `ct=${media.currentTime}`)
}

console.log('\nmodifier combinations are left to the browser')
{
  const { media, handlers } = mount({ duration: 300, currentTime: 100 })
  const event = key('ArrowRight', { ctrlKey: true })
  handlers.keyDown(event)
  check('Ctrl+Right not handled', event._prevented === false)
  check('seek untouched', media.currentTime === 100, `ct=${media.currentTime}`)
}

console.log('\na focused range slider keeps its own arrow keys')
{
  const { media, handlers } = mount({ duration: 300, currentTime: 100 })
  const event = key('ArrowRight', { target: { tagName: 'INPUT', type: 'range' } })
  handlers.keyDown(event)
  check('range input not hijacked', event._prevented === false)
  check('seek untouched', media.currentTime === 100, `ct=${media.currentTime}`)
}

console.log('\nunknown keys are ignored')
{
  const { handlers } = mount({ duration: 300, currentTime: 100 })
  const event = key('q')
  handlers.keyDown(event)
  check('q not claimed', event._prevented === false)
}

console.log(`\n${pass} checks passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
