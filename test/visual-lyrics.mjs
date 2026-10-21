/**
 * Visual proof for word-level highlighting.
 *
 * Renders the shipped client bundle in a real Chromium (via CDP) with an
 * injected lyric payload and a fixed playback position, then reports what the
 * DOM actually says: how many word spans the active line produced, which are
 * marked sung, and the computed colour/opacity of each. Also screenshots the
 * panel so the result can be looked at rather than argued about.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const bundle = readFileSync(join(here, '..', 'client.js'), 'utf8')

const CDP_PORT = Number(process.argv[2] ?? 9336)
const SHOT = process.argv[3] ?? join(here, 'lyrics-shot.png')

/** Lyric fixture: the real shape from 晚风信.lrc. */
const LINES = [
  { time: 16.28, text: '路灯把影子拉得很长', section: null, words: [
    { time: 16.28, text: '路' }, { time: 16.68, text: '灯' }, { time: 17.15, text: '把' },
    { time: 17.55, text: '影' }, { time: 18.03, text: '子' }, { time: 18.35, text: '拉' },
    { time: 18.91, text: '得' }, { time: 19.31, text: '很' }, { time: 19.79, text: '长' },
  ] },
  { time: 23.22, text: '便利店的灯还亮着', section: null, words: [
    { time: 23.22, text: '便' }, { time: 23.46, text: '利' }, { time: 23.70, text: '店' },
    { time: 24.10, text: '的' }, { time: 24.41, text: '灯' }, { time: 25.85, text: '还' },
    { time: 26.33, text: '亮' }, { time: 26.73, text: '着' },
  ] },
  { time: 30.24, text: '我把没说完的那句话', section: null, words: [
    { time: 30.24, text: '我' }, { time: 30.40, text: '把' }, { time: 30.64, text: '没' },
    { time: 31.04, text: '说' }, { time: 31.52, text: '完' }, { time: 31.91, text: '的' },
    { time: 32.23, text: '那' }, { time: 32.63, text: '句' }, { time: 33.03, text: '话' },
  ] },
]

