# 发布与插件索引

包名：`dsh-codearts-dock`。仓库：[Jensen0925/dsh-codearts-dock](https://github.com/Jensen0925/dsh-codearts-dock)。

## 给使用者

### GitHub

在 Harness 插件管理页使用 Git 仓库地址安装：

```text
https://github.com/Jensen0925/dsh-codearts-dock.git
```

### npm

npm 发行包名为 `dsh-codearts-dock`。包是否已发布、可用版本和发布时间，以 [npm 页面](https://www.npmjs.com/package/dsh-codearts-dock) 的实际记录为准。

### 自定义插件索引

支持格式 1 自定义索引的 Harness 版本，可启用「自定义插件索引」，在「插件 → 发现」的索引源中添加：

```text
https://raw.githubusercontent.com/Jensen0925/dsh-codearts-dock/main/market-index.json
```

该索引由本项目维护，提供固定 Git 提交的安装目标，即使 npm 尚未发布也可使用 Git 来源。索引发布不等于被官方或其他社区市场收录，不代表官方审核、安全认证或推荐。

### 社区市场

社区目录 [awesome-deepseek-harness-plugins](https://github.com/imsai-sh/awesome-deepseek-harness-plugins) / [DSH 1024 Store](https://deepseek1024.com/) 有独立的收录流程。可按其 [贡献说明](https://github.com/imsai-sh/awesome-deepseek-harness-plugins/blob/main/CONTRIBUTING.md) 提交 `catalog/plugins/*.json` 条目，并给仓库添加 `dsh-plugin` topic。提交、审核合并和网站同步是不同阶段，以对应 PR 及市场页面为准。

## 给维护者

1. 更新版本、README、免责声明、安全说明和多语言元数据。
2. 执行 `npm test` 与 `npm run check:release`。
3. 执行 `npm pack --dry-run`，检查包内文件，再生成并检查实际 tarball。不得包含账号、令牌、本机笔记、导出或备份。
4. 将验证后的源码提交、推送到 GitHub，为发行提交创建版本标签。
5. 确认 npm 登录身份后执行 `npm publish --access public --registry=https://registry.npmjs.org/`。如要求 2FA，由维护者在官方流程中完成认证；不要把令牌提交到仓库。
6. 使用 `node scripts/build-market-index.mjs <40位发行提交SHA>` 更新固定提交索引，再推送索引。
7. 核实 npm 的具体版本和索引安装目标，并按需提交社区目录收录申请。

本仓库保留 `dsh-connect-codearts` 本机配置目录和内部设置标识，模型 provider 仍为 `codearts`，以兼容已有配置。请勿同时启用新旧两个包。
