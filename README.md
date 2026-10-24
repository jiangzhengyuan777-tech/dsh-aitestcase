# dsh-aitestcase

> DeepSeek Harness 的 **AI 测试设计插件**：需求 → 测试 PRD → 测试点 → 测试用例 → 质检评审，全部在 DSH 进程内完成。

**自包含**：不需要 Python、不需要单独开后端服务、不需要第二个 API Key、不占额外端口。
装上就是完整能力，产出自动落盘，设置页即时可调。

[![DSH](https://img.shields.io/badge/DeepSeek%20Harness-plugin-blue)](https://github.com/jiangzhengyuan777-tech/dsh-aitestcase)
[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![Tests](https://img.shields.io/badge/tests-90%20passing-brightgreen)](./test)

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
| `aitestcase_evaluate` | AI 辅助评审：覆盖率、边界、异常、安全打分 + 缺口/建议（结论需人工复核） | JSON |
| `aitestcase_history` | 读取本会话此前的生成结果，做增量修改 | Markdown |
| `aitestcase_status` | 自检：模型连通、模板完整、产物目录 | Markdown |

推荐链路：

```
需求 ──testprd──▶ 测试 PRD ──testpoints──▶ 测试点 ──testcases──▶ 用例 ──evaluate──▶ 质检报告
```

## 界面

- **设置 → 测试设计**：插件自带一页说明界面，包含推荐流程、工具能力表、常用提示词
  （可一键复制）、配置项表、产物与排错说明。用 DSH 主题变量绘制，浅色/深色自适应。
- **插件配置表单**：12 个配置项（模型路由、温度、输出上限、上下文预算、重试、产物目录等）
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
- **整体上下文预算**：`maxInputChars` 管的是「模板 + 历史 + 本次输入」的总量；模板永不截断，
  历史先生效裁剪，输入最后按剩余预算截断并在结果里注明用量。
- **瞬时故障重试**：限流 / 超时 / 5xx / 空响应按指数退避自动重试（默认 2 次），致命错误不重试。
- **长任务后台化**：四个重型工具支持 `background=true`，立即返回 job id，用 `job_output` 取结果、
  `job_kill` 取消；环境没有任务注册表时自动降级为同步执行。
- **评审 JSON 可靠**：评审结果自动提取/规范化；无法解析时追加一次最小修复调用，
  仍失败则原样返回并明确标注，绝不静默失败。

## 验证

| 项 | 结果 |
|---|---|
| 单元测试 | **90 / 90 通过**（工具逻辑、预算、重试、后台任务、JSON 修复、prompt 契约、配置 schema、客户端渲染、文件输入、错误路径） |
| 安装 | `application: applied`，桌面 profile 热挂载 |
| 模型连通 | `aitestcase_status(probe=true)` → `OK` |
| 真实生成（GUI 内） | 测试点 30 条 + 16 个待确认问题；表格用例 20 条；YAML 用例；质检 JSON（score 38、17 缺口、5 逻辑问题、12 建议） |
| 真实生成（独立 headless 进程） | 文件输入 → 测试点 20 条 → 表格用例 25 条，产物路径正确 |
| 链路验证 | 测试点自动继承、会话延续、取消传播、落盘均实测通过 |
| 真实生成（headless v1.1.0） | testprd → testpoints → testcases(table/yaml) → evaluate 全链路：规则/待确认分离、ready/blocked 状态、11 条用例、合法 JSON 报告 |
| 上下文预算（实测） | 预算 3000 字符：模板 1521 + 输入 1479 = 3000/3000，截断提示与「上下文用量」行完整 |
| 后台任务（实测） | `background=true` 立即返回 `aitestcase-1`；`job_output` 读到 `running（调用模型…）`，随后 `completed` 且结果含落盘路径 |
| 自检（v1.1.0） | 7/7 模板、预算/重试/JSON 修复/后台任务四项配置可见，`probe=true` → `OK` |

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
| `maxInputChars` | `60000` | 整次请求字符预算：模板 + 历史 + 输入 |
| `historyShare` | `0.35` | 剩余预算中历史可占比例（0–1） |
| `maxRetries` | `2` | 瞬时故障重试次数（0 关闭） |
| `retryBaseMs` | `800` | 重试退避基数（毫秒） |
| `jsonRepair` | `true` | 评审输出不是合法 JSON 时追加一次修复调用 |

## 开发

```sh
node --test        # 90 个单元测试，打桩 LLM，不真调模型
```

```
lib/
├── index.js      运行时入口（name / inject / Config / apply）
├── tools.js      六个工具与编排
├── prompts.js    模板加载 + 标签式输入组装 + 历史块裁剪
├── budget.js     整次请求的上下文预算分配
├── json.js       评审 JSON 提取 / 规范化 / 修复
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
- 后台任务用防御式 `ctx.jobs` 访问（不写进 `inject`）：profile 没有任务注册表时插件照常加载，只是降级同步。
- 上下文预算按「模板 > 历史 > 输入」的优先级分配，保证任务契约永不被裁剪。

## 与 AITestCase 的关系

生成与评估的 prompt 模板（`assets/prompts/`）内联自
[AITestCase](https://github.com/LiuYuan0115/AITestCase)（MIT, Copyright (c) 2026 LiuYuan0115），
见 [LICENSE.aitestcase](./LICENSE.aitestcase)。本项目把它的 HTTP 后端替换为 DSH 进程内模型调用。

**不包含**原后端的：向量库历史检索、文档库指针、PDF/图片 OCR、Figma 解析、UI 自动化执行。

**已知边界**：超长需求（超过 `maxInputChars` 且模板本身较大时）仍是单次调用，需要手动拆分或调高预算；
本插件不做分块 map-reduce。

## License

[MIT](./LICENSE)