const page = `<!doctype html><meta charset="utf-8">
<style>
  html,body{margin:0;height:100%;background:#14161c;font-family:system-ui,sans-serif}
  #host{width:420px;height:520px;display:flex}
</style>
<body><div id="host"></div>
<script>
window.__ModuleLoader__ = { load(reg){ window.__reg = reg } }
window.__LYRICS__ = ${JSON.stringify(LINES)}
window.__TIME__ = ${Number(process.argv[4] ?? 18.4)}
</script>
<script>${bundle.replace(/<\/script>/g, '<\\/script>')}</script>
<script>
// Minimal React with hooks, enough to mount the real viewer.
(function(){
  var hooks=[], cursor=0, dirty=false
  function h(type, props){
    var kids = Array.prototype.slice.call(arguments, 2)
    var flat=[]
    ;(function push(v){ if(v==null||v===false) return; if(Array.isArray(v)){v.forEach(push);return} flat.push(v) })(kids.length===1?kids[0]:kids)
    return { t:type, p:Object.assign({}, props||{}, {children: flat.length<=1?flat[0]:flat}), k:true }
  }
  var React = {
    createElement: h,
    Fragment: 'Fragment',
    useState: function(init){
      var i=cursor++
      if(hooks[i]===undefined) hooks[i]={v: typeof init==='function'?init():init}
      return [hooks[i].v, function(next){ var val=typeof next==='function'?next(hooks[i].v):next; if(!Object.is(val,hooks[i].v)){hooks[i].v=val;dirty=true} }]
    },
    useRef: function(init){ var i=cursor++; if(hooks[i]===undefined) hooks[i]={current:init}; return hooks[i] },
    useEffect: function(){ cursor++ },
    useMemo: function(fn){ return fn() },
    useCallback: function(fn){ return fn },
  }
  // Real audio element so refs work; it never plays.
  var audio = document.createElement('audio')
  audio.crossOrigin='anonymous'

  var expand=function(node, depth){
    if(!node||typeof node!=='object'||!node.k) return node
    if(typeof node.t==='function'){
      if(node.t.name==='Spectrum') return {t:'div',p:{children:[]},k:true}
      return expand(node.t(node.p), depth+1)
    }
    if(node.t==='audio'||node.t==='video'){ if(node.p.ref&&node.p.ref.current===null) node.p.ref.current=audio }
    var c=node.p.children
    var list=Array.isArray(c)?c:(c===undefined?[]:[c])
    if(list.length===0) return node
    var out=list.map(function(x){ return expand(x, depth+1) })
    return {t:node.t, p:Object.assign({},node.p,{children: out.length===1?out[0]:out}), k:true}
  }

  var reg = window.__reg
  var exportsObj = reg.factory(function(spec){
    if(spec==='react') return React
    throw new Error('unexpected require '+spec)
  })
  var descriptor=null
  exportsObj.apply({
    betterSidebar:{ registerFileViewer:function(d){ if(String(d.id).indexOf('audio')>=0) descriptor=d; return function(){} } },
    effect:function(fn){ fn() },
  })
  var props={ customData:{kind:'audio',url:'',name:'晚风信.mp3',path:'/晚风信.mp3',size:4469334}, title:'晚风信', scope:{sessionId:'s',cwd:'/'} }

  function render(){
    cursor=0; dirty=false
    var tree = expand(descriptor.component(props), 0)
    // pin lyrics + time
    var t=window.__TIME__
    hooks.forEach(function(slot){
      if(slot && slot.v===null) slot.v={name:'x.lrc', meta:{}, lines:window.__LYRICS__}
      if(slot && slot.v===0) slot.v=t
    })
    cursor=0
    return expand(descriptor.component(props), 0)
  }
  var tree=render()

  // Convert the element tree to DOM.
  function mount(node){
    if(node==null||node===false) return document.createTextNode('')
    if(typeof node==='string'||typeof node==='number') return document.createTextNode(String(node))
    if(Array.isArray(node)){ var f=document.createDocumentFragment(); node.forEach(function(n){f.appendChild(mount(n))}); return f }
    if(!node.k) return document.createTextNode(String(node))
    var el=document.createElement(node.t)
    var p=node.p||{}
    for(var key in p){
      if(key==='children'||key==='ref') continue
      var val=p[key]
      if(key==='style'&&val&&typeof val==='object'){ for(var s in val){ try{ el.style[s]=val[s] }catch(e){} } continue }
      if(key.indexOf('on')===0&&typeof val==='function'){ el.addEventListener(key.slice(2).toLowerCase(), val); continue }
      if(key==='data-word'||key==='data-sung'||key==='data-lyric'||key==='aria-label'||key==='title'||key==='type'||key==='min'||key==='max'||key==='step'||key==='value'){ try{ el.setAttribute(key,val) }catch(e){} continue }
    }
    var kids=p.children
    var list=Array.isArray(kids)?kids:(kids===undefined?[]:[kids])
    list.forEach(function(k){ el.appendChild(mount(k)) })
    return el
  }
  var root=document.getElementById('host')
  root.appendChild(mount(tree))
  window.__ready=true
})()
</script></body>`

const version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json()

class Conn {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.id = 0
    this.pending = new Map()
    this.ready = new Promise((res, rej) => {
      this.ws.addEventListener('open', () => res())
      this.ws.addEventListener('error', () => rej(new Error('ws error')))
    })
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(JSON.stringify(msg.error)))
        else resolve(msg.result)
      }
    })
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const browser = new Conn(version.webSocketDebuggerUrl)
await browser.ready
const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true })
const send = (m, p = {}) => browser.send(m, p, sessionId)

await send('Runtime.enable')
await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 440, height: 540, deviceScaleFactor: 2, mobile: false })

writeFileSync(join(here, '_preview.html'), page, 'utf8')
await send('Page.navigate', { url: 'file:///' + join(here, '_preview.html').replace(/\\/g, '/') })
await sleep(2500)

const evaluate = async (expression) => {
  const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (exceptionDetails) throw new Error(exceptionDetails.text + ' ' + (exceptionDetails.exception?.description ?? ''))
  return result.value
}

const report = await evaluate(`(() => {
  const words = Array.from(document.querySelectorAll('[data-word]'))
  const lines = Array.from(document.querySelectorAll('[data-lyric]'))
  const active = document.querySelector('[data-lyric]')
  return {
    ready: !!window.__ready,
    wordSpans: words.length,
    lyricRows: lines.length,
    words: words.map(w => ({
      text: w.textContent,
      sung: w.getAttribute('data-sung'),
      color: getComputedStyle(w).color,
      opacity: getComputedStyle(w).opacity,
      glow: getComputedStyle(w).textShadow,
    })),
    pads: document.querySelectorAll('[aria-hidden="true"]').length,
  }
})()`)

console.log(JSON.stringify(report, null, 2))

const shot = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(SHOT, Buffer.from(shot.data, 'base64'))
console.log('\nscreenshot:', SHOT)

await browser.send('Target.closeTarget', { targetId })
process.exit(0)
