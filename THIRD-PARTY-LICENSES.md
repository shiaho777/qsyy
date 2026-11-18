# 第三方许可清单

qsyy 自身许可见 [LICENSE](LICENSE)（GPL-3.0 + 非商业附加条款）。
本文件汇总各端运行时与构建依赖的许可证，履行署名义务。
许可证字段逐项核实自 npm registry 元数据（核实日期：2026-11-18）。

## 运行时依赖（随产物分发）

### 服务端 / 桥接（app/bridge）

| 组件 | 版本 | 许可证 | 用途 |
|---|---|---|---|
| [lmdb](https://github.com/kriszyp/lmdb-js) | ^3.5.6 | MIT | 客户端缓存索引（entries.db）只读扫描，仅在 fork 子进程加载 |
| msgpackr（lmdb 传递依赖） | 2.x | MIT | 缓存条目解码 |
| ordered-binary（lmdb 传递依赖） | 1.x | MIT | LMDB 键序 |
| weak-lru-cache（lmdb 传递依赖） | 1.x | MIT | lmdb 内部缓存 |
| node-gyp-build（lmdb 传递依赖） | 4.x | MIT | 原生模块加载 |

### 桌面壳（desktop）

| 组件 | 版本 | 许可证 | 用途 |
|---|---|---|---|
| [Electron](https://github.com/electron/electron) | 33.4.11（精确钉死） | MIT | 桌面运行时（Chromium + Node.js） |

Electron 内含 Chromium（BSD-3-Clause 等多许可）与 Node.js（MIT 等），
完整清单随 Electron 发行版附带（安装目录 `LICENSE` / `LICENSES.chromium.html`）。

### OBS 歌词舞台（obs-folia，AGPL-3.0 隔离模块）

本模块整体以 **AGPL-3.0** 分发（见 [obs-folia/LICENSE](obs-folia/LICENSE)），
移植来源与裁剪说明见 [obs-folia/NOTICE.md](obs-folia/NOTICE.md)。

| 组件 | 版本 | 许可证 | 用途 |
|---|---|---|---|
| [Folia](https://github.com/chthollyphile/folia-major)（代码移植） | main 分支快照 | AGPL-3.0 | Tilt / Cappella / Fume 歌词动画与 FluidBackground |
| [react](https://github.com/facebook/react) | 19.3.0 | MIT | UI 运行时 |
| [react-dom](https://github.com/facebook/react) | 19.3.0 | MIT | DOM 渲染 |
| [framer-motion](https://github.com/motiondivision/motion) | 13.4.3 | MIT | 动画 |
| [@chenglou/pretext](https://github.com/chenglou/pretext) | 0.0.9 | MIT | 文本排版测量 |

Cappella 内置头像 / 表情图片资产来自 Folia 仓库，上游声明见
`obs-folia/src/cappella/avatar/README.md` 与 `emo/README.md`
（folia-chan 为 AI 生成图，上游声明不受 AGPL 约束、可自由使用）。

## 仅构建期依赖（不随产物分发）

| 组件 | 版本 | 许可证 | 用途 |
|---|---|---|---|
| [electron-builder](https://github.com/electron-userland/electron-builder) | ^25.1.8 | MIT | 桌面打包 |
| [vite](https://github.com/vitejs/vite) | 8.3.1 | MIT | obs-folia 构建 |
| [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react) | 6.1.1 | MIT | obs-folia 构建 |
| [typescript](https://github.com/microsoft/TypeScript) | ^5.9.3 | Apache-2.0 | obs-folia 类型检查 |
| @types/react / @types/react-dom | ^19.3.0 | MIT | 类型声明 |
| Android Gradle Plugin / Kotlin / appcompat 等 | 见 android/ | Apache-2.0 等 | APK 构建（AndroidX 组件随 APK 分发，均为 Apache-2.0） |

## 数据与内容来源

| 来源 | 许可 | 说明 |
|---|---|---|
| [amll-ttml-db](https://github.com/amll-dev/amll-ttml-db) | 提交者原创部分 CC0-1.0，外来数据随原提供方协议 | 社区 TTML 歌词兜底；界面展示贡献者署名（`ttmlAuthorGithubLogin`） |
| 汽水音乐官方接口 / 封面 / 音效配置 | 版权归原权利人 | 仅复用用户本机已有授权会话，不再分发媒体内容 |

## 维护约定

新增运行时依赖时同步更新本清单（核实 license 字段，不凭印象填写）。
MIT / Apache-2.0 / BSD 组件的完整许可文本随各自 npm 包 / 发行版附带；
GPL / AGPL 组件全文见对应 LICENSE 文件。