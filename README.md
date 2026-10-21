# dsh-media-preview

音视频预览插件，**一个插件、两个查看器、一套实现**。为 [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) 提供音频和视频文件预览，重点解决一个容易踩的坑：**在 Electron 桌面端里进度条拖不动**。

> Audio + video preview for dsh-better-sidebar. Two viewers, one implementation, over a single Range route.

## 为什么会有这个插件

已有插件组合能装上、能出声、能出画面，但**进度条拖不动**。追下来是三个沉默失败叠在一起，每一个单独看都像"没反应"：

### 1. 插件永远停在 pending，路由从未注册

旧写法声明 `inject: ['webServer', 'sessions', 'webRuntime']`。内核后来不再提供 `webRuntime`，而 Cordis 对"注入了不存在的服务"的处理是**永久 pending、不报错**。于是 `apply` 从不执行，HTTP 路由从不注册，请求落到 SPA 静态兜底。

表现不是报错，是一个死链接。装几次都一样。

**本插件的做法**：`inject` 只写内核真正提供的服务（`webServer`、`sessions`），受信列表通过 `ctx.get('connection')?.trustedHosts` 且允许缺失。

### 2. 桌面壳删掉 `Content-Length`，媒体被当成未知长度的流

Electron 壳的 `forwardWebRequest` 转发每个响应时会删除 `content-length`（它在 `WITHHELD_RESPONSE_HEADERS` 里），并把 body 重新包成 `ReadableStream`。

不带长度的媒体响应，Chromium 判定为未知长度的实时流，`seekable` 退化成 `[0, 0]`：能播、能缓冲、进度条一拖就弹回。

实测（同一份字节）：

| 响应形态 | `seekable` | 拖动 60% |
|---|---|---|
| `200` + `Content-Length` | `[0, 88.87]` | ✅ |
| `200` 无 `Content-Length` | `[0, 0]` | ❌ 弹回 0 |
| `206` + `Content-Range` | `[0, 88.87]` | ✅ |

**本插件的做法**：对**任何**请求都答 `206` + `Content-Range`（没有 `Range` 时按整段 `0..size-1`）。`Content-Range` 自带总长度，所以壳层怎么处理 `Content-Length` 都不影响拖动。

### 3. 跨源之后 `no-cors` 不带 `Origin`，被信任栅栏拒绝

把媒体指向真实 Host 源（绕开第 2 条的转发）之后，请求变成跨源。但媒体元素**默认 `no-cors`，请求里没有 `Origin` 头**，栅栏的放行判断匹配不上，直接 403。

**本插件的做法**：
- 客户端解析媒体地址时优先用 `__DSH_TRANSPORT__.streamBaseUrl`（壳层公开的真实 Host 源），普通 http 页面保持相对路径（这样反向代理子目录仍然有效）；
- 媒体元素设置 `crossOrigin="anonymous"`，**且必须在 `src` 之前**，否则首次抓取仍以 `no-cors` 开始；
- 宿主路由放行 `dsh-app://app` 来源（含 `Sec-Fetch-Site: cross-site`），并回 CORS。

对音频还有额外一层必要性：非 CORS 的跨源媒体喂给 Web Audio，analyser 会拿到**全零数据**，频谱会直接变空。

## 功能

- **两个查看器，一套代码**：`media-preview:audio` 与 `media-preview:video` 由同一个工厂函数构造，共用同一个 `<MediaSurface>` 组件和同一条时间轴控制条。两者行为不可能漂移，因为它们是同一条代码路径、只换了元素标签。
- **共用一条 Range 路由**：`/media-preview/meta`（JSON 探针）+ `/media-preview/media`（字节，支持 `Range`）。
- **可拖动的进度条**：点击/拖动定位、当前时间与总时长、倍速循环（1× → 1.25× → 1.5× → 2× → 0.5× → 0.75×）。
- **音频**：隐藏原生控件，改用统一的卡片 + 控制条，视觉与视频一致。
- **视频**：内联 `<video>`，`object-fit: contain`，`preload="metadata"`。
- **失败可读**：解码失败时给出明确文案（区分"格式不支持"与"网络错误"），并保留「Download」取回原文件。
- **无外部依赖**：客户端 bundle 只 `require('react')`，宿主半零依赖。

## 移动端与触屏手势

