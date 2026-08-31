<div align="center">

# qsyy

**汽水音乐第三方 Web 播放器 · 全端可用**

浏览并播放你的汽水音乐收藏 · 本地缓存直读 · 在线播放 · 逐字歌词 · 音效 · 下载

[![GitHub stars](https://img.shields.io/github/stars/shiaho777/qsyy?style=social)](https://github.com/shiaho777/qsyy/stargazers)
[![License](https://img.shields.io/badge/license-GPL--3.0%20%2B%20NC-blue)](./app/LICENSE)
[![Platform](https://img.shields.io/badge/platform-Web%20%7C%20macOS%20%7C%20Windows%20%7C%20Linux%20%7C%20Mobile-9cf)](#-全端支持)
[![PWA](https://img.shields.io/badge/PWA-%E5%8F%AF%E5%AE%89%E8%A3%85-5A0FC8)](#-快速开始)

</div>

---

## ✨ 特性

- 🎵 **收藏与歌单** — 直连官方 API,分页懒加载、歌单内搜索、多歌单管理
- ▶️ **本地缓存直读** — 直接播放客户端已缓存的歌曲,自动识别并解密,零等待
- 🌐 **在线播放** — 未缓存的歌曲直接在线播放,签名直链 + Range 代理,进度条随意拖动
- 💾 **播放即缓存** — 听过的歌自动持久化为增量缓存,支持断点续传,重进秒开
- 📥 **下载与转码** — M4A / MP3 / FLAC / WAV / OGG,音质逐曲可选,批量下载,失败重试
- 🎤 **逐字 K 歌歌词** — 逐字渐变高亮、平滑滚动居中、点击跳转、翻译同步显示
- 🎚️ **音效引擎** — 官方同款音效目录,Web Audio 实时渲染:超重低音 / 清澈人声 / 现场 / 摇滚 / 黑胶 / 动感电音 / 360 环绕,并为每首歌自动匹配智能音效
- 🗂️ **缓存库管理** — 多库切换、tar 备份 / 导入、曲目明细、一键清理
- ⌨️ **完整播放体验** — 播放队列、随机 / 列表循环 / 单曲循环、断点续播、系统媒体键、快捷键、队列持久化
- 📱 **PWA** — 支持安装为独立应用,获得沉浸式窗口体验

## 🚀 快速开始

```bash
git clone https://github.com/shiaho777/qsyy.git
cd qsyy

npm install --prefix app/bridge    # 安装依赖(含 lmdb 原生模块)
npm run standalone                 # → http://127.0.0.1:18790
```

打开浏览器访问 `http://127.0.0.1:18790`,登录态会自动从本机客户端读取,无需任何配置。

**环境要求**

| 依赖 | 说明 |
|------|------|
| Node.js 18+ | 服务端运行时 |
| ffmpeg | 可选,下载转码时使用(`brew install ffmpeg` / `winget install ffmpeg` / `apt install ffmpeg`) |
| 汽水音乐客户端 | 同机已安装并登录过一次(只读复用其会话与缓存) |

## 📱 全端支持

qsyy 本质是一个 Web 应用——**任何有现代浏览器的设备都可以访问它**,手机 / 平板 / 电脑全平台通用。服务端支持 macOS / Windows / Linux,自动定位客户端安装与缓存位置。

| 端 | 状态 |
|----|------|
| 浏览器(PWA) | ✅ 开箱即用,任何设备 |
| macOS | ✅ 完整支持(缓存直读 + 在线播放) |
| Windows | ✅ 完整支持(缓存直读 + 在线播放) |
| Linux | ✅ 完整支持(缓存直读 + 在线播放) |
| Android | ✅ 浏览器 / PWA 访问,移动端 UI + 在线播放 |
| iOS | ✅ 浏览器 / 添加到主屏幕,移动端 UI + 在线播放 |

## 🗺️ Roadmap

- [x] macOS 缓存直读 + 零登录在线播放
- [x] Windows / Linux 平台适配(客户端自动定位、Cookie 读取、签名库加载)
- [x] Android / iOS 移动端适配(响应式 UI、抽屉侧栏、PWA 安装、LAN 访问)
- [ ] 桌面客户端(Electron / Tauri)
- [ ] 歌单导入 / 导出
- [ ] 更多音效与可视化

欢迎通过 Issue / PR 参与共建!

## 🏗️ 架构

```
┌─────────────────────────────────────────────┐
│              浏览器 / PWA(全端)              │
│      原生 JS 前端 · 虚拟化列表 · Web Audio    │
└────────────────────┬────────────────────────┘
                     │ HTTP / SSE
┌────────────────────▼────────────────────────┐
│           standalone server(Node.js)        │
│   官方 API 代理 · 流式播放 · 缓存 · 下载 · 歌词 │
├──────────────┬──────────────┬───────────────┤
│  签名子进程   │   缓存扫描    │   ffmpeg      │
│ (客户端网络栈) │  (LMDB 快照) │  (转码/封装)   │
└──────────────┴──────────────┴───────────────┘
```

详细原理(认证、缓存解密、歌词格式、性能设计)见 [app/PLATFORM-macOS.md](./app/PLATFORM-macOS.md)。

## ⭐ Star History

[![Star History Chart](https://api.star-history.com/svg?repos=shiaho777/qsyy&type=Date)](https://star-history.com/#shiaho777/qsyy&Date)

## 📄 许可证

[GPL-3.0 + 非商业附加条款](./app/LICENSE) · 本项目与汽水音乐官方无关,请支持正版音乐。
