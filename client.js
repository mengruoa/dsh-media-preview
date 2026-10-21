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

    /**
     * Look for a sidecar `.lrc` next to the media file.
     *
     * The host owns the filesystem probe and the LRC parsing; this only asks.
     * A missing sidecar is the ordinary case, so it resolves to null rather
     * than rejecting — the player then renders without a lyric panel.
     * @param path - the media path better-sidebar opened.
     * @param scope - the session scope.
     * @param signal - aborts the probe on unmount.
     * @returns `{ found, lines, meta, name }` or null.
     */
    async function loadLyrics(path, scope, signal) {
      var params = { sessionId: scope.sessionId, path: path, cwd: scope.cwd }
      try {
        var response = await fetch(routeUrl('lyrics', params), {
          signal: signal,
          headers: { accept: 'application/json' },
        })
        if (!response.ok) return null
        var envelope = await response.json().catch(function () { return null })
        if (envelope === null || envelope.ok !== true || !envelope.value || envelope.value.found !== true) return null
        var value = envelope.value
        if (!Array.isArray(value.lines) || value.lines.length === 0) return null
        return {
          name: typeof value.name === 'string' ? value.name : 'lyrics',
          meta: value.meta && typeof value.meta === 'object' ? value.meta : {},
          lines: value.lines
            .filter(function (line) { return line && typeof line.time === 'number' && typeof line.text === 'string' })
            .map(function (line) {
              return {
                time: line.time,
                text: line.text,
                section: typeof line.section === 'string' && line.section !== '' ? line.section : null,
              }
            }),
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return null
        return null
      }
    }

    /**
     * Index of the lyric line in effect at `time`.
     *
     * Binary search: the array is time-sorted, and this runs on every
     * timeupdate, so a linear scan over a long lyric would be wasteful.
     * @param lines - time-sorted lyric lines.
     * @param time - playback position in seconds.
     * @returns the index, or -1 before the first line.
     */
    function lyricIndexAt(lines, time) {
      if (!Array.isArray(lines) || lines.length === 0) return -1
      if (time < lines[0].time) return -1
      var low = 0
      var high = lines.length - 1
      var found = -1
      while (low <= high) {
        var mid = (low + high) >> 1
        if (lines[mid].time <= time) {
          found = mid
          low = mid + 1
        } else {
          high = mid - 1
        }
      }
      return found
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

    /** Playback speed steps the speed button cycles through. */
    var RATES = [1, 1.25, 1.5, 2, 0.5, 0.75]
    /** Volume step for the arrow keys and the mute button's restorer. */
    var VOLUME_STEP = 0.05
    /** Seek step for the arrow keys, in seconds. */
    var KEY_SEEK_STEP = 5
    /** Seek step for Shift+arrow, in seconds. */
    var KEY_SEEK_STEP_LARGE = 30

    /**
     * Live spectrum along the bottom of the audio stage.
     *
     * One spectrum component for audio only: video has a picture to look at and
     * a canvas animating under it would just burn battery.
     *
     * The analyser is fed from a `MediaElementSource`, which REQUIRES the media
     * to be CORS-clean — that is exactly why the client sets
     * `crossOrigin="anonymous"` before `src`. Without it the analyser returns
     * all zeros and this canvas would sit permanently flat.
     *
     * @param props - `element` is the live <audio> node, `playing` gates the
     *   animation loop so a paused player stops repainting.
     */
    function Spectrum(props) {
      var canvasRef = react.useRef(null)
      var wrapRef = react.useRef(null)
      var audioRef = react.useRef(null)
      /** `{ analyser, bins, context }` once Web Audio is wired. */
      var analyserRef = react.useRef(null)
      var playing = props.playing

      // Build the analyser graph once per element. `createMediaElementSource`
      // throws if called twice for one element, so it is memoized here.
      react.useEffect(function () {
        var element = props.element
        if (!element || typeof window === 'undefined') return undefined
        var Ctor = window.AudioContext || window.webkitAudioContext
        if (!Ctor) return undefined

        var context
        try {
          context = new Ctor()
        } catch (error) {
          return undefined
        }

        var analyser
        var bins
        try {
          analyser = context.createAnalyser()
          analyser.fftSize = 512
          analyser.smoothingTimeConstant = 0.75
          var source = context.createMediaElementSource(element)
          source.connect(analyser)
          // Also route to the speakers, or the graph swallows the sound.
          analyser.connect(context.destination)
          bins = new Uint8Array(analyser.frequencyBinCount)
        } catch (error) {
          try { context.close() } catch (ignored) { /* nothing to close */ }
          return undefined
        }

        analyserRef.current = { analyser: analyser, bins: bins, context: context }

        return function () {
          analyserRef.current = null
          try { analyser.disconnect() } catch (ignored) { /* already gone */ }
          try { context.close() } catch (ignored) { /* already closed */ }
        }
      }, [props.element])

      // Browsers start an AudioContext suspended until a gesture; resume on play.
      react.useEffect(function () {
        var state = analyserRef.current
        if (!state || !playing) return
        if (state.context.state === 'suspended') state.context.resume().catch(function () { /* gesture required */ })
      }, [playing])

      // Draw loop. Runs only while playing and on-screen.
      react.useEffect(function () {
        var canvas = canvasRef.current
        if (!canvas || typeof requestAnimationFrame !== 'function') return undefined
        var stopped = false
        var frame = 0

        var draw = function () {
          if (stopped) return
          var state = analyserRef.current
          var rect = canvas.getBoundingClientRect()
          var ratio = Math.min(2, Math.max(1, window.devicePixelRatio || 1))
          var width = Math.max(1, Math.floor(rect.width * ratio))
          var height = Math.max(1, Math.floor(rect.height * ratio))
          if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width
            canvas.height = height
          }
          var ctx = canvas.getContext('2d')
          if (!ctx) return
          ctx.clearRect(0, 0, width, height)

          var BARS = 56
          var gap = Math.max(1, Math.round(ratio))
          var barWidth = Math.max(1, (width - gap * (BARS - 1)) / BARS)

          // Sample only the lower half of the spectrum: music energy lives
          // there, and the top bins of a 256-bin FFT are almost always empty.
          var bins = state ? state.bins : null
          if (state) state.analyser.getByteFrequencyData(bins)
          var usable = bins ? Math.floor(bins.length * 0.55) : 0

          for (var i = 0; i < BARS; i += 1) {
            var value = 0
            if (bins && usable > 0) {
              // Average the bins that fall into this bar for a stable shape.
              var from = Math.floor((i / BARS) * usable)
              var to = Math.max(from + 1, Math.floor(((i + 1) / BARS) * usable))
              var sum = 0
              for (var b = from; b < to; b += 1) sum += bins[b]
              value = sum / (to - from) / 255
            }
            // A little floor so a silent passage still shows a baseline.
            var level = Math.max(0.02, value)
            var barHeight = Math.max(barWidth, level * height * 0.92)
            var x = i * (barWidth + gap)
            var y = height - barHeight
            var gradient = ctx.createLinearGradient(0, height, 0, y)
            gradient.addColorStop(0, 'rgba(120,170,255,0.95)')
            gradient.addColorStop(0.55, 'rgba(160,140,255,0.85)')
            gradient.addColorStop(1, 'rgba(255,150,220,0.75)')
            ctx.fillStyle = gradient
            var radius = Math.min(barWidth / 2, 3 * ratio)
            if (typeof ctx.roundRect === 'function') {
              ctx.beginPath()
              ctx.roundRect(x, y, barWidth, barHeight, radius)
              ctx.fill()
            } else {
              ctx.fillRect(x, y, barWidth, barHeight)
            }
          }

          frame = requestAnimationFrame(draw)
        }

        frame = requestAnimationFrame(draw)
        return function () {
          stopped = true
          cancelAnimationFrame(frame)
        }
      }, [playing])

      return react.createElement('div', { ref: wrapRef, style: STYLE.spectrum },
        react.createElement('canvas', {
          ref: canvasRef,
          style: { display: 'block', width: '100%', height: '100%' },
          'aria-hidden': true,
        }))
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
      /**
       * Frosted-glass backdrop for the audio stage.
       *
       * `backdropFilter` samples whatever renders BEHIND this element, so the
       * colour wash and the blurred artwork are separate layers: the wash paints
       * the tint, and `backdrop-blur` applied to the stage blurs the cover art
       * we deliberately over-scale underneath it. Overscaling is what stops the
       * blur from pulling in transparent edges and producing a grey halo.
       */
      audioStage: {
        position: 'relative', flex: '1 1 auto', minHeight: 140, minWidth: 0,
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        gap: 10, overflow: 'hidden', borderRadius: 10,
        // Fallbacks first: a skin may not define the glass aliases.
        background: 'var(--dsw-alias-bg-layer-1, rgba(255,255,255,0.06))',
        border: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.10))',
        isolation: 'isolate',
      },
      /** The blurred colour wash behind the glass. */
      glassWash: {
        position: 'absolute', inset: '-24%', zIndex: 0,
        background: 'radial-gradient(60% 60% at 30% 25%, rgba(96,140,255,0.42), transparent 70%), radial-gradient(55% 55% at 75% 70%, rgba(255,120,190,0.34), transparent 70%), radial-gradient(50% 50% at 50% 100%, rgba(120,255,215,0.22), transparent 72%)',
        filter: 'blur(28px) saturate(150%)',
        transform: 'scale(1.15)',
        opacity: 0.9,
        pointerEvents: 'none',
      },
      /** Content layer above the wash. */
      glassContent: {
        position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 8,
        padding: '18px 24px 6px', textAlign: 'center', minHeight: 0,
        maxWidth: '100%',
      },
      audioTitle: {
        fontSize: 15, fontWeight: 500, maxWidth: '100%', overflow: 'hidden',
        textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        textShadow: '0 1px 8px rgba(0,0,0,0.35)',
      },
      audioMeta: {
        fontSize: 11, color: 'var(--dsw-alias-label-secondary, rgba(230,233,240,0.72))',
      },
      /** The always-moving spectrum along the bottom of the audio stage. */
      spectrum: {
        position: 'relative', zIndex: 1, flex: '0 0 auto',
        width: '100%', height: 64, display: 'block',
        pointerEvents: 'none', opacity: 0.95,
      },
      /** Lyric panel: scrolls, one highlighted line at a time. */
      lyrics: {
        position: 'relative', zIndex: 1,
        flex: '1 1 auto', minHeight: 0, width: '100%',
        display: 'flex', flexDirection: 'column', gap: 6,
        overflowY: 'auto', overflowX: 'hidden',
        padding: '6px 16px 10px',
        maskImage: 'linear-gradient(to bottom, transparent, #000 12%, #000 88%, transparent)',
        WebkitMaskImage: 'linear-gradient(to bottom, transparent, #000 12%, #000 88%, transparent)',
        scrollbarWidth: 'thin',
      },
      lyricLine: {
        flex: '0 0 auto', fontSize: 13, lineHeight: '20px',
        color: 'var(--dsw-alias-label-secondary, rgba(230,233,240,0.55))',
        textAlign: 'center', overflowWrap: 'anywhere',
        transition: 'color 220ms ease, transform 220ms ease, opacity 220ms ease',
        opacity: 0.8, cursor: 'pointer',
        textShadow: '0 1px 6px rgba(0,0,0,0.3)',
      },
      lyricLineActive: {
        flex: '0 0 auto', fontSize: 14, lineHeight: '21px', fontWeight: 600,
        color: 'var(--dsw-alias-label-primary, #ffffff)',
        textAlign: 'center', overflowWrap: 'anywhere',
        transition: 'color 220ms ease, transform 220ms ease, opacity 220ms ease',
        opacity: 1, cursor: 'pointer', transform: 'scale(1.03)',
        textShadow: '0 1px 10px rgba(0,0,0,0.5)',
      },
      lyricSection: {
        flex: '0 0 auto', fontSize: 10, letterSpacing: '0.08em',
        textTransform: 'uppercase', textAlign: 'center',
        color: 'var(--dsw-alias-label-secondary, rgba(230,233,240,0.45))',
        paddingTop: 4,
      },
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
      // Volume slider: narrower than the seek bar, so the transport keeps the
      // flexible width on a small window.
      volume: {
        flex: '0 1 84px', minWidth: 48, maxWidth: 96, height: 18,
        accentColor: 'var(--dsw-alias-link-normal, #4c8dff)', cursor: 'pointer',
      },
      volumeCompact: {
        flex: '0 1 64px', minWidth: 44, height: 24,
        accentColor: 'var(--dsw-alias-link-normal, #4c8dff)', cursor: 'pointer',
      },
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
     * Speaker glyph reflecting the current volume.
     * @param size - pixel size.
     * @param volume - 0..1 effective volume (0 when muted).
     * @returns the icon node.
     */
    function iconVolume(size, volume) {
      var waves = []
      if (volume > 0.02) {
        waves.push(react.createElement('path', {
          key: 'w1', d: 'M9.8 5.6a3.2 3.2 0 0 1 0 4.8',
          stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round',
        }))
      }
      if (volume > 0.55) {
        waves.push(react.createElement('path', {
          key: 'w2', d: 'M11.7 3.7a5.9 5.9 0 0 1 0 8.6',
          stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round',
        }))
      }
      var parts = [
        react.createElement('path', {
          key: 'body', d: 'M8 2.6 5.1 5H3.1v6h2L8 13.4z',
          fill: 'currentColor',
        }),
      ]
      if (volume <= 0.02) {
        parts.push(react.createElement('path', {
          key: 'mute', d: 'M10.6 6.1l3 3m0-3-3 3',
          stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round',
        }))
      }
      return react.createElement('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        'aria-hidden': true, focusable: 'false',
      }, parts.concat(waves))
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
      // Volume is mirrored in React state so the slider and the speaker glyph
      // re-render; the element stays authoritative and these follow its events.
      var volumeState = react.useState(1)
      var volume = volumeState[0], setVolumeState = volumeState[1]
      var mutedState = react.useState(false)
      var muted = mutedState[0], setMutedState = mutedState[1]
      /** Volume restored when unmuting (0 would make the button a dead end). */
      var restoreVolumeRef = react.useRef(1)
      // Gesture feedback: { kind: 'seek'|'volume'|'rate', text, side } or null.
      var hintState = react.useState(null)
      var hint = hintState[0], setHint = hintState[1]
      // Sidecar lyrics, for audio only. `null` = none found (no panel).
      var lyricsState = react.useState(null)
      var lyrics = lyricsState[0], setLyrics = lyricsState[1]
      /** Scroll container for the lyric panel (kept in view as time advances). */
      var lyricsRef = react.useRef(null)

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

      /**
       * Load the sidecar lyrics once per file.
       *
       * The probe runs for audio only: a video with a matching .lrc is a
       * karaoke file, which this player does not render, so asking would waste a
       * request on every video open.
       */
      react.useEffect(function () {
        if (!isAudio) return undefined
        var cancelled = false
        var controller = typeof AbortController === 'function' ? new AbortController() : undefined
        setLyrics(null)
        loadLyrics(data.path, props.scope || {}, controller ? controller.signal : undefined).then(function (found) {
          if (cancelled) return
          setLyrics(found)
        })
        return function () {
          cancelled = true
          if (controller) controller.abort()
        }
      }, [data.path, isAudio])

      /**
       * Keep the active lyric line in view.
       *
       * Scrolls the CONTAINER rather than calling `scrollIntoView`, which walks
       * up and would move the app's own scrollers — a known way to shift the
       * whole sidebar — so the offset maths stays local to the panel.
       */
      react.useEffect(function () {
        var container = lyricsRef.current
        if (!container || lyrics === null) return
        var index = lyricIndexAt(lyrics.lines, time)
        if (index < 0) return
        var current = lyrics.lines[index]
        var target
        for (var i = 0; i < container.children.length; i += 1) {
          if (container.children[i].textContent === current.text) { target = container.children[i]; break }
        }
        if (target === undefined) return
        var top = target.offsetTop - container.clientHeight / 2 + target.clientHeight / 2
        container.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
      }, [time, lyrics])

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
        var value = clamp01(next)
        element.volume = value
        // Dragging the slider up from zero should un-mute, not stay silent.
        element.muted = value === 0
        if (value > 0) restoreVolumeRef.current = value
        setVolumeState(element.volume)
        setMutedState(element.muted)
        return element.volume
      }

      /**
       * Toggle mute, remembering the last audible level so unmuting restores it
       * rather than leaving the player silent at 0.
       */
      var toggleMute = function () {
        var element = elementRef.current
        if (!element) return
        if (element.muted || element.volume === 0) {
          element.muted = false
          if (element.volume === 0) element.volume = restoreVolumeRef.current > 0 ? restoreVolumeRef.current : 1
        } else {
          restoreVolumeRef.current = element.volume
          element.muted = true
        }
        setVolumeState(element.volume)
        setMutedState(element.muted)
        setHint({ kind: 'volume', text: element.muted ? 'Muted' : Math.round(element.volume * 100) + '%' })
        setTimeout(function () { setHint(null) }, 700)
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
        var onVolume = function () {
          setVolumeState(element.volume)
          setMutedState(element.muted)
          if (element.volume > 0 && !element.muted) restoreVolumeRef.current = element.volume
        }

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
        element.addEventListener('volumechange', onVolume)

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
          element.removeEventListener('volumechange', onVolume)
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
        var index = RATES.indexOf(element.playbackRate)
        var next = RATES[(index + 1) % RATES.length]
        element.playbackRate = next
        setRate(next)
      }

      /**
       * Keyboard transport, bound on the player root so it only fires while the
       * player (not the chat composer) has focus.
       *
       * Keys follow the conventions of desktop video players: Space/K play,
       * J/L skip, arrows seek and set volume, M mute, F fullscreen, 0-9 jump to
       * a percentage. Modified keystrokes are never hijacked, so browser and
       * app shortcuts still work.
       */
      var onKeyDown = function (event) {
        var element = elementRef.current
        if (!element) return
        // Leave OS/app shortcuts (Ctrl+R, Alt+Tab, Cmd+K…) alone.
        if (event.ctrlKey || event.metaKey || event.altKey) return
        // A focused slider or button handles its own keys (arrow keys move a
        // range input natively).
        var tag = event.target && event.target.tagName ? String(event.target.tagName).toLowerCase() : ''
        var type = event.target && event.target.type ? String(event.target.type).toLowerCase() : ''
        if (type === 'range') return

        var key = event.key
        var handled = true

        switch (key) {
          case ' ':
          case 'Spacebar':
          case 'k':
          case 'K':
            toggle()
            break
          case 'ArrowLeft':
            seekTo(element.currentTime - (event.shiftKey ? KEY_SEEK_STEP_LARGE : KEY_SEEK_STEP))
            break
          case 'ArrowRight':
            seekTo(element.currentTime + (event.shiftKey ? KEY_SEEK_STEP_LARGE : KEY_SEEK_STEP))
            break
          case 'ArrowUp':
            setVolume((element.muted ? 0 : element.volume) + VOLUME_STEP)
            setMutedState(element.muted)
            setHint({ kind: 'volume', text: Math.round(element.volume * 100) + '%' })
            setTimeout(function () { setHint(null) }, 700)
            break
          case 'ArrowDown':
            setVolume((element.muted ? 0 : element.volume) - VOLUME_STEP)
            setMutedState(element.muted)
            setHint({ kind: 'volume', text: element.volume === 0 ? 'Muted' : Math.round(element.volume * 100) + '%' })
            setTimeout(function () { setHint(null) }, 700)
            break
          case 'm':
          case 'M':
            toggleMute()
            break
          case 'j':
          case 'J':
            seekTo(element.currentTime - KEY_SEEK_STEP_LARGE)
            break
          case 'l':
          case 'L':
            seekTo(element.currentTime + KEY_SEEK_STEP_LARGE)
            break
          case 'Home':
            seekTo(0)
            break
          case 'End':
            seekTo(isFinite(element.duration) ? element.duration : element.currentTime)
            break
          case 'f':
          case 'F': {
            var stageNode = stageRef.current
            if (!stageNode) { handled = false; break }
            var doc = stageNode.ownerDocument
            if (doc && doc.fullscreenElement) doc.exitFullscreen().catch(function () {})
            else if (stageNode.requestFullscreen) stageNode.requestFullscreen().catch(function () {})
            break
          }
          case '.':
          case '>':
            // Step one frame back; browsers have no frame API, so use ~24fps.
            seekTo(element.currentTime + 1 / 24)
            break
          case ',':
          case '<':
            seekTo(element.currentTime - 1 / 24)
            break
          default:
            handled = false
        }

        // Digits jump to a percentage of the clip (0..9 -> 0%..90%).
        if (!handled && key.length === 1 && key >= '0' && key <= '9' && isFinite(element.duration) && element.duration > 0) {
          seekTo((Number(key) / 10) * element.duration)
          handled = true
        }

        if (handled) {
          // Keep the page from scrolling on Space/arrows.
          event.preventDefault()
          event.stopPropagation()
        }
        void tag
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
        // `display: none` would stop the media element from being a real audio
        // sink in some engines and leaves the analyser flat; a zero-sized but
        // laid-out box keeps playback and the Web Audio graph intact.
        style: isAudio
          ? { position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none', left: -9999 }
          : STYLE.element,
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

      // ── audio stage: frosted glass + spectrum + lyrics ───────────────────
      var lyricIndex = lyrics === null ? -1 : lyricIndexAt(lyrics.lines, time)

      /** One lyric row; clicking it seeks to that line. */
      var lyricRow = function (line, index) {
        var active = index === lyricIndex
        return react.createElement('div', {
          key: 'lyric-' + index,
          style: active ? STYLE.lyricLineActive : STYLE.lyricLine,
          onClick: function () { seekTo(line.time) },
          title: 'Jump to ' + clockText(line.time),
        }, line.text)
      }

      var lyricsPanel = null
      if (lyrics !== null) {
        var rows = []
        var lastSection = null
        for (var li = 0; li < lyrics.lines.length; li += 1) {
          var line = lyrics.lines[li]
          // Section headers appear once, above the first line that names them.
          if (line.section !== null && line.section !== lastSection) {
            rows.push(react.createElement('div', { key: 'sec-' + li, style: STYLE.lyricSection }, line.section))
            lastSection = line.section
          }
          rows.push(lyricRow(line, li))
        }
        lyricsPanel = react.createElement('div', {
          key: 'lyrics',
          ref: lyricsRef,
          style: STYLE.lyrics,
          'aria-label': 'Lyrics',
        }, rows)
      }

      var spectrumPanel = isAudio
        ? react.createElement(Spectrum, { key: 'spectrum', element: elementRef.current, playing: !paused })
        : null

      var audioStage = isAudio
        ? react.createElement('div', { key: 'stage', ref: stageRef, style: STYLE.audioStage }, [
            // The <audio> element must live inside this subtree: Spectrum reads
            // it to build the analyser graph, and it stays mounted (hidden) so
            // the graph survives re-renders.
            mediaElement,
            react.createElement('div', { key: 'wash', style: STYLE.glassWash }),
            react.createElement('div', { key: 'card', style: STYLE.glassContent }, [
              react.createElement('div', { key: 'i', style: { opacity: 0.9 } }, iconAudio(40)),
              react.createElement('div', { key: 'name', style: STYLE.audioTitle, title: data.name }, data.name),
              react.createElement('div', { key: 'meta', style: STYLE.audioMeta }, kindLabel + (data.size > 0 ? ' · ' + sizeText(data.size) : '') + (lyrics !== null ? ' · ' + lyrics.lines.length + ' 行歌词' : '')),
            ]),
            lyricsPanel,
            spectrumPanel,
            hintNode,
            error !== null ? react.createElement('div', { key: 'err', style: STYLE.notice }, error) : null,
          ])
        : null

      var stage = isAudio
        ? audioStage
        : react.createElement('div', { key: 'stage', ref: stageRef, style: STYLE.stage }, [
            mediaElement,
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

      var volumeEffective = muted ? 0 : volume

      var volumeButton = react.createElement('button', {
        key: 'mute',
        type: 'button',
        style: compact
          ? Object.assign({}, STYLE.buttonCompact, { width: 36 })
          : Object.assign({}, STYLE.button, { width: 24 }),
        onClick: toggleMute,
        title: muted || volume === 0 ? 'Unmute (M)' : 'Mute (M)',
        'aria-label': muted || volume === 0 ? 'Unmute' : 'Mute',
      }, iconVolume(compact ? 20 : 16, volumeEffective))

      var volumeSlider = react.createElement('input', {
        key: 'volume',
        type: 'range',
        min: 0,
        max: 1,
        step: 0.01,
        // Show the muted state as an empty slider, matching the glyph.
        value: volumeEffective,
        style: compact ? STYLE.volumeCompact : STYLE.volume,
        'aria-label': 'Volume',
        title: 'Volume (↑ / ↓)',
        onChange: function (event) {
          var next = Number(event.target.value)
          var element = elementRef.current
          if (element && element.muted) element.muted = false
          setVolume(next)
        },
      })

      var barChildren = [
        react.createElement('button', {
          key: 'play',
          type: 'button',
          style: buttonStyle,
          onClick: toggle,
          title: paused ? 'Play (Space)' : 'Pause (Space)',
          'aria-label': paused ? 'Play' : 'Pause',
        }, iconPlay(compact ? 20 : 16, paused)),
        react.createElement('span', { key: 'cur', style: STYLE.time }, clockText(time)),
        // Compact: the seek bar takes its own row so it is never squeezed
        // between the two clocks.
        compact ? null : seekInput,
        react.createElement('span', { key: 'dur', style: STYLE.time }, clockText(duration)),
        // Volume: keyed controls for mouse/keyboard. On touch the stage swipe
        // already owns volume, so compact mode keeps the mute button but drops
        // the slider to save a row.
        volumeButton,
        compact ? null : volumeSlider,
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

      // tabIndex so the player can take focus and receive keys without the
      // chat composer competing for them; the outline is suppressed because the
      // stage already reads as the interactive surface.
      return react.createElement('div', {
        style: Object.assign({}, STYLE.root, { outline: 'none' }),
        tabIndex: 0,
        onKeyDown: onKeyDown,
        'aria-label': data.name,
      }, [stage, bar, footer])
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