播放器不使用原生 `controls`，控制条是自绘的，因此在触屏上可以给足点击尺寸并接管全部手势。

**触屏布局**（`(pointer: coarse), (max-width: 520px)` 命中时自动启用）：播放按钮和倍速按钮放大到 44×44，进度条改为独占一整行——避免在窄屏里被两侧时间读数挤成一条缝。按指针类型而不是窗口宽度判断，所以窄窗口的桌面端仍然得到紧凑布局，而横屏平板虽然宽也仍然得到大按钮。

| 手势 | 行为 |
|---|---|
| **单击** | 播放 / 暂停（延迟 250ms 执行，让双击有机会后来居上） |
| **双击左半** | 后退 10 秒 |
| **双击右半** | 前进 10 秒 |
| **水平滑动** | 快进 / 快退，整屏宽约等于 90 秒（短片段自动按总时长收缩），实时显示 `+12s · 1:34` |
| **垂直滑动** | 调节音量，整屏高覆盖 0–100%，实时显示百分比 |
| **长按 0.5 秒** | 临时 3× 快进，松手恢复到**原来的**倍速（不是固定 1×） |

设计上的几个细节：

- **轴锁定**：手指移动超过 10px 后只认一个方向，避免斜着滑时进度和音量一起乱跳。
- **手势状态用 ref 而非 state**：`pointermove` 期间不触发重渲染，否则中途重建处理器会丢掉 pointer capture。
- **视觉反馈**：滑动时舞台中央浮出半透明胶囊显示目标时间或音量，松手即消失。
- **`touch-action: none`**：手势层阻止浏览器把滑动当成页面滚动吃掉。
- **音频不接管手势**：音频没有"舞台"可滑，抢它的点击只会和下方控制条打架。

## 键鼠模式

桌面端（或 Surface 插上键盘时）用的是密集布局：进度条占满剩余宽度，音量滑块与静音按钮挨在一起。

**音量**：点喇叭静音/取消静音，拖右侧滑块调音量。取消静音会恢复到**上次的可听级别**（而不是停在 0，否则按钮会变成死路）。把滑块拖起来会自动解除静音。

**键盘**（先点一下播放器让它获得焦点，避免和聊天输入框抢键）：

| 按键 | 行为 |
|---|---|
| `Space` / `K` | 播放 / 暂停 |
| `←` / `→` | 后退 / 前进 5 秒 |
| `Shift` + `←` / `→` | 后退 / 前进 30 秒 |
| `J` / `L` | 后退 / 前进 30 秒 |
| `↑` / `↓` | 音量 +5% / -5% |
| `M` | 静音开关 |
| `Home` / `End` | 跳到开头 / 结尾 |
| `0`–`9` | 跳到 0%–90% 位置 |
| `,` / `.` | 逐帧后退 / 前进（按 24fps 近似） |
| `F` | 舞台全屏 |

设计细节：

- **不劫持组合键**：带 `Ctrl` / `Cmd` / `Alt` 的按键原样交给浏览器，`Ctrl+R`、`Alt+Tab` 之类照常工作。
- **焦点在滑块上时不抢方向键**：`<input type="range">` 获得焦点时，方向键交给它自己处理，否则音量滑块会失灵。
- **只在自己焦点内响应**：键盘处理挂在播放器根节点（`tabIndex=0`），不是全局 `window` 监听，所以在聊天框打字不会误触发。

## 音频专属：毛玻璃、频谱、歌词

音频舞台不是一块纯黑，而是一层毛玻璃面板。

**毛玻璃**：背后是三层径向渐变（蓝 / 粉 / 青）叠加，再 `blur(28px) saturate(150%)` 并放大 1.15 倍。放大是关键——不放大时模糊会采样到边缘的透明像素，糊出一圈灰边。`isolate` 隔离堆叠上下文，避免和皮肤主题的混合模式打架。

**频谱**：底部常驻一条 56 根柱子的实时频谱，走 Web Audio 的 `AnalyserNode`，柱高来自 FFT 的真实能量，播放时才动画（暂停即停，不空转烧电）。

> 隐藏依赖：`createMediaElementSource` 要求媒体 CORS-clean，否则 analyser 拿到全 0，频谱永久趴平。这正是客户端必须把 `crossOrigin` 设在 `src` 之前的另一条原因。

