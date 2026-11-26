# 提交与版本规则

普通提交只遵循 Conventional Commits，不需要修改 `package.json` 的版本号。提交类型用于说明改动性质：

- `feat`：新增用户可见能力；
- `fix`：修复问题；
- `docs`：只修改文档；
- `test`：只修改测试；
- `refactor`、`perf`、`chore`：重构、性能改进或维护工作。

版本号只在准备发布时升级。发布时先把 `CHANGELOG.md` 的 `[Unreleased]` 内容归入对应版本，再用 `node scripts/release.mjs X.Y.Z` 更新 `package.json`。发布提交使用 `chore: release vX.Y.Z`，其中清单版本必须与提交主题完全一致，并且高于上一个版本：

```bash
node scripts/release.mjs X.Y.Z
```

提交钩子只检查提交信息格式；发布工作流会检查发布提交的版本号、`vX.Y.Z` tag 和 `package.json` 是否一致。普通提交不会自动发布 npm，完整流程见 [PUBLISHING.md](PUBLISHING.md)。
