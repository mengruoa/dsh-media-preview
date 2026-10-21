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
node test/route.test.mjs   # 宿主路由回归（42 项：206 契约 / Range / 416 / CORS / 栅栏 / 405 / 404）
node --check index.js
node --check client.js
```

测试自包含：自己造字节文件、自己起 http server，不需要 ffmpeg 或任何 fixture。

## 结构

| 文件 | 作用 |
|---|---|
| `index.js` | 宿主半：`/media-preview` 前缀路由（信任栅栏 + CORS + Range/206） |
| `client.js` | 客户端 bundle：共用实现注册两个 viewer（audio / video） |
| `cordis.patch.yml` | `dsh.bundle.patch` 挂载行 |
| `locale/{en,zh}.json` | Plugins 页显示用的标题与描述 |
| `icon.svg` | 插件图标 |
| `test/route.test.mjs` | 宿主路由回归测试 |

## 许可证

[MIT](./LICENSE)
