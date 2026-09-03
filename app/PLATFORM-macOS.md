# qsyy · 平台适配与实现细节

本文档面向想了解 / 参与平台适配的开发者,说明认证、缓存解密、在线播放与
跨平台定位的实现原理。项目总览见[仓库根 README](../README.md)。

## 跨平台架构

所有 OS 相关的逻辑集中在 `app/standalone/platform.mjs`:
客户端安装定位(`CLIENT_ROOTS`)、签名库路径(`NATIVE_LIBS`)、
数据/缓存目录(`CLIENT_DATA`)、Cookie 读取方式、ffmpeg 查找、
文件管理器与客户端拉起命令。新增平台 = 在这个文件里加一个分支。

| 关注点 | macOS | Windows |
|--------|-------|---------|
| 客户端安装 | `/Applications/汽水音乐.app` | `%LOCALAPPDATA%\Programs\qishui`(含 Program Files 回退) |
| 客户端数据 | `~/Library/Application Support/SodaMusic` | `%APPDATA%\SodaMusic` |
| Cookie 库 | 同上目录 `Cookies`(明文 SQLite) | 同上 |
| 签名库 | `Contents/Frameworks` 下的 dylib | `resources\app.asar.unpacked` 下的 DLL |
| ffmpeg | Homebrew 路径 | `C:/ffmpeg/bin` 等 |
| 打开目录 | `open` | `explorer` |
| qsyy 自有缓存 | `~/Library/Caches/qsyy` | `%LOCALAPPDATA%\qsyy` |

缓存扫描链(`app/bridge/lib/runtime.js`)同样按平台解析:
restore 脚本、lmdb 模块、`device.node` 探测(Windows 的
`resources/app.asar.unpacked` 与 macOS 的 `Contents/Resources/` 布局差异已处理)、
ffmpeg 与 `LunaCacheV2` 缓存目录。

## 环境变量

所有路径与行为都可用环境变量覆盖,无需改代码:

| 变量 | 默认 | 作用 |
|------|------|------|
| `QSYY_PORT` / `SODA_APP_PORT` | `18790` | 服务监听端口 |
| `QSYY_HOST` | `127.0.0.1` | 设为 `0.0.0.0` 开放局域网访问 |
| `QSYY_CACHE_DIR` / `QISHUI_CACHE_DIR` | 客户端 `LunaCacheV2` 位置 | 缓存扫描目录 |
| `QSYY_COOKIES_DB` | 客户端 `Cookies` 库 | 会话 Cookie 数据库路径 |
| `QSYY_DOWNLOAD_DIR` | `~/Downloads/qsyy` | 下载输出目录 |
| `QSYY_SODA_ROOT` / `QISHUI_SODA_ROOT` | 按平台自动定位 | 客户端安装根目录 |
| `FFMPEG_PATH` | 按平台候选列表查找 | ffmpeg 可执行文件 |
| `QSYY_PLATFORM` | `process.platform` | 强制按指定平台解析运行时(调试用) |
| `QSYY_DEBUG` / `SODA_DEBUG` | 关 | 调试日志 |
| `TTNET_DEBUG` | 关 | 打印 track_v2 原始响应摘要 |

## 移动端(Android)

qsyy 是 Web 应用,手机 / 平板浏览器直接访问服务端即可使用完整 UI,
无需安装任何东西:

```bash
# 在桌面机上开局域网访问,手机连同一 Wi-Fi 打开打印出的地址
QSYY_HOST=0.0.0.0 npm run standalone
# → [qsyy] LAN: http://192.168.x.x:18790
```

移动端适配内容:

- **响应式 UI**:≤720px 侧栏变为抽屉(左上角按钮开合、点遮罩/选歌单自动收起)、
  歌曲列表隐藏歌手/专辑列、播放器压缩为两行紧凑布局、各面板改为近全宽;
  ≤1020px 平板档隐藏专辑列
- **触屏优化**:`pointer: coarse` 下加大按钮/行高触控目标,进度条 `touch-action: none`
  支持拖动,MediaSession 让锁屏/控制中心显示曲目与快捷键
- **PWA 安装**:Android Chrome「安装应用」即可获得独立全屏窗口
  (含 manifest、safe-area 适配、SVG 图标)
