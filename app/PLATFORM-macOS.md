# qsyy · 平台适配与实现细节

本文档面向想了解 / 参与平台适配的开发者,说明认证、缓存解密、在线播放与
跨平台定位的实现原理。项目总览见[仓库根 README](../README.md)。

## 跨平台架构

所有 OS 相关的逻辑集中在 `app/standalone/platform.mjs`:
客户端安装定位(`CLIENT_ROOTS`)、签名库路径(`NATIVE_LIBS`)、
数据/缓存目录(`CLIENT_DATA`)、Cookie 读取方式、ffmpeg 查找、
文件管理器与客户端拉起命令。新增平台 = 在这个文件里加一个分支。

| 关注点 | macOS | Windows | Linux |
|--------|-------|---------|-------|
| 客户端安装 | `/Applications/汽水音乐.app` | `%LOCALAPPDATA%\Programs\qishui`(含 Program Files 回退) | `/opt/qishui` 等标准路径 |
| 客户端数据 | `~/Library/Application Support/SodaMusic` | `%APPDATA%\SodaMusic` | `~/.config/SodaMusic`(遵循 XDG) |
| Cookie 库 | 同上目录 `Cookies`(明文 SQLite) | 同上 | 同上 |
| 签名库 | `Contents/Frameworks` 下的 dylib | `resources\app.asar.unpacked` 下的 DLL | 同 Windows 布局,`.so` |
| ffmpeg | Homebrew 路径 | `C:/ffmpeg/bin` 等 | `/usr/bin` 等 |
| 打开目录 | `open` | `explorer` | `xdg-open` |
| qsyy 自有缓存 | `~/Library/Caches/qsyy` | `%LOCALAPPDATA%\qsyy` | `$XDG_CACHE_HOME/qsyy` |

缓存扫描链(`app/bridge/lib/runtime.js`)同样按平台解析:
restore 脚本、lmdb 模块、`device.node` 探测(Windows/Linux 的
`resources/app.asar.unpacked` 与 macOS 的 `Contents/Resources/` 布局差异已处理)、
ffmpeg 与 `LunaCacheV2` 缓存目录。所有路径都可用环境变量覆盖
(`QSYY_SODA_ROOT` / `QISHUI_CACHE_DIR` / `FFMPEG_PATH` / `QSYY_PLATFORM` 等)。

## 目录结构

```
app/
├── standalone/            # 独立应用
│   ├── server.mjs         # 应用服务器(API 代理 + 流式播放 + 缓存/下载管理)
│   ├── platform.mjs       # 跨平台平台层(客户端定位/Cookie/ffmpeg/文件管理器)
│   ├── ttnet-helper.mjs   # 常驻签名子进程(复用客户端网络栈,零登录在线播放)
│   ├── public/            # 前端(原生 JS,无框架,虚拟化懒加载)
│   └── device.json        # 设备参数覆盖(可选)
├── bridge/
│   ├── restore_cache.js   # 缓存扫描快照 + CENC 解密 + ffmpeg remux
│   ├── lib/               # RestoreService / 事件总线 / 跨平台运行时解析
│   └── node_modules/      # lmdb(原生模块,npm install 安装)
├── LICENSE
└── PLATFORM-macOS.md      # 本文
```

## 认证原理

- 会话凭据:读取已登录客户端的 Cookies(明文 SQLite `Cookies` 库)
  + 设备参数(deviceid/installid)。客户端登录态每 2 分钟自动重读,
  Cookies 过期后打开一次客户端即可刷新。
- API 形态:`https://api.qishui.com/luna/pc/*`(GET `/me`、`/me/playlist`、`/playlist/detail` 等)。

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

## 在线播放原理(零登录)

`track_v2` 需要字节系设备签名(x-helios/x-medusa/x-neptune 族)。`ttnet-helper.mjs`
作为常驻子进程,通过 `process.dlopen`(mssdk 先于 cronet 引擎加载,三平台同序)
只读加载客户端自带的签名库,再 require 客户端的 `ttnet.node`,以客户端登录态
调用 `track_v2` 拿到签名 CDN 直链。子进程崩溃自愈(原生 CHECK 失败只杀
helper,主服务按需重拉)。签名库缺失时 helper 以 `ok:false` 启动,服务端
自动降级到扫码网页会话通路(`web-session.json`,不入库)。

## 性能设计

- **API keep-alive 连接池**(API / CDN 分池)+ 歌单 API 30/60 秒短缓存,
  「同步收藏」带 `fresh=1` 强制直连
- **LMDB 快照共享**:复制 entries.db 是开销大头,10 秒 TTL 内并发扫描共享同一快照,
  扫描结果再按 key 去重合并 5 秒
- **解密并发治理**:上限 2、按 trackId 去重,成功结果按 chunkId 记忆避免重复解密
- **下载双车道**:播放专用道 + 后台道(总并发 2),批量缓存永不饿死正在点的歌;
  全新下载走 4 段并行分块,断点续传保持单流
- **SSE 脏门控**:进度推送只在有下载活动时触发,空闲 CPU 趋零
- **歌词随解析落盘**:resolve 成功即持久化 v2 歌词,面板打开即毫秒级磁盘命中
