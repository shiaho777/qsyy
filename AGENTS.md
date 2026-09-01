# AGENTS.md — qsyy 协作与发版规范

面向在本仓库工作的 AI 与人类协作者。先读这份文档再动手;项目总览见
[README](README.md),实现细节见 [app/PLATFORM-macOS.md](app/PLATFORM-macOS.md)。

---

## 第一部分:交付流程(Issue → PR → CI → 合并)

### 硬规则

1. **基础分支永远是 `main`**。功能 PR 一律开进 `main`,除非维护者明确指定其他分支。
2. **Issue 先行**。有意图的代码 / 文档 / 流程变更先建 Issue(或复用未关闭的);
   标题短而可执行,body 写清问题 / 目标、范围、验收标准。
3. **合并才关 Issue**。PR body 必须含 `Fixes #N` 或 `Closes #N`,让 Issue 随合并
   自动关闭。PR 刚开、CI 还红时绝不提前关 Issue。
4. **CI 是合并门禁**。必需检查全绿才可合并;红灯先修再推,不合并红 PR。
   CI 永远不负责关 Issue。
5. **一个 PR 对应一个主 Issue**。额外 Issue 只在 body 里链接,不加关闭关键词。
6. **提交里没有秘密与垃圾**:`device.json`、`web-session.json`、`local.properties`、
   调试日志、IDE 缓存一律不入库(`.gitignore` 已覆盖,新增构建产物先补规则)。
7. **未经要求不推不交**。用户没说 deliver / push / ship 时,改完停在本地工作区。
8. **权限不足时降级交付**:能开 PR + 在 Issue 上评论留链接,合并交维护者;
   Issue 保持打开。

### 分支与提交

- 分支名:`feat/…`、`fix/…`、`docs/…`,从最新 `main` 切出。
- 提交信息用** Conventional Commits**(见第二部分,它直接决定更新日志):
  `feat: …` / `fix: …` / `perf: …` / `docs: …` / `refactor: …` / `build: …` / `chore: …`
- 标题语言与仓库一致(中文),scope 可选:`feat(desktop): …`。
- 只提交目标文件;顺手修的无关问题单独提交。

### 交付步骤(用户说"发 / push / ship / 开 PR"时)

```
Issue(建或复用)→ 分支(自 main)→ 提交 → push → PR(base=main,body 含 Fixes #N)
→ 在 Issue 上评论 PR 链接与状态 → 等 CI → 绿则合并 → 确认 Issue 已关 → 汇报链接
```

- 仓库当前门禁:`ci.yml` 的 `gate` job(JS 语法检查、workflow YAML 校验、
  文档链接校验)。合并前确认它绿。
- 无权限合并时:PR + Issue 评论留链接,明确"等待维护者合并"。

---

## 第二部分:发布流程(三端客户端发到 GitHub Release)

### 版本与更新日志

1. **版本号**:语义化版本。改服务端行为升 minor,纯修复升 patch,破坏性变更升
   major。版本出现在三处,发布时必须同步:`desktop/package.json` 的 `version`、
   `android/app/build.gradle.kts` 的 `versionName`/`versionCode`(code 每次 +1)、
   `CHANGELOG.md` 的新条目。
2. **更新日志双轨**:
   - `CHANGELOG.md`:手工维护,人类可读的权威记录,发布前更新。
   - Release notes:由 `scripts/release-notes.mjs` 从上一个 tag 以来的
     Conventional Commits 自动生成(feat/fix/perf/docs/build/chore 分节)。
     **这就是提交信息必须守规范的原因**——写得对,日志就对。
3. **发布操作 = 打 tag**:
   ```bash
   # 前提:以上版本号三处已同步并合并进 main
   git checkout main && git pull
   git tag v1.2.3 && git push origin v1.2.3
   ```
   `release.yml` 随 tag 触发,自动完成其余一切。
4. **发布产物**(tag `vX.Y.Z` 触发三端矩阵构建):
   | 端 | 产物 | 构建机 |
   |----|------|--------|
   | macOS | `qsyy-X.Y.Z-arm64.dmg` + zip(arm64/x64) | `macos-14` |
   | Windows | `qsyy-setup-X.Y.Z.exe`(NSIS)+ zip(x64) | `windows-latest` |
   | Android | `qsyy-X.Y.Z.apk`(debug 签名,开箱即装) | `ubuntu-latest` |
   四个 job(changelog / desktop-mac / desktop-win / android)汇入 `publish`,
   由它建 Release 并附产物;Notes 来自 changelog job 的输出。
5. **发布失败**:看 Actions 里红掉的矩阵 job 日志,修完重新打 tag
   (删旧 tag 重打:`git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z`)。
   不手工上传产物——可复现性优先。
6. **桌面端注意**:Electron 直接 `import` `app/standalone/server.mjs`(进程内跑服务,
   零逻辑重复),`electron-builder` 的 `extraResources` 把整个 `app/` 打进包。
   改动 `server.mjs` 的文件布局或顶层副作用时,必须验证桌面壳还能启动。
7. **Android 注意**:APK 目前为 debug 签名(可直接安装);正式签名 keystore 属于
   维护者,不进仓库。`versionCode` 只增不减。