- **音频播放**:所有流式接口都支持 Range,移动浏览器可正常拖动进度

平台差异说明:桌面客户端的缓存为 App 私有目录(移动端无 root 不可读),
因此手机浏览器上「本地缓存直读」不可用,播放走**在线播放通路**(已默认支持),
缓存在桌面端的歌由桌面端服务统一提供。

## 目录结构

```
app/
├── standalone/            # 独立应用
│   ├── server.mjs         # 应用服务器(API 代理 + 流式播放 + 缓存/下载管理)
│   ├── platform.mjs       # 跨平台平台层(客户端定位/Cookie/ffmpeg/文件管理器)
│   ├── ttnet-helper.mjs   # 常驻签名子进程(复用客户端网络栈,零登录在线播放)
│   ├── public/            # 前端(原生 JS,无框架,虚拟化懒加载)
│   └── device.json        # 设备参数覆盖(可选,不入库)
├── bridge/
│   ├── restore_cache.js   # 缓存扫描快照 + CENC 解密 + ffmpeg remux
│   ├── lib/               # RestoreService / 事件总线 / 跨平台运行时解析
│   └── node_modules/      # lmdb(原生模块,npm install 安装)
├── tools/                 # 辅助小工具(decode-wav 调试解码器)
├── LICENSE
└── PLATFORM-macOS.md      # 本文
```

## 认证原理

- 会话凭据:读取已登录客户端的 Cookies(明文 SQLite `Cookies` 库)
  + 设备参数(deviceid/installid,可在 `device.json` 覆盖)。
  客户端登录态每 2 分钟自动重读,Cookies 过期后打开一次客户端即可刷新。
- API 形态:`https://api.qishui.com/luna/pc/*`(GET `/me`、`/me/playlist`、
  `/playlist/detail` 等),幂等 GET 带 30/60/90 秒短缓存,`fresh=1` 强制直连。
- 兜底:签名库缺失时走扫码网页会话(`/api/weblogin/*`,passport 接口,
  会话存 `web-session.json`,不入库、已在 `.gitignore` 排除)。

## 播放通路

`GET /api/stream/:trackId` 按以下优先级出流(全部支持 Range):

1. **客户端缓存直读** — LMDB 快照定位 `chunkId`,未加密条目直接流式返回;
   CENC 加密条目先解密(并发上限 2,按 chunkId 记忆避免重复解密)
2. **在线播放** — 客户端缓存只有 30s 试听片段时优先走在线(60s/完整),
   未缓存时在线通路边下边播,同时后台下载为**增量缓存**
   (播放专用下载道,批量下载永不抢占),下次播放秒开
3. **降级链** — ttnet 签名子进程 → 扫码网页会话 → 客户端短试听片段

在线直链由 `ttnet-helper.mjs` 常驻子进程解析:通过 `process.dlopen`
(mssdk 先于 cronet 引擎加载,三平台同序)只读加载客户端自带的签名库,
再 require 客户端的 `ttnet.node`,以客户端登录态调用 `track_v2` 拿到
签名 CDN 直链。子进程崩溃自愈(原生 CHECK 失败只杀 helper,主服务按需重拉)。
同一响应还顺带带回音效配置、逐字歌词与 VIP 试听判定。

## HTTP API 一览

前端只消费这些接口,第三方集成也以此为准:

