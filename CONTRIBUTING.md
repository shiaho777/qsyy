# 贡献指南

欢迎参与 qsyy。动手前先读 [AGENTS.md](AGENTS.md)（协作与发版规范）和
[README](README.md)（项目总览），本文只讲怎么参与。

## 不会代码也能贡献

- **报 bug**：用 issue 表单，带复现步骤、端与版本号。
- **文档**：README / 平台文档的错漏、缺失说明，直接提 PR。
- **翻译 / 设计**：界面文案、图标、截图素材都欢迎，先开 issue 对齐范围。
- **功能建议**：说清要解决什么问题，没有真实场景的建议大概率不做。

## 开发环境

需要 Node.js 24+，同机安装并登录过一次汽水音乐客户端（服务端只读复用其会话与缓存）。

```bash
npm install --prefix app/bridge    # 依赖安装，含 lmdb 原生模块
npm run standalone                 # 起服务 → http://127.0.0.1:18790
```

按需补充：

- **桌面壳**：`cd desktop && npm install && npm start`。
- **OBS Folia 模块**：`cd obs-folia && npm install && npm run build`，
  改完必须重新 build，产物在 `public/obs-folia/`。
- **Android**：需要 JDK 17 + Android SDK，`cd android && ./gradlew assembleDebug`。
- **转码功能**：可选安装 ffmpeg。

改前端刷新即生效；改 `server.mjs` 需重启服务。

## 交付闭环

1. **Issue 先行**：先建（或复用）Issue，写清问题、范围、验收标准。
2. **分支自 main**：命名 `feat/…` / `fix/…` / `docs/…`。
3. **Conventional Commits，中文标题**：`feat: …` / `fix: …` / `docs: …`，
   scope 可选。提交信息直接决定自动生成的 Release notes。
4. **PR base=main**，body 含 `Fixes #N`（或 `Closes #N`），Issue 随合并自动关闭。
5. **CI gate 全绿才合并**：语法检查、单元测试、workflow YAML 校验、文档链接校验。
   红灯先修再推；CI 不负责关 Issue，合并才关。
6. **无合并权限**：提 PR + 在 Issue 评论留链接，等维护者合并，Issue 保持打开。

不入库的东西：`device.json`、`web-session.json`、`local.properties`、调试日志、
IDE 缓存。只提交目标文件，顺手修的无关问题单独提交。

## 代码约定要点

细则见 [AGENTS.md](AGENTS.md) 第三部分，这里只列最容易踩的四条：

- **纯逻辑模块 + 测试**：无状态逻辑放 `app/standalone/` 并配 `*.test.mjs`，
  CI 自动收录。
- **Android 白名单**：新模块必须加进 `android/app/build.gradle.kts` 的
  `syncQsyyRuntime` 白名单，漏了 APK 运行时报 `ERR_MODULE_NOT_FOUND`。
- **前端脚本顺序**：零框架、共享全局作用域，`index.html` 的 `<script>` 顺序
  即依赖顺序，加载期语句只能用到本文件或更早文件声明的名字。
- **平台差异收口**：只动 `platform.mjs` 与 `bridge/lib/runtime.js`，
  不要在 server 里写 `process.platform` 判断。

## AI 提交政策

- **人类责任不可转移**：AI 辅助不免除提交者理解与验证的责任。PR 模板里
  「我已逐行读懂并本地验证全部改动」必须勾选。
- **披露可选，核验必须**：可以在 PR 里注明用了哪个模型，但无论是否披露，
  改动都必须经过你本人逐行审阅和本地测试。
- **拒绝未经审阅的生成**：整段粘贴模型输出直接提 PR 会被关闭。
- **拒绝「生成→修复→修复」循环**：靠反复让模型修补报错凑出的 diff 不收；
  先自己定位根因，再改。

## 许可证注意

- 主仓为 **GPL-3.0 + 非商业附加条款**（见 [app/LICENSE](app/LICENSE)），
  提交即表示同意按此许可分发你的贡献。
- `obs-folia/` 是独立的 **AGPL-3.0** 隔离模块。移植 Folia 的代码**只能进
  `obs-folia/`**，不得混入主仓其他目录，并在
  [obs-folia/NOTICE.md](obs-folia/NOTICE.md) 补上游归属。
- 本项目与汽水音乐官方无关，不接受任何侵犯官方权益的改动。
