# qsyy · macOS 平台实现细节

本文档面向想了解 / 参与 macOS 平台适配的开发者,说明 `mac/` 下的实现原理。
项目总览、快速开始、Roadmap 见[仓库根 README](../README.md)。

## 目录结构

```
mac/
├── standalone/            # 独立应用
│   ├── server.mjs         # 应用服务器(API 代理 + 流式播放 + 缓存/下载管理)
│   ├── ttnet-helper.mjs   # 常驻签名子进程(复用客户端网络栈,零登录在线播放)
│   ├── public/            # 前端(原生 JS,无框架,虚拟化懒加载)
│   └── device.json        # 设备参数覆盖(可选)
├── bridge/
│   ├── restore_cache.js   # 缓存扫描快照 + CENC 解密 + ffmpeg remux
│   └── lib/               # RestoreService / 事件总线 / 运行时路径解析
├── tools/decode-wav.swift # 备用:CoreAudio WAV 解码器(一般用不到)
└── debug/                 # 运行日志与下载任务历史(自动生成,不入库)
```

## 认证原理

- 会话凭据:读取已登录客户端的 Cookies(`~/Library/Application Support/SodaMusic/Cookies`,
  明文 SQLite)+ 设备参数(deviceid/installid)。客户端登录态每 2 分钟自动重读,
  Cookies 过期后打开一次汽水音乐即可刷新。
- API 形态:`https://api.qishui.com/luna/pc/*`(GET `/me`、`/me/playlist`、`/playlist/detail` 等)。

## 缓存读取与解密原理

汽水本地缓存(LunaCacheV2 的 `.bin`)在 Mac 客户端上通常**未加密**,
可直接复制为标准 M4A/MP4 播放;部分条目或在线 CDN 下载的流是
**CENC AES-128-CTR 加密**,moov 明文、音频样本加密,每个音质一条密钥,
密钥材料在缓存条目的 `encrypt_info.spade_a` 字段里。解密链路(见
`bridge/restore_cache.js`)按此分支处理:

1. `entries.db`(LMDB)按 `trackId` 定位缓存条目 → `chunkId` + `encrypt_info`
2. 若条目标记加密:加载 App 自带的 `device.node`(只读 require,不修改 App)→
   `decodeSpade(spade_a)` 解包出 AES-128 密钥,按 MP4 `senc` 盒子的 IV/子样本表
   逐样本 AES-CTR 解密
3. ffmpeg remux 成标准 faststart M4A;转码/写标签(320k MP3、FLAC 等)同样由 ffmpeg 完成

> `device.node` 仅在遇到加密条目时才真正参与解密;汽水更新后路径变化时
> 需要更新 `server.mjs` 里的 `DEVICE_NODE` 常量(以及 `bridge/lib/runtime.js` 的探测路径)。

## 在线播放原理(零登录)

`track_v2` 需要字节系设备签名(x-helios/x-medusa/x-neptune 族)。`ttnet-helper.mjs`
作为常驻子进程,通过 `process.dlopen` 只读加载客户端自带的
`libMetaSecML.dylib`(mssdk 签名)与 `libsscronet.dylib`,再 require 客户端的
`ttnet.node`,以客户端登录态调用 `track_v2` 拿到签名 CDN 直链。子进程崩溃自愈
(原生 CHECK 失败只杀 helper,主服务按需重拉)。备用通路:passport 扫码
获取网页会话(`web-session.json`,不入库),作为个别曲目的补充通路。

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

## 客户端更新后

重新打开一次汽水音乐刷新 Cookies 即可;`Packages` 版本变化不影响本项目
(只读 `Application Support` 下的缓存与 Cookies)。若客户端大版本更新导致
签名库崩溃,在线播放自动降级到扫码网页会话通路。