只取 FFT 低频的 55%——音乐能量集中在那，高频段几乎恒为空，全取会让图谱只剩左边在动。音频元素用零尺寸而非 `display:none`，否则部分内核会中断音频输出路径。

**歌词**：播放音频时，自动在**音频同目录**找同名 `.lrc`：

```
晚风邮局.mp3   →   晚风邮局.lrc
```

找到就渲染成可滚动面板，当前行高亮放大、随播放自动居中，**点任意一行跳转到那一句**。没找到就不显示歌词区，不报错。

支持的 LRC 写法：

| 写法 | 处理 |
|---|---|
| `[00:13.80]歌词` | 标准时间戳 |
| `[00:13.80][00:59.84]重复句` | 一行多时间戳，重复出现 |
| `[00:13.80][Verse 1]` | 段落标记，附着到下一句而**不**单独成行 |
| `[00:13.80][Chorus]歌词` | 行内段落标记，剥掉标记留下正文 |
| `[ti:]` `[ar:]` `[offset:]` 等 | 元数据不进正文；`offset` 按毫秒偏移时间轴 |
| BOM / CRLF / 无时间戳行 | 均正确处理 |

`.lrc` 大小写扩展名都会探测（`.lrc` / `.LRC` / `.Lrc`）。滚动用**容器内滚动**而非 `scrollIntoView`——后者会往上移动外层滚动容器，可能把整个侧边栏顶偏。

## 支持格式

| 类型 | 扩展名 |
|---|---|
| 音频 | `mp3` `wav` `wave` `ogg` `oga` `opus` `flac` `m4a` `aac` `wma` `aif` `aiff` `amr` `ape` `caf` `mka` `weba` |
| 视频 | `mp4` `m4v` `webm` `ogv` `mov` `qt` `mkv` `avi` `wmv` `flv` `mpeg` `mpg` `3gp` `3g2` `m2ts` `mts` |

能否真正解码取决于浏览器内核（例如部分 HEVC / AV1 组合），不支持的格式可以用「Download」取回原文件。

## 安装

```sh
dsh plugin --profile <profile> add dsh-media-preview
```

本地开发：

```sh
dsh plugin --profile <profile> add "link:<本目录>"
```

装完重启一次 `dsh web` 进程，然后浏览器硬刷新（`Ctrl/Cmd + Shift + R`）。

> 新增宿主半（`/media-preview` 路由）需要重启进程；之后只改 client 时硬刷新即可。

## 安全

- 路由复用与 `/api` 网关相同的 Host/Origin 栅栏：Host 必须是回环或显式受信 authority；
- `Origin` 必须是 `dsh-app://app`（壳层自身页面）或回环页面；
- 拒绝无差别跨站请求；非受信来源不回任何 CORS 头；
- 路径经会话 cwd 解析，扩展名白名单限定为音视频，因此该路由无法服务任意文件；
- 只读流式下发，不写文件、不设身份。

放宽的那一处（放行 `dsh-app://app`）是必要的：壳层页面用真实 Host 源加载媒体时**必然是跨站请求**，而身份仍由上面的 Host 检查决定，所以它不授予页面内请求本来没有的能力。

## 开发

```sh
node test/route.test.mjs     # 宿主路由回归（42 项：206 契约 / Range / 416 / CORS / 栅栏 / 405 / 404）
node test/gesture.test.mjs   # 手势与键盘（61 项：滑动/双击/长按/轴锁定/音量/键盘/取消）
node test/lyrics.test.mjs    # LRC 解析与歌词端点（48 项）
node --check index.js
node --check client.js
```

两个测试都自包含：路由测试自己造字节文件并起 http server；手势测试内置一个最小 React hooks 运行时，把 `client.js` 的真实组件渲染出来、用合成指针事件驱动它自己的处理器——测的是实现本身，不是重写的一份数学。

## 结构

| 文件 | 作用 |
|---|---|
| `index.js` | 宿主半：`/media-preview` 前缀路由（信任栅栏 + CORS + Range/206） |
| `client.js` | 客户端 bundle：共用实现注册两个 viewer（audio / video）+ 手势 |
| `cordis.patch.yml` | `dsh.bundle.patch` 挂载行 |
| `locale/{en,zh}.json` | Plugins 页显示用的标题与描述 |
| `icon.svg` | 插件图标 |
| `test/route.test.mjs` | 宿主路由回归测试 |

## 许可证

[MIT](./LICENSE)
