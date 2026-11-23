# 第三方声明与许可

本文件说明本项目复用或参考的第三方实现，以及主要运行时依赖的许可归属。本项目自身的许可见 [LICENSE](LICENSE)；第三方部分保留各自的版权与许可。

## dsh-connect-workbuddy (MIT)

来源：[dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy) · [上游许可证](https://github.com/dingminhua/dsh-connect-workbuddy/blob/main/LICENSE)。

版权：`Copyright (c) 2026 LaoDing`。本项目复用或参考的范围包括：

- **样式规则**：[client.js](client.js) 中的 `CSS` 常量采用了该项目的卡片、分栏标签、账号表格网格与行间距、开关行、模型行双行布局及字号规则，并使用本项目的 `dca-` 类名前缀；相关注释也保留了设计理由。
- **界面结构**：统一的批量签到入口，集中放置的账号添加、导入与导出操作，以及通过 `accent-color` 设置主题色的原生复选框。

## dsh-connect-madao (MIT)

来源：[dsh-connect-madao](https://github.com/XLNC-L/dsh-connect-madao) · [上游许可证](https://github.com/XLNC-L/dsh-connect-madao/blob/main/LICENSE)。

版权：`Copyright (c) 2026 XLNC-L`。本项目 [src/credentials.ts](src/credentials.ts) 中读取本机码道客户端登录态的实现采用了该项目的方法，包括：

- 从 `state.vscdb` 中以 `"id":"huawei-cloud-authentication"` 为锚点，在固定窗口内提取凭证字段。
- 凭证字段名（`accessKey`、`secretKey`、`securityToken`、`expiresAt`、`originData.account.label`）与候选文件路径。
- 跳过剩余有效期不足五分钟的临时令牌。

## 运行时依赖

当前构建通过 TypeScript 编译输出，不把运行时依赖合并进 `dist/`。以下依赖由包管理器或宿主提供，许可文本随各自安装包保留：

| 组件 | 关系 | 许可与版权 |
| --- | --- | --- |
| `@deepseek-ai/schemastery` | 直接依赖 | MIT · Copyright (c) 2021-present Shigma |
| `@deepseek-ai/cosmokit` | `schemastery` 的传递依赖 | MIT · Copyright (c) 2021-present Shigma |
| `@standard-schema/spec` | `schemastery` 的传递依赖 | MIT · Copyright (c) 2024 Colin McDonnell |
| `@deepseek-ai/dsh-llm` | 可选宿主对等依赖（peer dependency） | MIT · Copyright (c) 2026 DeepSeek |

直接依赖与兼容范围见 [package.json](package.json)；实际版本及完整依赖关系以安装结果为准。本表不包含开发工具依赖，也不替代各依赖包内的许可文本。

## 上述复用部分的 MIT 许可原文

以下许可文本适用于前述 `dsh-connect-workbuddy` 与 `dsh-connect-madao` 的复用部分，保留两位上游版权人的声明。

```
MIT License

Copyright (c) 2026 LaoDing
Copyright (c) 2026 XLNC-L

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
