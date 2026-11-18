<!-- PR base 必须是 main。标题用 Conventional Commits 中文写法，如 feat(desktop): …。 -->

## Summary

<!-- 一两句话说清这个 PR 做了什么、为什么。 -->

## Fixes #N

<!-- 必填关闭关键词：Fixes #N 或 Closes #N，Issue 随合并自动关闭。
     没有对应 Issue 先建一个（Issue 先行）。一个 PR 只关一个主 Issue，
     其他相关 Issue 只贴链接，不加关闭关键词。 -->

Fixes #

## 改动清单

<!-- 逐条列出改动的文件/模块与目的。 -->

-

## Test plan

<!-- 按实际改动勾选并说明结果，没跑的写「未跑」及原因。 -->

- [ ] `node --test app/standalone/*.test.mjs` 单元测试全绿
- [ ] `node --check` 通过（改动的 .mjs/.js 文件）
- [ ] 本地起服务冒烟：`npm run standalone` → 127.0.0.1:18790
- [ ] 改了 `obs-folia/`：已 `npm run build` 并提交构建产物
- [ ] 改了服务端模块或 Android 白名单相关：已说明 `syncQsyyRuntime` 白名单是否需要同步
- [ ] 改了桌面壳依赖的 `server.mjs` 布局：已验证桌面壳能启动

## AI 辅助声明

<!-- 披露使用的模型可选（如：部分代码由 Claude 辅助生成），但下面这条必须勾选。 -->

- [ ] 我已逐行读懂并本地验证全部改动，对提交内容负全责
