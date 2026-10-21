/*!
 * dsh-media-preview — client half (browser bundle).
 *
 * Registers TWO file viewers with dsh-better-sidebar from ONE implementation:
 *
 *   id "media-preview:audio"  → AUDIO_EXTS
 *   id "media-preview:video"  → VIDEO_EXTS
 *
 * Both dispatch to the same <MediaSurface> component and the same control bar,
 * which is the point: the audio and video previews cannot behave differently
 * because they are the same code path with a different element tag.
 *
 * Two facts this bundle is built around (see the host half's module docs):
 *
 *  - Media is resolved against the Host's REAL origin when the Electron shell
 *    publishes one (`__DSH_TRANSPORT__.streamBaseUrl`). Going through the
 *    shell's `dsh-app://` forwarding deletes `Content-Length`, which makes
 *    Chromium report `seekable = [0, 0]` and the progress bar refuse to drag.
 *  - The media element sets `crossOrigin` BEFORE `src`. Without it the request
 *    is `no-cors`, omits `Origin`, and the route's trust fence answers 403.
 *
 * Bundle format: the official DSH client-bundle shape — a lazy-CJS closure
 * registered with window.__ModuleLoader__.load({ id, factory }).
 */
window.__ModuleLoader__.load({
  id: 'dsh-media-preview',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    'use strict'

    var react = require('react')

    /** Viewer ids (stable: they key the sidebar's per-viewer enable/disable). */
    var AUDIO_VIEWER_ID = 'media-preview:audio'
    var VIDEO_VIEWER_ID = 'media-preview:video'

    /** Extensions each viewer claims (lowercase, no dot). */
    var AUDIO_EXTS = [
      'mp3', 'wav', 'wave', 'ogg', 'oga', 'opus', 'flac', 'm4a', 'aac',
      'wma', 'aif', 'aiff', 'amr', 'ape', 'caf', 'mka', 'weba',
    ]
    // `.ts` is deliberately absent: in this harness it is a TypeScript source
    // file far more often than a transport stream, and claiming it would
    // shadow the built-in code viewer.
    var VIDEO_EXTS = [
      'mp4', 'm4v', 'webm', 'ogv', 'mov', 'qt', 'mkv', 'avi', 'wmv', 'flv',
      'mpeg', 'mpg', '3gp', '3g2', 'm2ts', 'mts',
    ]

    /** Route prefix registered by the host half. */
    var ROUTE_PREFIX = '/media-preview'

    // ── URL resolution ──────────────────────────────────────────────────────

    /**
     * Absolute base for the plugin's own host route.
     *
     * The Desktop shell serves the GUI from `dsh-app://app` and forwards every
     * non-static path to the Host through `forwardWebRequest`, which deletes
     * `Content-Length` and re-wraps the body as a stream. A length-less media
     * body leaves the element with `seekable = [0, 0]`: it plays, but the
     * progress bar snaps back. The shell publishes the Host's real origin on
     * `__DSH_TRANSPORT__.streamBaseUrl`; resolving against it keeps
     * `Content-Length` and restores seeking. An ordinary http(s) page has no
     * such global and stays document-relative, which is also what carries a
     * reverse-proxy directory prefix.
     * @returns the absolute origin, or '' to stay document-relative.
     */
    function mediaBase() {
      var transport = globalThis.__DSH_TRANSPORT__
      var base = transport && transport.streamBaseUrl
      return typeof base === 'string' && base !== '' ? base : ''
    }

    /**
     * Build one route URL.
     * @param kind - 'meta' or 'media'.
     * @param params - session, path and optional cwd fallback.
     * @returns the URL to fetch.
     */
    function routeUrl(kind, params) {
      var search = new URLSearchParams()
      search.set('sessionId', params.sessionId)
      search.set('path', params.path)
      if (params.cwd !== undefined && params.cwd !== '') search.set('cwd', params.cwd)
      var route = ROUTE_PREFIX + '/' + kind + '?' + search.toString()
      var base = mediaBase()
      return base === '' ? route : base.replace(/\/+$/, '') + route
    }

    // ── source loading (fetchStrategy: 'custom') ────────────────────────────

    /**
     * Resolve a file to a playable source through the host's metadata probe.
     * @param path - the path better-sidebar opened.
     * @param scope - the session scope (id, and a cwd fallback when present).
     * @param signal - aborts the probe when the viewer unmounts.
     * @returns the source facts, or the failure to display.
     */
    async function loadMediaSource(path, scope, signal) {
      var params = { sessionId: scope.sessionId, path: path, cwd: scope.cwd }
      try {
        var response = await fetch(routeUrl('meta', params), {
          signal: signal,
          headers: { accept: 'application/json' },
        })
        var envelope = await response.json().catch(() => null)
        if (envelope === null || envelope.ok !== true || typeof envelope.value !== 'object' || envelope.value === null) {
          return { error: envelope && envelope.error && typeof envelope.error.message === 'string' ? envelope.error.message : 'HTTP ' + response.status }
        }
        var value = envelope.value
        return {
          url: routeUrl('media', params),
          path: typeof value.path === 'string' ? value.path : path,
          name: typeof value.name === 'string' ? value.name : path,
          size: typeof value.size === 'number' ? value.size : 0,
          mime: typeof value.mime === 'string' ? value.mime : 'application/octet-stream',
          kind: value.kind === 'audio' ? 'audio' : 'video',
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return { error: 'aborted' }
        return { error: error instanceof Error ? error.message : String(error) }
      }
    }

    // ── formatting ─────────────────────────────────────────────────────────

    /** Clock text for one offset (0:07 / 3:41 / 1:02:03). */
    function clockText(seconds) {
      if (!isFinite(seconds) || seconds < 0) seconds = 0
      var whole = Math.floor(seconds)
      var s = whole % 60
      var m = Math.floor(whole / 60) % 60
      var h = Math.floor(whole / 3600)
      var mm = h > 0 && m < 10 ? '0' + m : String(m)
      var ss = s < 10 ? '0' + s : String(s)
      return h > 0 ? h + ':' + mm + ':' + ss : m + ':' + ss
    }

    /** Human byte size. */
    function sizeText(bytes) {
      if (!isFinite(bytes) || bytes <= 0) return ''
      var units = ['B', 'KB', 'MB', 'GB', 'TB']
      var value = bytes
      var unit = 0
      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024
        unit += 1
      }
      return (unit === 0 ? String(value) : value.toFixed(value >= 10 ? 0 : 1)) + ' ' + units[unit]
    }

    // ── gestures ───────────────────────────────────────────────────────────

    /** Seconds a full-width horizontal swipe can traverse (capped by duration). */
    var SEEK_SWIPE_SPAN = 90
    /** Double-tap skip distance, in seconds. */
    var SEEK_STEP = 10
    /** Movement (px) before an undecided drag picks an axis. */
    var AXIS_THRESHOLD = 10
    /** Long-press duration before the temporary fast-forward engages (ms). */
    var LONG_PRESS_MS = 500
    /** Single-tap fires after this delay so a double tap can cancel it (ms). */
    var TAP_DELAY_MS = 250
    /** Two taps closer than this in time (and space) are a double tap (ms). */
    var DOUBLE_TAP_MS = 320

    /** Clamp to a range, tolerating NaN. */
    function clamp(value, min, max) {
      if (!isFinite(value)) return min
      if (max < min) return min
      return Math.min(Math.max(value, min), max)
    }

    /** Clamp to 0..1. */
    function clamp01(value) {
      return clamp(value, 0, 1)
    }

    /**
     * Whether the player should use its touch layout.
     *
     * Keyed on the pointer rather than the window width: a narrow desktop
     * window still has a mouse (and wants the dense bar with more precision),
     * while a phone or tablet in landscape is wide but still needs 44px targets.
     * Width is a secondary signal for coarse-pointer-less touch hardware.
     * @returns true when the touch layout applies.
     */
    function useCompact() {
      var state = react.useState(false)
      var compact = state[0], setCompact = state[1]
      react.useEffect(function () {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined
        var query = window.matchMedia('(pointer: coarse), (max-width: 520px)')
        var update = function () { setCompact(query.matches) }
        update()
        if (typeof query.addEventListener === 'function') {
          query.addEventListener('change', update)
          return function () { query.removeEventListener('change', update) }
        }
        query.addListener(update)
        return function () { query.removeListener(update) }
      }, [])
      return compact
    }

    // ── icons (16px, currentColor, the app's outline style) ────────────────

    function iconAudio(size) {
      return react.createElement('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        xmlns: 'http://www.w3.org/2000/svg', 'aria-hidden': true, focusable: 'false',
      }, [
        react.createElement('path', {
          key: 'body',
          d: 'M8.4 2.2 5 5.1H2.75v5.8H5l3.4 2.9z',
          fill: 'currentColor',
        }),
        react.createElement('path', {
          key: 'wave',
          d: 'M10.8 5.6a3.2 3.2 0 0 1 0 4.8M12.6 3.7a5.8 5.8 0 0 1 0 8.6',
          stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round',
        }),
      ])
    }

    function iconVideo(size) {
      return react.createElement('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        xmlns: 'http://www.w3.org/2000/svg', 'aria-hidden': true, focusable: 'false',
      }, [
        react.createElement('rect', {
          key: 'frame',
          x: 1.6, y: 3, width: 12.8, height: 10, rx: 2,
          stroke: 'currentColor', strokeWidth: 1.3,
        }),
        react.createElement('path', {
          key: 'play',
          d: 'm6.3 5.9 4.1 2.4-4.1 2.4z',
          fill: 'currentColor',
        }),
      ])
    }

    // ── the shared viewer ──────────────────────────────────────────────────

    /**
     * Normalize the host's `<audio>`/`<video>` error into readable text.
     * @param element - the media element.
     * @returns a message, or null when there is no error.
     */
    function mediaErrorText(element) {
      var error = element && element.error
      if (!error) return null
      switch (error.code) {
        case 1: return 'Playback was aborted.'
        case 2: return 'A network error interrupted loading.'
        case 3: return 'This file is corrupt or uses an encoding the browser cannot decode.'
        case 4: return 'This container or codec is not supported by the browser. Use Download to get the original file.'
        default: return error.message || 'The media could not be played.'
      }
    }

    /** Inline styles: one stylesheet for both viewers, no CSS-module build. */
    var STYLE = {
      root: {
        display: 'flex', flexDirection: 'column', gap: 10, padding: 12,
        minWidth: 0, minHeight: 0, height: '100%', boxSizing: 'border-box',
        color: 'var(--dsw-alias-label-primary, #e6e9f0)',
      },
      stage: {
        position: 'relative', flex: '1 1 auto', minHeight: 0, minWidth: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: '#000', borderRadius: 8, overflow: 'hidden',
      },
      element: {
        width: '100%', height: '100%', display: 'block', background: '#000',
        outline: 'none', objectFit: 'contain',
      },
      audioCard: {
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', gap: 8, padding: 24, textAlign: 'center',
      },
      audioTitle: {
        fontSize: 13, maxWidth: '100%', overflow: 'hidden',
        textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      },
      audioMeta: { fontSize: 11, color: 'var(--dsw-alias-label-secondary, #8b90a0)' },
      bar: {
        flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 8,
        fontSize: 12, minWidth: 0,
      },
      button: {
        flex: 'none', display: 'inline-flex', alignItems: 'center',
        justifyContent: 'center', width: 28, height: 28, padding: 0,
        border: 'none', borderRadius: 6, cursor: 'pointer',
        background: 'transparent', color: 'inherit',
      },
      seek: { flex: '1 1 auto', minWidth: 40, accentColor: 'var(--dsw-alias-link-normal, #4c8dff)', cursor: 'pointer' },
      time: {
        flex: 'none', fontVariantNumeric: 'tabular-nums',
        color: 'var(--dsw-alias-label-secondary, #8b90a0)',
      },
      speed: {
        flex: 'none', border: 'none', borderRadius: 6, padding: '2px 6px',
        background: 'transparent', color: 'var(--dsw-alias-label-secondary, #8b90a0)',
        cursor: 'pointer', fontSize: 12,
      },
      footer: {
        flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 10,
        fontSize: 12, color: 'var(--dsw-alias-label-secondary, #8b90a0)', minWidth: 0,
      },
      name: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      link: { flex: 'none', color: 'var(--dsw-alias-link-normal, #4c8dff)', textDecoration: 'none' },
      notice: {
        position: 'absolute', left: 8, right: 8, bottom: 8, padding: '6px 10px',
        borderRadius: 6, fontSize: 12,
        background: 'var(--dsw-alias-bg-layer-3, rgba(30,30,36,0.9))',
        border: '1px solid var(--dsw-alias-state-error-primary, #f7768e)',
      },
      empty: {
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100%', padding: 16, fontSize: 12, textAlign: 'center',
        color: 'var(--dsw-alias-label-secondary, #8b90a0)',
      },
      // Touch layout: the bar wraps so the seek input gets its own full-width
      // row instead of being squeezed between the clock readouts.
      barCompact: {
        flex: '0 0 auto', display: 'flex', alignItems: 'center',
        flexWrap: 'wrap', gap: 4, fontSize: 12, minWidth: 0,
      },
      seekRowCompact: {
        flex: '1 0 100%', display: 'flex', alignItems: 'center',
        order: 9, paddingBottom: 4,
      },
      // 44px is the smallest comfortably tappable target.
      buttonCompact: {
        flex: 'none', display: 'inline-flex', alignItems: 'center',
        justifyContent: 'center', width: 44, height: 44, padding: 0,
        border: 'none', borderRadius: 8, cursor: 'pointer',
        background: 'transparent', color: 'inherit',
      },
      seekCompact: {
        flex: '1 1 auto', minWidth: 0, height: 28,
        accentColor: 'var(--dsw-alias-link-normal, #4c8dff)', cursor: 'pointer',
      },
      // Transient gesture feedback drawn over the stage.
      gesture: {
        position: 'absolute', display: 'flex', alignItems: 'center', gap: 6,
        padding: '6px 12px', borderRadius: 999, fontSize: 13,
        fontWeight: 500, fontVariantNumeric: 'tabular-nums',
        color: '#fff', background: 'rgba(0, 0, 0, 0.62)',
        backdropFilter: 'blur(4px)', pointerEvents: 'none',
        whiteSpace: 'nowrap',
      },
      gestureSide: {
        position: 'absolute', top: '50%', transform: 'translateY(-50%)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
        padding: '10px 14px', borderRadius: 12, fontSize: 12,
        color: '#fff', background: 'rgba(0, 0, 0, 0.55)',
        pointerEvents: 'none', whiteSpace: 'nowrap',
      },
      // Tap target that covers the stage so a tap anywhere toggles playback.
      surface: {
        position: 'absolute', inset: 0, cursor: 'pointer',
        touchAction: 'none', // keep the browser from panning instead of seeking
      },
    }

    /** Play/pause glyph. */
    function iconPlay(size, paused) {
      return react.createElement('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'currentColor',
        'aria-hidden': true, focusable: 'false',
      }, paused
        ? [react.createElement('path', { key: 'p', d: 'M5 3.2 12.2 8 5 12.8z' })]
        : [
            react.createElement('rect', { key: 'a', x: 4.4, y: 3.2, width: 2.6, height: 9.6, rx: 0.7 }),
            react.createElement('rect', { key: 'b', x: 9, y: 3.2, width: 2.6, height: 9.6, rx: 0.7 }),
          ])
    }

    /**
     * The shared surface: one component for both preview kinds.
     * @param props - `data` is the resolved source (or its failure branch).
     */
    function MediaSurface(props) {
      var data = props.data || {}
      var isAudio = data.kind === 'audio'
      var elementRef = react.useRef(null)
      var stageRef = react.useRef(null)
      var compact = useCompact()

      var pausedState = react.useState(true)
      var paused = pausedState[0], setPaused = pausedState[1]
      var timeState = react.useState(0)
      var time = timeState[0], setTime = timeState[1]
      var durationState = react.useState(0)
      var duration = durationState[0], setDuration = durationState[1]
      var errorState = react.useState(null)
      var error = errorState[0], setError = errorState[1]
      var rateState = react.useState(1)
      var rate = rateState[0], setRate = rateState[1]
      // Gesture feedback: { kind: 'seek'|'volume'|'rate', text, side } or null.
      var hintState = react.useState(null)
      var hint = hintState[0], setHint = hintState[1]

      /**
       * Live gesture state. A ref (not state) because pointermove must not
       * re-render: a re-render mid-drag would rebuild the handlers and could
       * drop pointer capture.
       */
      var gestureRef = react.useRef(null)

      /** Cancel the pending single-tap so a double tap stays a double tap. */
      var tapTimerRef = react.useRef(null)
      /** Timestamp + position of the previous tap, for double-tap detection. */
      var lastTapRef = react.useRef({ at: 0, x: 0, y: 0 })
      /** Clear the pending tap timer on unmount. */
      react.useEffect(function () {
        return function () {
          if (tapTimerRef.current !== null) {
            clearTimeout(tapTimerRef.current)
            tapTimerRef.current = null
          }
        }
      }, [])

      var seekTo = function (next) {
        var element = elementRef.current
        if (!element) return
        // Clamp against the element's own window; assigning an out-of-range
        // currentTime is what silently snaps back.
        var upper = isFinite(element.duration) ? element.duration : 0
        element.currentTime = Math.max(0, Math.min(next, upper))
        setTime(element.currentTime)
      }

      var toggle = function () {
        var element = elementRef.current
        if (!element) return
        if (element.paused) element.play().catch(function (reason) { setError(String(reason && reason.message ? reason.message : reason)) })
        else element.pause()
      }

      var setVolume = function (next) {
        var element = elementRef.current
        if (!element) return
        element.volume = clamp01(next)
        element.muted = element.volume === 0
        return element.volume
      }

      // Wire the element's own events. No polling: the element is the source of
      // truth, so a seek that the element rejects can never desync the bar.
      react.useEffect(function () {
        var element = elementRef.current
        if (!element) return undefined

        var onMeta = function () {
          setDuration(isFinite(element.duration) ? element.duration : 0)
          setError(mediaErrorText(element))
        }
        var onTime = function () { setTime(element.currentTime) }
        var onPlay = function () { setPaused(false) }
        var onPause = function () { setPaused(true) }
        var onEnded = function () { setPaused(true) }
        var onError = function () { setError(mediaErrorText(element)) }
        var onRate = function () { setRate(element.playbackRate) }

        element.addEventListener('loadedmetadata', onMeta)
        element.addEventListener('durationchange', onMeta)
        element.addEventListener('timeupdate', onTime)
        element.addEventListener('seeking', onTime)
        element.addEventListener('seeked', onTime)
        element.addEventListener('play', onPlay)
        element.addEventListener('pause', onPause)
        element.addEventListener('ended', onEnded)
        element.addEventListener('error', onError)
        element.addEventListener('ratechange', onRate)

        return function () {
          element.removeEventListener('loadedmetadata', onMeta)
          element.removeEventListener('durationchange', onMeta)
          element.removeEventListener('timeupdate', onTime)
          element.removeEventListener('seeking', onTime)
          element.removeEventListener('seeked', onTime)
          element.removeEventListener('play', onPlay)
          element.removeEventListener('pause', onPause)
          element.removeEventListener('ended', onEnded)
          element.removeEventListener('error', onError)
          element.removeEventListener('ratechange', onRate)
        }
      }, [data.url])

      /**
       * Pointer-down on the stage: start tracking, arm the long-press timer,
       * and decide nothing until the pointer actually moves past the threshold
       * (a tap and a swipe begin identically).
       */
      var onPointerDown = function (event) {
        var element = elementRef.current
        if (!element) return
        // Only the primary button / first touch drives gestures.
        if (event.button !== undefined && event.button > 0) return

        var drag = {
          id: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          startTime: element.currentTime,
          startVolume: element.muted ? 0 : element.volume,
          startDuration: isFinite(element.duration) ? element.duration : 0,
          axis: null,
          longPressed: false,
          resumeAfterLongPress: false,
          lastTapAt: lastTapRef.current.at,
          lastTapX: lastTapRef.current.x,
          lastTapY: lastTapRef.current.y,
          moved: false,
        }
        gestureRef.current = drag

        try { event.currentTarget.setPointerCapture(event.pointerId) } catch (ignored) { /* older engines */ }

        // Long press: temporary 3x fast-forward, restored on release.
        drag.longPressTimer = setTimeout(function () {
          if (gestureRef.current !== drag || drag.moved) return
          drag.longPressed = true
          drag.resumeAfterLongPress = !element.paused
          drag.savedRate = element.playbackRate
          element.playbackRate = 3
          if (element.paused) element.play().catch(function () { /* autoplay policy */ })
          setHint({ kind: 'rate', text: '3× fast-forward' })
        }, LONG_PRESS_MS)
      }

      /**
       * Pointer-move: the first movement past the threshold locks an axis.
       * Horizontal = seek, vertical = volume. Locking prevents the two from
       * fighting each other on a diagonal swipe.
       */
      var onPointerMove = function (event) {
        var drag = gestureRef.current
        var element = elementRef.current
        if (!drag || !element || drag.id !== event.pointerId) return

        var dx = event.clientX - drag.startX
        var dy = event.clientY - drag.startY

        if (drag.axis === null) {
          if (Math.abs(dx) < AXIS_THRESHOLD && Math.abs(dy) < AXIS_THRESHOLD) return
          drag.moved = true
          // A real drag cancels the long-press arm.
          if (drag.longPressTimer !== undefined && !drag.longPressed) {
            clearTimeout(drag.longPressTimer)
            drag.longPressTimer = undefined
          }
          // While long-press fast-forward is active, movement is ignored.
          if (drag.longPressed) return
          drag.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'
        }

        if (drag.longPressed) return

        // Measure against the stage, not the window: the sidebar is a slice.
        var rect = stageRef.current ? stageRef.current.getBoundingClientRect() : null
        var width = rect && rect.width > 0 ? rect.width : 320
        var height = rect && rect.height > 0 ? rect.height : 180

        if (drag.axis === 'x') {
          if (drag.startDuration <= 0) return
          // A full-width swipe covers SEEK_SWIPE_SPAN seconds, capped to the
          // clip's own length so a short clip stays controllable.
          var span = Math.min(SEEK_SWIPE_SPAN, drag.startDuration)
          var delta = (dx / width) * span
          var target = clamp(drag.startTime + delta, 0, drag.startDuration)
          element.currentTime = target
          setTime(target)
          setHint({
            kind: 'seek',
            text: (delta >= 0 ? '+' : '−') + clockText(Math.abs(target - drag.startTime)) + '  ·  ' + clockText(target),
          })
          return
        }

        // Vertical: full stage height spans the whole 0..1 volume range.
        var volume = clamp01(drag.startVolume - dy / height)
        setVolume(volume)
        setHint({ kind: 'volume', text: Math.round(volume * 100) + '%' })
      }

      /** Pointer-up: resolve tap vs drag, and restore any temporary rate. */
      var onPointerUp = function (event) {
        var drag = gestureRef.current
        var element = elementRef.current
        if (!drag || drag.id !== event.pointerId) return
        gestureRef.current = null

        if (drag.longPressTimer !== undefined) clearTimeout(drag.longPressTimer)

        if (drag.longPressed) {
          // Return to the rate the user had, not to 1x.
          if (element) element.playbackRate = drag.savedRate === undefined ? 1 : drag.savedRate
          if (element && drag.resumeAfterLongPress === false) element.pause()
          setHint(null)
          return
        }

        if (drag.moved) {
          setHint(null)
          return
        }

        // Undecided and unmoved: this is a tap. Delay it so a second tap can
        // still become a double tap (skip forward / back).
        var now = Date.now()
        var rect = stageRef.current ? stageRef.current.getBoundingClientRect() : null
        var isDouble = now - drag.lastTapAt < DOUBLE_TAP_MS
          && Math.abs(event.clientX - drag.lastTapX) < 40
          && Math.abs(event.clientY - drag.lastTapY) < 60

        if (isDouble) {
          if (tapTimerRef.current !== null) {
            clearTimeout(tapTimerRef.current)
            tapTimerRef.current = null
          }
          lastTapRef.current = { at: 0, x: 0, y: 0 }
          if (!element) return
          // Right half = forward, left half = back (the familiar convention).
          var forward = rect ? event.clientX >= rect.left + rect.width / 2 : true
          var next = clamp(element.currentTime + (forward ? SEEK_STEP : -SEEK_STEP), 0, isFinite(element.duration) ? element.duration : 0)
          seekTo(next)
          setHint({ kind: 'seek', text: (forward ? '+ ' : '− ') + SEEK_STEP + 's' })
          setTimeout(function () { setHint(null) }, 600)
          return
        }

        lastTapRef.current = { at: now, x: event.clientX, y: event.clientY }
        tapTimerRef.current = setTimeout(function () {
          tapTimerRef.current = null
          lastTapRef.current = { at: 0, x: 0, y: 0 }
          toggle()
        }, TAP_DELAY_MS)
      }

      /** Pointer cancel: restore state without treating it as a tap. */
      var onPointerCancel = function () {
        var drag = gestureRef.current
        var element = elementRef.current
        gestureRef.current = null
        if (!drag) return
        if (drag.longPressTimer !== undefined) clearTimeout(drag.longPressTimer)
        if (drag.longPressed && element) {
          element.playbackRate = drag.savedRate === undefined ? 1 : drag.savedRate
          if (drag.resumeAfterLongPress === false) element.pause()
        }
        setHint(null)
      }

      if (isAudio === undefined) return null
      if (data.error !== undefined) {
        return react.createElement('div', { style: STYLE.empty }, data.error)
      }

      var cycleRate = function () {
        var element = elementRef.current
        if (!element) return
        var rates = [1, 1.25, 1.5, 2, 0.5, 0.75]
        var index = rates.indexOf(element.playbackRate)
        var next = rates[(index + 1) % rates.length]
        element.playbackRate = next
        setRate(next)
      }

      var downloadHref = data.url
      var kindLabel = isAudio ? 'Audio' : 'Video'

      var mediaElement = react.createElement(isAudio ? 'audio' : 'video', {
        key: 'media',
        ref: elementRef,
        // crossOrigin MUST precede src: the media element starts its first
        // fetch from `src`, and a fetch begun before this attribute is set is
        // `no-cors` — it omits Origin and the host route answers 403.
        crossOrigin: 'anonymous',
        src: data.url,
        preload: 'metadata',
        playsInline: true,
        // No native `controls`: the bar below is the single source of control,
        // and on touch it is what carries the 44px targets. iOS additionally
        // honours playsInline + no controls, which keeps the video in place
        // instead of going fullscreen on play.
        style: isAudio ? { display: 'none' } : STYLE.element,
      })

      // The gesture surface only exists for video: an audio file has no stage
      // to swipe, and stealing its taps would fight the bar. On fine pointers
      // it still provides tap-to-toggle, which is harmless for a mouse.
      var gestureLayer = isAudio
        ? null
        : react.createElement('div', {
            key: 'gesture',
            style: STYLE.surface,
            onPointerDown: onPointerDown,
            onPointerMove: onPointerMove,
            onPointerUp: onPointerUp,
            onPointerCancel: onPointerCancel,
            // Prevent the browser's own pan/zoom so a swipe is not eaten by
            // scrolling on touch devices.
            onContextMenu: function (event) { event.preventDefault() },
            'aria-hidden': true,
          })

      var hintNode = null
      if (hint !== null) {
        hintNode = react.createElement('div', {
          key: 'hint',
          style: Object.assign({}, STYLE.gesture, { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }),
        }, hint.text)
      }

      var stage = react.createElement('div', { key: 'stage', ref: stageRef, style: STYLE.stage }, [
        mediaElement,
        isAudio
          ? react.createElement('div', { key: 'card', style: STYLE.audioCard }, [
              react.createElement('div', { key: 'i', style: { opacity: 0.85 } }, iconAudio(46)),
              react.createElement('div', { key: 'name', style: STYLE.audioTitle, title: data.name }, data.name),
              react.createElement('div', { key: 'meta', style: STYLE.audioMeta }, kindLabel + (data.size > 0 ? ' · ' + sizeText(data.size) : '')),
            ])
          : null,
        gestureLayer,
        hintNode,
        error !== null ? react.createElement('div', { key: 'err', style: STYLE.notice }, error) : null,
      ])

      var barStyle = compact ? STYLE.barCompact : STYLE.bar
      var buttonStyle = compact ? STYLE.buttonCompact : STYLE.button
      var seekStyle = compact ? STYLE.seekCompact : STYLE.seek

      var seekInput = react.createElement('input', {
        key: 'seek',
        type: 'range',
        min: 0,
        max: duration > 0 ? duration : 0,
        step: 0.01,
        value: Math.min(time, duration > 0 ? duration : 0),
        style: seekStyle,
        'aria-label': 'Seek',
        disabled: duration <= 0,
        onChange: function (event) { seekTo(Number(event.target.value)) },
      })

      var barChildren = [
        react.createElement('button', {
          key: 'play',
          type: 'button',
          style: buttonStyle,
          onClick: toggle,
          title: paused ? 'Play' : 'Pause',
          'aria-label': paused ? 'Play' : 'Pause',
        }, iconPlay(compact ? 20 : 16, paused)),
        react.createElement('span', { key: 'cur', style: STYLE.time }, clockText(time)),
        // Compact: the seek bar takes its own row so it is never squeezed
        // between the two clocks.
        compact ? null : seekInput,
        react.createElement('span', { key: 'dur', style: STYLE.time }, clockText(duration)),
        react.createElement('button', {
          key: 'rate',
          type: 'button',
          style: compact ? Object.assign({}, STYLE.buttonCompact, { width: 'auto', padding: '0 10px', fontSize: 13 }) : STYLE.speed,
          onClick: cycleRate,
          title: 'Playback speed',
          'aria-label': 'Playback speed',
        }, rate + '×'),
        compact ? react.createElement('div', { key: 'seekrow', style: STYLE.seekRowCompact }, [seekInput]) : null,
      ]

      var bar = react.createElement('div', { style: barStyle }, barChildren)

      var footer = react.createElement('div', { style: STYLE.footer }, [
        react.createElement('span', { key: 'n', style: STYLE.name, title: data.path }, data.name),
        react.createElement('a', {
          key: 'd',
          style: STYLE.link,
          href: downloadHref,
          download: data.name || true,
          title: 'Download the original file',
        }, 'Download'),
      ])

      return react.createElement('div', { style: STYLE.root }, [stage, bar, footer])
    }

    /** One viewer component: the host hands it the `customData` from load(). */
    function Viewer(props) {
      return react.createElement(MediaSurface, { data: props.customData, title: props.title })
    }

    /**
     * Build one descriptor. Both viewers are constructed from this single
     * factory so their behaviour, priority and loading strategy are identical
     * by construction.
     * @param spec - id, title, icon, exts, order.
     * @returns the descriptor handed to registerFileViewer.
     */
    function descriptor(spec) {
      return {
        id: spec.id,
        title: spec.title,
        icon: spec.icon,
        exts: spec.exts,
        priority: 50,
        fetchStrategy: 'custom',
        load: function (path, scope, signal) {
          return loadMediaSource(path, scope, signal)
        },
        component: Viewer,
      }
    }

    /** Cordis service dependencies: the better-sidebar registry. */
    var inject = ['betterSidebar']

    function apply(ctx) {
      var betterSidebar = ctx.betterSidebar
      if (betterSidebar === undefined) return

      // ctx.effect so the disposer runs on fiber teardown (HMR / disable);
      // without it a re-activation throws "already registered".
      ctx.effect(function () {
        var disposeAudio = betterSidebar.registerFileViewer(descriptor({
          id: AUDIO_VIEWER_ID,
          title: 'Audio preview',
          icon: function (size) { return iconAudio(size) },
          exts: AUDIO_EXTS,
        }))
        var disposeVideo = betterSidebar.registerFileViewer(descriptor({
          id: VIDEO_VIEWER_ID,
          title: 'Video preview',
          icon: function (size) { return iconVideo(size) },
          exts: VIDEO_EXTS,
        }))
        return function () {
          disposeAudio()
          disposeVideo()
        }
      }, 'dsh-media-preview: file viewers')
    }

    module.exports = {
      inject: inject,
      apply: apply,
      AUDIO_VIEWER_ID: AUDIO_VIEWER_ID,
      VIDEO_VIEWER_ID: VIDEO_VIEWER_ID,
      AUDIO_EXTS: AUDIO_EXTS,
      VIDEO_EXTS: VIDEO_EXTS,
      clockText: clockText,
      sizeText: sizeText,
      mediaBase: mediaBase,
    }
    return module.exports
  },
})
