# 变更日志

记录 CodeArts Dock 的重要变化。准备发行时，将本节内容整理到对应版本条目。

## [Unreleased]

### 变更

- 离线测试套件迁移到 TypeScript，并统一使用 Vitest。
- 版本号只在发行时升级；推送匹配的 `vX.Y.Z` 标签后，由 GitHub Actions 发布 npm。
