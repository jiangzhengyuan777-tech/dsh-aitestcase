# dsh-aitestcase

> DeepSeek Harness 的 **AI 测试设计插件**：需求 → 测试 PRD → 测试点 → 测试用例 → 质检评审，全部在 DSH 进程内完成。

**自包含**：不需要 Python、不需要单独开后端服务、不需要第二个 API Key、不占额外端口。
装上就是完整能力，产出自动落盘，设置页即时可调。

[![DSH](https://img.shields.io/badge/DeepSeek%20Harness-plugin-blue)](https://github.com/LiuYuan0115/AITestCase)
[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![Tests](https://img.shields.io/badge/tests-32%20passing-brightgreen)](./test)

---

## 快速开始

在 DSH 中安装（桌面版 profile 由 Electron 独占，只能用 `plugin_manager`）：

```
plugin_manager install_bundle target=<本仓库绝对路径>
```

返回 `"application": "applied"` 后，直接在对话里说：

```
用 aitestcase_testprd 把下面这段需求整理成测试 PRD，先列出明确规则和待确认问题：
（粘贴需求）
```

完整操作手册见 **[USAGE.md](./USAGE.md)**。

## 提供什么

六个面向模型的工具，覆盖从需求到评审的完整闭环：

| 工具 | 作用 | 输出 |
|---|---|---|
| `aitestcase_testprd` | 需求 → 测试 PRD（补全未定义规则、待确认问题、验收标准） | Markdown |
| `aitestcase_testpoints` | PRD/需求 → 测试点清单（功能/边界/异常/集成） | Markdown |
| `aitestcase_testcases` | 测试点 + PRD → 测试用例 | `xmind` / `table` / `yaml` |
| `aitestcase_evaluate` | 对抗式质检：覆盖率、边界、异常、安全打分 + 缺口/建议 | JSON |
| `aitestcase_history` | 读取本会话此前的生成结果，做增量修改 | Markdown |
| `aitestcase_status` | 自检：模型连通、模板完整、产物目录 | Markdown |

推荐链路：

```
需求 ──testprd──▶ 测试 PRD ──testpoints──▶ 测试点 ──testcases──▶ 用例 ──evaluate──▶ 质检报告
```

## 界面

- **设置 → 测试设计**：插件自带一页说明界面，包含推荐流程、工具能力表、常用提示词
  （可一键复制）、配置项表、产物与排错说明。用 DSH 主题变量绘制，浅色/深色自适应。
- **插件配置表单**：8 个配置项（模型路由、温度、输出上限、产物目录、历史轮数等）
  注册为 schemastery 即时字段，改完保存下一次调用即生效，无需重启。

## 特性

- **纯本地编排**：`ctx.llm.stream()` 直接调用 DSH 已配置的模型，不引入第二个进程或密钥。
- **标签式输入协议**：与 AITestCase 原 `/api/ask` 一致（`[优化后PRD]`、`[测试点]`、`[补充说明]`）。
- **测试点自动继承**：调用 `aitestcase_testcases` 不传测试点时，自动把本会话最近的测试点
  经模板协议槽位传入，不重复塞进上下文。
- **防复述**：历史上下文有明确措辞约束，避免模型"续写上一份文档"而不是产出新结果。
- **文件输入**：`requirementFile` / `testcasesFile` / `prdFile` 支持直接读工作区文件。
- **产物落盘**：每次生成独立 Markdown 文件，不覆盖历史，可被普通文件工具继续编辑。
- **可取消**：工具执行信号贯通到模型调用，打断对话即取消。

## 验证

| 项 | 结果 |
|---|---|
| 单元测试 | **32 / 32 通过**（工具逻辑、配置 schema、客户端页面渲染、文件输入、错误路径） |
| 安装 | `application: applied`，桌面 profile 热挂载 |
| 模型连通 | `aitestcase_status(probe=true)` → `OK` |
| 真实生成（GUI 内） | 测试点 30 条 + 16 个待确认问题；表格用例 20 条；YAML 用例；质检 JSON（score 38、17 缺口、5 逻辑问题、12 建议） |
| 真实生成（独立 headless 进程） | 文件输入 → 测试点 20 条 → 表格用例 25 条，产物路径正确 |
| 链路验证 | 测试点自动继承、会话延续、取消传播、落盘均实测通过 |

> 注：桌面版对已安装插件的 **JS 代码改动需要重启应用**才生效（官方限制）；
> 配置改动是即时的。

## 配置

| 键 | 默认值 | 说明 |
|---|---|---|
| `provider` | `deepseek-official` | 模型提供方路由 |
| `model` | `deepseek-flash` | 生成与评估使用的模型 |
| `temperature` | `0` | 采样温度（测试设计建议 0） |
| `maxTokens` | `20000` | 单次输出上限 |
| `outputDir` | `.aitestcase` | 产物目录，相对路径按会话工作目录解析 |
| `saveArtifacts` | `true` | 是否落盘 |
| `historyRounds` | `4` | 延续上下文轮数，`0` 关闭 |
| `maxInputChars` | `60000` | 单次输入字符上限 |

## 开发

```sh
node --test        # 32 个单元测试，打桩 LLM，不真调模型
```

```
lib/
├── index.js      运行时入口（name / inject / Config / apply）
├── tools.js      六个工具与编排
├── prompts.js    模板加载 + 标签式输入组装
├── llm.js        ctx.llm.stream 调用 + StreamChunk 折叠
├── session.js    按 Session 的生成历史（WeakMap）
├── artifacts.js  cwd 解析 + 产物落盘
├── files.js      文件输入
├── options.js    配置解析（无宿主依赖，可单测）
├── config.js     schemastery 配置 schema
└── client.js     浏览器半边（设置页）
```

设计取舍：

- `lib/index.js` 是唯一 import `@deepseek-ai/schemastery` 的模块，工具逻辑保持零宿主依赖，
  因此能在裸 Node 下跑完整单测。
- 浏览器半边是客户端模块系统的 lazy-CJS factory（`window.__ModuleLoader__.load`），
  不依赖构建工具，`require('react')` 由页面运行时提供。
- 工具不声明 `timeoutMs`：不触发统一的工具超时策略，长生成不会被砍断，用户可随时打断。

## 与 AITestCase 的关系

生成与评估的 prompt 模板（`assets/prompts/`）内联自
[AITestCase](https://github.com/LiuYuan0115/AITestCase)（MIT, Copyright (c) 2026 LiuYuan0115），
见 [LICENSE.aitestcase](./LICENSE.aitestcase)。本项目把它的 HTTP 后端替换为 DSH 进程内模型调用。

**不包含**原后端的：向量库历史检索、文档库指针、PDF/图片 OCR、Figma 解析、UI 自动化执行。

## License

[MIT](./LICENSE)
