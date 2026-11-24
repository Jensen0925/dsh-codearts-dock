# 运行环境与兼容范围

这个插件由 DeepSeek Harness 加载；Harness 负责提供宿主运行时和可选的 LLM 适配器。下面的范围描述了包元数据声明和本仓库能自动验证的边界，不能替代对具体 Harness 安装的实测。

| 维度 | 声明或验证范围 | 说明 |
| --- | --- | --- |
| Node.js | `^22.19.0 || >=24.9.0` | `package.json` 的 `engines.node`；CI 和发布流程固定使用 Node 24.9.0。 |
| Harness LLM 适配器 | `@deepseek-ai/dsh-llm >=0.1.7-rc.1 <0.3.0-0` | 包的可选 peer dependency；当前锁文件解析到 `0.1.7-rc.2`。 |
| Harness 主机集成 | 由 `DSH_INSTALL_DIR` 指定 | 设置该变量后运行 `tests/assembler.test.ts` 和 `tests/market-index.test.ts`；未设置时这两类测试会跳过主机专属断言。 |
| 普通离线检查 | Node 24.9.0 + pnpm 10 | 类型检查、构建、协议/账号/UI 测试、入口导入、隐私扫描均在 CI 中执行。 |

当前仓库没有把某个 Harness 应用版本标记为“逐版本兼容”。升级 Harness 后，请在对应环境设置 `DSH_INSTALL_DIR`，运行 `pnpm run typecheck && pnpm test`，并记录实际 Harness 版本和结果，再更新本表。上游版本可能提高 Node 下限；以宿主发布说明和本插件的 `engines.node` 为准。

最后核对日期：2026-11-24。
