# 更新日志

所有显著变更记录于此。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/),
版本号遵循语义化版本;每条 Release 的详细说明由 `scripts/release-notes.mjs`
从 Conventional Commits 自动生成(见 AGENTS.md 的发版规范)。

## [1.1.0] - 2026-09-03

### 新功能
- 三端应用图标统一为汽水罐:SVG 矢量源 + `scripts/make-icons.py` 一键生成
  (桌面 icns/ico、Android 自适应图标、PWA manifest 与 favicon)，替换旧占位
  SVG(Issue #24)
- 侧栏底部 GitHub 行:仓库入口 + 版本号展示，右侧内嵌「检查更新」按钮，
  对比 GitHub 最新 Release，有新版直达对应 release 页(Issue #23)
- 新增 `GET /api/version`(版本号 + 仓库地址)

[1.1.0]: https://github.com/shiaho777/qsyy/releases/tag/v1.1.0

## [1.1.1] - 2026-09-03

### 重构
- 侧栏底部「管理缓存」不再独占一行，与「同步收藏」并排(Issue #26)

[1.1.1]: https://github.com/shiaho777/qsyy/releases/tag/v1.1.1

## [1.0.2] - 2026-09-01

### 修复
- 桌面版本地缓存全部显示为未缓存:Electron 内 spawn 的 Node 子进程(scan /
  decrypt / ttnet-helper / restore)缺 `ELECTRON_RUN_AS_NODE=1`,被应用二进制
  静默吞掉,缓存扫描永远为空(Issue #20)
- 顺带确认 v1.0.1 的单实例锁正常,连续点击 Dock 图标不再叠开窗口

[1.0.2]: https://github.com/shiaho777/qsyy/releases/tag/v1.0.2

## [1.0.1] - 2026-09-01

### 修复
- 桌面壳加单实例锁:重复启动(Dock 图标反复点击 / 安装时旧实例存活)不再叠开
  多个窗口,第二次启动会把已有窗口带回前台(Issue #16)
- 启动探针改用瞬时端点并加 1.5s 超时,首次启动不再长时间白屏
  (原探针会等待签名子进程最长 4 秒)

[1.0.1]: https://github.com/shiaho777/qsyy/releases/tag/v1.0.1

## [1.0.0] - 2026-09-01

### 新功能
- 三端客户端:macOS(dmg/zip)、Windows(nsis 安装器/zip)、Android(apk),
  tag 推送后由 GitHub Actions 自动构建并发布到 Release
- 更新日志自动化:release workflow 按 Conventional Commits 生成发布说明
- `desktop/`:Electron 壳,进程内加载 standalone 服务,零逻辑重复
- `android/`:WebView 壳,首次启动配置服务端地址,前台服务保活播放
- `.github/workflows/release.yml`:三端矩阵构建 + Release 发布
- `.github/workflows/ci.yml`:push/PR 门禁(语法检查、workflow 校验、文档链接)
- `AGENTS.md`:交付 / 发版行为规范与项目经验库

### 文档
- README 重写为"核心功能"驱动结构(音效 / 音质 / 源文件与转码 / 三层缓存机制)
- PLATFORM-macOS.md 补全环境变量总表、HTTP API 一览、播放通路降级链
- 平台范围收敛:服务端 macOS / Windows,移动端 Android

[1.0.0]: https://github.com/shiaho777/qsyy/releases/tag/v1.0.0