---

## 第三部分:项目经验(改代码前必读)

### 架构速记

- **单文件服务端** `app/standalone/server.mjs`(~1950 行)承担全部路由;平台差异
  全部收在 `app/standalone/platform.mjs` 与 `app/bridge/lib/runtime.js`。改平台逻辑
  只动这两个文件 + `runtime.js`,不要在 server 里写 `process.platform` 判断。
- **前端零框架**(`public/app.js`),无构建步骤。改前端后刷新即生效(服务端按
  mtime 热读文件),不需要重启。
- **三进程结构**:主服务 / `ttnet-helper.mjs`(签名子进程,崩溃自愈)/
  `restore_cache.js` 扫描子进程(fork,对 entries.db 快照)。原生模块只允许在后
  两个进程里加载,主服务崩不起。

### 认证与签名链路(最容易踩坑)

- 会话 = 读客户端 Cookies(明文 SQLite,`sqlite3` CLI)+ 固定设备参数。
  Cookies 2 分钟缓存;`device.json` 可覆盖设备参数但不入库。
- 在线播放链:主服务 → stdin/stdout JSON 行协议 → ttnet-helper(dlopen 顺序:
  **mssdk 必须先于 cronet**,三平台同序)→ `track_v2` → 签名 CDN 直链。
- 直链可能**整段 base64**(非 http 开头时先 base64 解码);VIP 试听判定:
  `streamSeconds < trackSeconds * 0.6`。这些解析逻辑在 ttnet-helper 的
  `pickBestUrl`,改它要同步看 `resolveOnlineTrack`(扫码通路的同款逻辑)。

### 缓存与解密(核心资产,改动需测试)

- 客户端缓存:`entries.db`(LMDB)索引 + `<chunkId>.bin` 数据文件。扫描必须:
  文件快照 → fork 子进程 → 30s 超时 → 失败换新快照重试(3 次)。直接在主进程
  开 lmdb 会与客户端写入冲突。
- CENC 解密:moov 明文,`senc` 盒携带 IV + 子样本表;密钥在条目
  `encrypt_info.spade_a`,经客户端 `device.node` 的 `decodeSpade` 解出(返回
  32 位 hex)。每个音质一条密钥,匹配时先按 `entry.info.quality` 选
  `video_list` 项。
- 音质优先级 `QUALITY_RANK = lossless > hi_res > spatial > highest > higher >
  medium > default`;同曲多条目按 `kind === 'F'`(完整)优先。
- 客户端试听条目 `isPreview === true`(30s),必须让位在线通路(60s/完整)。

### 并发与性能(数字都是教训,别随手改)

- 下载总并发 2,双车道(播放专用道 + 后台道);后台任务可升级为播放道。
  解密并发 2。全新下载 4 段并行分块,续传单流。
- SSE 两条流都是**脏门控 / push-on-change**,不要加回周期性全量序列化。
- 元数据落盘 400ms 节流;API GET 短缓存 30/60/90s,`fresh=1` 强制直连;
  缓存命中条件是"响应体无 code/status_code 字段"(错误响应不得毒化缓存)。
- 历史实锤 bug:`onlineRace` 未 await(`||` 会拿到 promise 本体)、scanKey
  不含质量导致误命中。改流式路由时把这两个回归用例记在心里。

### 平台范围

- 服务端承诺:macOS / Windows。移动端承诺:Android(浏览器 / PWA / 壳)。
  文档与徽章不得再引入 Linux / iOS。
- `platform.mjs` 里保留的 Linux 分支是死代码但无害;删除与否不影响承诺。

### 构建与验证(改动后至少跑这些)

```bash
node --check app/standalone/server.mjs          # 语法
node --check desktop/main.mjs
npm install --prefix app/bridge                  # lmdb 原生模块(首次)
npm run standalone                               # 起服务,打开 127.0.0.1:18790 冒烟
cd android && ./gradlew assembleDebug            # APK(需 JDK 17 + Android SDK)
cd desktop && npm install && npm start           # 桌面壳冒烟
```

### 踩坑记录(新坑追加在这里)

- **Gradle wrapper 生成**:本机 Gradle(8.5)低于项目要求(8.9)时,`gradle
  wrapper` 会在配置阶段就失败(Android 插件的 version-check 先于 wrapper 任务跑)。
  解法:在空目录用 `settings.gradle.kts` 引导生成 wrapper,再把 `gradlew`/
  `gradlew.bat`/`gradle/` 拷进项目。
- **Android Kotlin 重复类**:appcompat 1.7.0 传递依赖 kotlin-stdlib-jdk7/jdk8
  1.6.x,与 kotlin-stdlib 1.8+ 冲突。解法:对 appcompat 依赖 exclude 这两个
  module,并显式引入 `kotlin-stdlib:1.8.22`。
- **`local.properties` 永不入库**(已 gitignore);CI 用 `ANDROID_HOME` 环境变量。
- **Electron 只能建一个 MediaElementSource**;`server.mjs` 是带顶层副作用的模块
  (监听端口),import 即启动,不要改成懒加载后再 import 两次。
- **微信等聊天工具的截图临时目录会被清理**,入库素材第一时间拷进 `docs/assets/`。
