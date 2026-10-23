# dsh-aitestcase 使用手册

面向测试工程师的操作手册。看完这一篇就能把「需求 → 测试点 → 测试用例 → 质检评审」
整条链路跑起来。

---

## 1. 它是什么

一个装进 DeepSeek Harness（DSH）的测试设计插件。装上之后，你可以在对话框里直接
说「帮我把这份需求拆成测试点」，插件会调用内置的测试设计 prompt 与模型，产出：

- 测试 PRD（补全未定义规则、列出待确认问题、给验收标准）
- 测试点清单（验证要点，不含步骤与数据）
- 测试用例（xmind 层级 / Markdown 表格 / YAML 三种格式）
- 质检报告（评分、覆盖缺口、逻辑问题、风险点、补充用例）

**不依赖任何外部服务**：没有 Python 后端、没有额外端口、不需要第二份 API Key。
它直接使用 DSH 已配置好的模型账号，在 DSH 进程内完成全部工作。

---

## 2. 安装

在 DSH 里让 agent 执行（桌面版 profile 由 Electron 独占，不能用 `dsh plugin` 命令改）：

```
plugin_manager install_bundle target=<本插件目录的绝对路径>
```

返回 `"application": "applied"` 即安装成功，插件会热挂载到当前会话。

安装后在两处可见：

- **对话里**：多了 6 个 `aitestcase_*` 工具，模型会自动调用，你也可以点名。
- **设置里**：设置 → **测试设计** 页，有完整的能力说明、常用提示词和配置项表格。

> 首次安装后如果设置页没出现新条目，按一次刷新（F5）即可。
> 桌面版对已安装插件的 **JS 代码改动需要重启应用** 才生效；只改配置不需要。

卸载：

```
plugin_manager remove_bundle target=dsh-aitestcase
```

---

## 3. 三种典型用法

### 3.1 从需求到用例（最常用）

直接把需求粘进对话：

```
用 aitestcase_testprd 把下面这段需求整理成测试 PRD，先列出明确规则和待确认问题，
不要替未定义规则编造预期结果。

（粘贴需求）
```

拿到 PRD 后继续：

```
基于这份 PRD，先调用 aitestcase_testpoints 提取测试点，再调用 aitestcase_testcases
生成 xmind 层级用例，优先级只保留 P0/P1。
```

也可以一句话全自动：

```
把 examples/sample-prd.md 这份需求走完测试设计全流程：
PRD → 测试点 → 表格用例 → 质检，最后只汇总结果路径和问题清单。
```

### 3.2 直接评审一份现有用例

```
用 aitestcase_evaluate 对下面这份用例做对抗式评审，重点看边界值、异常路径和安全性，
给出评分、漏测点、逻辑问题和补充用例。

（粘贴用例，或给 testcasesFile 路径）
```

### 3.3 基于上一版改

```
看完质检报告，基于上一版用例补充 P0 级边界用例，其它保持不变。
```

插件会把本会话前几轮结果作为延续上下文（可用 `historyRounds` 调），
也可以显式读取：

```
先调用 aitestcase_history 把上一版用例取出来，只改第 3 条。
```

---

## 4. 工具参考

所有工具都不需要外部服务，输入超过上限会被截断并在结果里注明。

### `aitestcase_testprd`

| 参数 | 必填 | 说明 |
|---|---|---|
| `requirement` | 二选一 | 需求原文 |
| `requirementFile` | 二选一 | 需求文件路径（`.md` / `.txt`），相对路径按会话工作目录解析 |
| `instruction` | 否 | 补充说明，如「重点覆盖并发」「按 P0/P1 分级」 |

产出：测试 PRD（明确规则表 + 待确认问题 + 可测验收标准）。

### `aitestcase_testpoints`

参数同上（`requirement` / `requirementFile` / `instruction`）。

产出：测试点清单，按功能 / 边界 / 异常 / 集成分类，每条可追溯回 PRD 规则编号。
**未定义规则只列待确认问题，不编造预期结果。**

### `aitestcase_testcases`

| 参数 | 必填 | 说明 |
|---|---|---|
| `requirement` | 二选一 | PRD / 需求原文 |
| `requirementFile` | 二选一 | 需求文件路径 |
| `testpoints` | 否 | 测试点文本；不传时会**自动继承本会话最近一次的测试点产出** |
| `testpointsFile` | 否 | 测试点文件路径 |
| `format` | 否 | `xmind`（默认，H1–H6 层级，可直接导入 XMind）/ `table`（Markdown 表格）/ `yaml`（结构化，便于程序消费） |
| `instruction` | 否 | 补充说明 |

### `aitestcase_evaluate`

| 参数 | 必填 | 说明 |
|---|---|---|
| `testcases` | 二选一 | 待评审用例全文 |
| `testcasesFile` | 二选一 | 用例文件路径 |
| `prd` / `prdFile` | 否，但强烈建议 | 对应 PRD，用于判断覆盖度 |
| `reference` | 否 | 参考规范 / 历史用例 |

产出：JSON 报告，含 `score`（0–100）、`coverage_gap`、`logic_issues`、
`duplicates`、`suggestions`、`risk_points`、`supplementary_cases`。

### `aitestcase_history`

| 参数 | 说明 |
|---|---|
| `limit` | 返回条数，默认 3，最大 10 |
| `type` | 按类型过滤，如 `测试点`、`测试用例`、`用例质检评估` |
| `full` | `true` 返回完整正文，默认只给摘要 |

### `aitestcase_status`

| 参数 | 说明 |
|---|---|
| `probe` | `true` 时真的向模型发一次极小的请求（约几十 token）验证连通性 |

