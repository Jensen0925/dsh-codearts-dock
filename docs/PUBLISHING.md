# 发布与插件索引

包名：`dsh-codearts-dock`。仓库：[Jensen0925/dsh-codearts-dock](https://github.com/Jensen0925/dsh-codearts-dock)。

## 给使用者

### GitHub

在 Harness 插件管理页使用 Git 仓库地址安装：

```text
https://github.com/Jensen0925/dsh-codearts-dock.git
```

### npm

在 Harness 插件管理页的安装入口输入包名：

```text
dsh-codearts-dock
```

已发布版本与时间以 [npm 页面](https://www.npmjs.com/package/dsh-codearts-dock) 的实际记录为准。请通过 Harness 的插件管理安装；在任意目录单独运行 `npm install` 只会安装文件，不会启用插件。

### 自定义插件索引

支持格式 1 自定义索引的 Harness 版本，可启用「自定义插件索引」，在「插件 → 发现」的索引源中添加：

```text
https://raw.githubusercontent.com/Jensen0925/dsh-codearts-dock/main/market-index.json
```

索引条目使用 npm 来源，安装目标就是 `dsh-codearts-dock@<版本>`，与上面直接输包名安装的是同一份发布包；条目记录的发布时间来自 registry，不是本地生成索引的那一天。索引由本项目维护，发布不等于被官方或其他社区市场收录，不代表官方审核、安全认证或推荐。

### 社区市场

社区目录 [awesome-deepseek-harness-plugins](https://github.com/imsai-sh/awesome-deepseek-harness-plugins) / [DSH 1024 Store](https://deepseek1024.com/) 有独立的收录流程。可按其 [贡献说明](https://github.com/imsai-sh/awesome-deepseek-harness-plugins/blob/main/CONTRIBUTING.md) 提交 `catalog/plugins/*.json` 条目，并给仓库添加 `dsh-plugin` topic。提交、审核合并和网站同步是不同阶段，以对应 PR 及市场页面为准。

## 给维护者

发布由 GitHub Actions 完成，本地不需要、也不应该保存 npm 发布令牌。

### 一次性的首次配置

`dsh-codearts-dock` 已在 registry 上，先把发布权交给仓库工作流（需要本人在终端交互完成，含 2FA）：

```bash
npm login --registry=https://registry.npmjs.org/
npm trust github dsh-codearts-dock --file release.yml --allow-publish --registry=https://registry.npmjs.org/
npm trust list dsh-codearts-dock --registry=https://registry.npmjs.org/   # 确认已绑定，permissions 应为 publish
```

三个参数容易写错，都会直接失败：

- `--file` 只写**文件名**（`release.yml`），不能写 `.github/workflows/release.yml` 这样的路径，
  否则报 `GitHub Actions workflow must be just a file not a path`；
- `--allow-publish` 必填，否则报 `At least one permission flag is required`。
  漏掉权限标志时**绑定不会建立**，之后 CI 发布会以匿名身份被拒（`404 Not Found - PUT`）。
- `--registry=https://registry.npmjs.org/` 必须显式写。国内常用内网镜像
  （如 `registry=http://10.x.x.x/.../npm-group/`），`npm config` 的默认值会直接接管，
  于是 `npm trust` 把这些请求**发给镜像**——镜像不支持 trusted publishing，回
  `400 Bad Request - POST http://10.x.x.x/.../trust`。注意 `npm login` 带了 `--registry`
  并不会改变后续命令的默认值：登录状态是对的，但 `npm trust` 仍会走镜像。

先加 `--dry-run` 可以只校验、不落盘。**看输出末尾的链接判断打到了哪个 registry**：
正确时显示 `https://www.npmjs.com/package/dsh-codearts-dock`，
打到镜像时会出现 `may not support trusted publishing` 警告：

```bash
npm trust github dsh-codearts-dock --file release.yml --allow-publish --dry-run --registry=https://registry.npmjs.org/
```

绑定之后，`.github/workflows/release.yml` 用 OIDC 短时令牌发布，并附带 provenance 签名。这是 npm 正在推进的方向：绕过 2FA 的长期令牌将在 2027 年 1 月起不再能直接发布。绑定完成后可以删掉 `~/.npmrc` 里的 `//registry.npmjs.org/:_authToken=`。

### 版本号与 npm 发布

普通提交不修改版本号，也不会发布 npm。版本号只在准备发行时升级；发布提交使用 `chore: release vX.Y.Z`，并把 `package.json` 更新到同一个版本。推送匹配的 `vX.Y.Z` 标签后，`.github/workflows/release.yml` 才会运行发布任务；推送 `main` 只运行 CI。手动运行 Release workflow 默认是 dry run。

版本规则见 [提交与版本规则](COMMITS.md)。这套流程与参考项目一致：发布动作由维护者明确发起，普通开发提交不会变成 npm 版本。

### 每次发布

1. 将 `CHANGELOG.md` 的 `[Unreleased]` 内容整理到新版本条目，再运行 `node scripts/release.mjs 1.4.0` 更新 `package.json`。版本号必须高于当前版本。
2. 检查 `pnpm test`、`pnpm run check:release`、`pnpm run check:package` 和 `pnpm pack` 的输出，确认包内不含账号、令牌、本机笔记、导出或备份。
3. 提交并推 tag：

   ```bash
   git add package.json CHANGELOG.md && git commit -m "chore: release v1.4.0"
   git tag -a v1.4.0 -m "v1.4.0" && git push origin main --follow-tags
   ```

   tag 触发 `.github/workflows/release.yml`：它先校验 tag 与 `package.json` 版本一致、离线测试全绿、该版本尚未存在，然后发布。
   **确认它真的成功了再往下走**（`gh run list --workflow=release.yml --limit 1`）。
   tag 一旦推出就不会因为发布失败而回滚，重跑同一个 run 即可；
   若 tag 指向的提交本身有问题，就修好、升版本、再打新 tag——已存在的版本号不能复用。
4. 发布完成后重钉索引，让「发现」页指向刚发布的版本及真实发布时间：

   ```bash
   node scripts/release.mjs --repin
   git add market-index.json && git commit -m "chore: repin index for v1.4.0" && git push
   ```

   这步在版本尚未出现在 registry 时会拒绝并列出已发布版本——那说明第 3 步没成功，不是索引脚本的问题。索引重钉提交沿用已发布版本号，不会再次触发 npm 发布。

5. 核实 npm 上的具体版本和索引里的安装目标，并按需提交社区目录收录申请。

`main` 分支的每次推送都会跑 `.github/workflows/ci.yml`（冻结依赖安装、类型检查、离线测试、入口与隐私检查、发布元数据和打包清单），它不发布任何东西。

1.1.0 及更早版本的包名是 `dsh-connect-codearts`，配置目录与内部标识也是这个名字。从 1.2.0 起统一为 `dsh-codearts-dock`：配置目录、loader 行 id、HTTP 路由前缀、客户端槽位 id 和备份格式 id 全部改名，读取侧保留对旧目录、旧设置命名空间与旧备份格式的兼容，升级不丢账号和偏好。模型 provider 仍为 `codearts`。不要同时启用新旧两个包——两者会注册同一个 provider 路由。