| 路由 | 说明 |
|------|------|
| `GET /api/me` · `/api/playlists` · `/api/playlist/:id` · `/api/collections` | 官方 API 代理(带短缓存,`?fresh` 直连) |
| `GET /api/stream/:trackId` | 播放出流(缓存直读 / 在线,支持 Range) |
| `GET /api/online/:trackId` | 查询在线可播性(音质 / 试听判定) |
| `GET /api/cache-status?ids=` | 批量查询客户端缓存 + 自有增量缓存状态(≤80 ids) |
| `GET /api/lyrics/:trackId` | 逐字歌词(v2 JSON + 标准 LRC,随解析落盘) |
| `GET /api/effects` · `/api/effects/:key` · `/api/effect-config?url=` | 音效目录 / 预置 DSP 链 / 智能音效配置 |
| `GET /api/cover?url=` | 封面图代理 |
| `POST /api/download` · `GET /api/downloads` | 下载任务(转码格式 / 音质可选) |
| `GET /api/progress-stream` · `/api/progress` | 增量缓存进度(SSE 脏门控 / 轮询) |
| `GET /api/events` | 下载任务事件流(SSE,push-on-change) |
| `GET /api/monitor/:trackId` | 长轮询(≤120s):等用户在官方客户端播放出缓存 |
| `GET /api/store/sets` · `/api/store/tracks` 及对应 POST | 缓存库列表 / 切换 / 创建 / 删除 / 清理 / 移除曲目 |
| `GET /api/backup` · `POST /api/restore` | tar 备份导出 / 流式导入(路径穿越安全) |
| `GET /api/weblogin/status` · `/qr` · `/poll` · `POST /logout` | 扫码网页会话兜底通路 |
| `GET /api/stats` | 缓存总大小(info.db 快照只读统计) |
| `GET /api/version` | 应用版本号 + 仓库地址(侧栏 GitHub 行 / 检查更新) |
| `POST /api/open-downloads` · `/api/open-client` | 打开下载目录 / 拉起官方客户端 |

## 缓存读取与解密原理

汽水本地缓存(LunaCacheV2 的 `.bin`)通常**未加密**,可直接复制为标准
M4A/MP4 播放;部分条目或在线 CDN 下载的流是 **CENC AES-128-CTR 加密**,
moov 明文、音频样本加密,每个音质一条密钥,密钥材料在缓存条目的
`encrypt_info.spade_a` 字段里。解密链路(见 `bridge/restore_cache.js`)
按此分支处理:

1. `entries.db`(LMDB)按 `trackId` 定位缓存条目 → `chunkId` + `encrypt_info`
2. 若条目标记加密:加载客户端自带的 `device.node`(只读 require,不修改客户端)→
   `decodeSpade(spade_a)` 解包出 AES-128 密钥,按 MP4 `senc` 盒子的 IV/子样本表
   逐样本 AES-CTR 解密
3. ffmpeg remux 成标准 faststart M4A;转码/写标签(320k MP3、FLAC 等)同样由 ffmpeg 完成

> `device.node` 仅在遇到加密条目时才真正参与解密;客户端更新后路径变化时,
> `platform.mjs` 的定位逻辑会按候选列表自动查找,极端情况下可用环境变量覆盖。

扫描稳定性:`entries.db` 被客户端持有时 lmdb 打开可能中断,因此每次扫描都在
fork 子进程中对文件快照进行(10 秒 TTL 内并发共享同一快照,结果按 key 去重
合并 5 秒),子进程崩溃自动换新快照重试。

## 逐字歌词格式

客户端随 `track_v2` 下发 K 歌 LRC:每行 `[startMs,durMs]` 后跟逐字标签
`<offsetMs,durMs,0>字`,翻译是时间戳对齐的普通 LRC 块(按毫秒配对,
不自行推算偏移)。`server.mjs` 解析为 v2 JSON(`lines[].words[]`)与标准
LRC 双格式,resolve 成功即落盘,面板打开毫秒级命中;部分歌曲只有普通
`[mm:ss.xx]` LRC,同样支持。

## 性能设计

- **API keep-alive 连接池**(API / CDN 分池)+ 歌单 API 30/60/90 秒短缓存,
  「同步收藏」带 `fresh=1` 强制直连
- **LMDB 快照共享**:复制 entries.db 是开销大头,10 秒 TTL 内并发扫描共享同一快照,
  扫描结果再按 key 去重合并 5 秒;`cache-status` 按 id 粒度命中,翻页回访零子进程
- **解密并发治理**:上限 2、按 trackId 去重,成功结果按 chunkId 记忆避免重复解密
- **下载双车道**:播放专用道 + 后台道(总并发 2),批量缓存永不饿死正在点的歌;
  全新下载走 4 段并行分块,断点续传保持单流
- **SSE 脏门控**:进度推送只在有下载活动时触发,空闲 CPU 趋零;
  任务事件流 push-on-change,无周期性全量序列化
- **歌词随解析落盘**:resolve 成功即持久化 v2 歌词,面板打开即毫秒级磁盘命中