自检内容：插件是否加载、模型路由、7 份 prompt 模板是否齐全、产物目录、配置、会话历史条数。
**遇到任何异常，先跑一次 `aitestcase_status`（可带 `probe=true`）。**

---

## 5. 推荐工作流

```
① 需求 / PRD 原文
      │  aitestcase_testprd
      ▼
② 测试 PRD（明确规则 + 待确认问题）
      │  aitestcase_testpoints
      ▼
③ 测试点清单
      │  aitestcase_testcases（format 三选一）
      ▼
④ 测试用例
      │  aitestcase_evaluate
      ▼
⑤ 质检报告 → 补测 / 回填待确认问题
```

实践建议：

1. **先澄清再加用例。** 插件会主动把未定义规则列成待确认问题；先推动产品确认，
   比让模型猜要可靠得多。
2. **PRD 是所有下游步骤的唯一事实来源。** 测试点只用于覆盖约束，不会引入新需求。
3. **用例格式按用途选**：`xmind` 给人看和评审；`table` 贴进飞书 / Excel；
   `yaml` 给自动化脚本或平台消费。
4. **质检报告要当输入用。** `supplementary_cases` 与 `coverage_gap` 直接拿去补用例，
   比重新生成一轮更省 token。

---

## 6. 配置

全部配置项都是**即时生效**的：在「插件」页本插件的配置表单里改完保存，下一次工具调用
就用新值，不需要重启。

| 键 | 默认值 | 说明 |
|---|---|---|
| `provider` | `deepseek-official` | 模型提供方路由 |
| `model` | `deepseek-flash` | 生成与评估使用的模型 |
| `temperature` | `0` | 采样温度；测试设计建议保持 0 |
| `maxTokens` | `20000` | 单次生成输出上限；用例生成建议 ≥ 16000 |
| `outputDir` | `.aitestcase` | 产物目录，相对路径按会话工作目录解析 |
| `saveArtifacts` | `true` | 是否把每次生成落盘 |
| `historyRounds` | `4` | 回灌本会话前几轮结果做延续上下文，`0` 关闭 |
| `maxInputChars` | `60000` | 单次输入字符上限，超出截断并注明 |

也可以直接改 profile 的 `cordis.patch.yml` 里 `id: aitestcase` 那一行的 `config`。

---

## 7. 产物文件

每次成功生成都会落盘一份 Markdown（评估结果是 JSON）：

```
<会话工作目录>/.aitestcase/
├── testpoint-20261023-182740.md
├── testcase-table-20261023-182825.md
├── testcase-yaml-20261023-181822.md
└── evaluate-20261023-181838.md
```

- 文件名 = 类型 + 时间戳，不会覆盖历史。
- 落盘失败不影响返回结果，只是结果里少一行「已保存」。
- 会话历史（`aitestcase_history`）只存在内存里，**不跨会话、不跨进程重启**；
  要长期保留就依赖这些文件。

---

## 8. 故障排查

| 现象 | 处理 |
|---|---|
| 设置页没有「测试设计」 | 刷新页面（F5）；仍没有则确认安装返回 `applied` |
| 工具调用报「模型调用失败」 | `aitestcase_status` 带 `probe=true` 检查模型路由与账号 |
| 报「模型返回了空结果」 | 通常是模型侧限流或超时，重试一次；仍失败就换 `model` |
| 报「XX 不存在或无法访问」 | `requirementFile` 路径不对；相对路径按会话工作目录解析，可用绝对路径 |
| 生成结果在复述上一轮内容 | 调高 `historyRounds` 更糟，应明确说「本次只输出新的用例」；或把 `historyRounds` 设 0 |
| 用例太长被截断 | 调高 `maxTokens`；或分模块、分批次生成 |
| 改了 JS 代码没生效 | 桌面版需要重启应用才能加载新的 JS 模块 |

---

## 9. 能力边界

**包含**：需求分析、测试点、三种格式用例、对抗式质检、会话内增量修改、产物落盘、文件输入。

**不包含**（原 AITestCase 项目才有）：向量库历史检索、文档库指针管理、PDF/图片 OCR、
Figma 解析、UI 自动化执行（Midscene）。需要这些时，原项目仍可单独运行：
<https://github.com/LiuYuan0115/AITestCase>

**数据流向**：需求文本会随模型请求发送到你配置的模型提供方（默认 DeepSeek 官方 API），
不经过任何第三方中转服务。产物文件只写在本机工作目录。

**成本**：一次测试点约 3k 输入 / 4k 输出 token，一次表格用例约 5k / 2k。
单次生成上限由 `maxTokens` 控制。

---

## 10. 开发与测试

```sh
cd dsh-aitestcase-plugin
node --test          # 32 个单元测试：工具逻辑、配置 schema、客户端页面、文件输入
```

目录结构：

```
dsh-aitestcase-plugin/
├── lib/
│   ├── index.js      运行时入口（name / inject / Config / apply）
│   ├── tools.js      六个工具与编排
│   ├── prompts.js    模板加载 + 标签式输入组装
│   ├── llm.js        ctx.llm.stream 一次性调用 + StreamChunk 折叠
│   ├── session.js    按 Session 的生成历史（WeakMap）
│   ├── artifacts.js  cwd 解析 + 产物落盘
│   ├── files.js      文件输入读取
│   ├── options.js    配置解析（无宿主依赖，可单测）
│   ├── config.js     schemastery 配置 schema
│   └── client.js     浏览器半边（设置页）
├── assets/prompts/   AITestCase 的 prompt 模板（MIT，见许可证）
├── cordis.patch.yml  组合包 patch 层
└── test/             单元测试
```

代码改动后重新安装并重启桌面应用即可加载新版本：

```
plugin_manager remove_bundle target=dsh-aitestcase
plugin_manager install_bundle target=<插件目录绝对路径>
```
