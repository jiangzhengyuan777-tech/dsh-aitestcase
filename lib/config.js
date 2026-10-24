// Plugin configuration schema.
//
// This is the ONLY module that imports @deepseek-ai/schemastery. The harness
// uses it twice: Cordis validates the loader-row config through it, and the
// Plugins page generates a live Config form from it. Keeping it out of the tool
// modules means the tool logic stays testable without host modules.
//
// Every field is `.volatile()` so the form serves it and an edit commits live
// instead of remounting the plugin. Volatile values may arrive as references
// (`.get()`), plain data (defaults), or nothing at all — ./options.js unwraps
// all three shapes.

import z from '@deepseek-ai/schemastery'

/** Mark one schema field live-editable; older schemastery builds lack the modifier. */
function live(field) {
  return typeof field.volatile === 'function' ? field.volatile() : field
}

export const Config = z.object({
  provider: live(
    z
      .string()
      .default('deepseek-official')
      .description('模型提供方路由，通常保持 deepseek-official'),
  ),
  model: live(
    z
      .string()
      .default('deepseek-flash')
      .description('生成与评估使用的模型 id，需与提供方路由匹配'),
  ),
  temperature: live(
    z
      .number()
      .min(0)
      .max(2)
      .step(0.1)
      .default(0)
      .description('采样温度；测试设计建议 0，可降低随机性但不保证重复生成一致'),
  ),
  maxTokens: live(
    z
      .number()
      .min(256)
      .max(65536)
      .step(1)
      .default(20000)
      .description('单次生成的最大输出 token；用例生成建议不低于 16000'),
  ),
  outputDir: live(
    z
      .string()
      .default('.aitestcase')
      .description('产物目录；相对路径按会话工作目录解析，也可填绝对路径'),
  ),
  saveArtifacts: live(
    z
      .boolean()
      .default(true)
      .description('是否把每次生成的结果落盘为独立 Markdown 文件'),
  ),
  historyRounds: live(
    z
      .number()
      .min(0)
      .max(10)
      .step(1)
      .default(4)
      .description('生成时回灌本会话前几轮结果做延续上下文；0 表示关闭'),
  ),
  maxInputChars: live(
    z
      .number()
      .min(1000)
      .max(200000)
      .step(1)
      .default(60000)
      .description('整次请求的上下文字符预算，包含系统模板、历史和本次输入；超出时裁剪或提示缩减'),
  ),
  historyShare: live(
    z
      .number()
      .min(0)
      .max(1)
      .step(0.05)
      .default(0.35)
      .description('剩余预算中允许历史上下文占用的比例（0–1），越小越省 token'),
  ),
  maxRetries: live(
    z
      .number()
      .min(0)
      .max(5)
      .step(1)
      .default(2)
      .description('单次模型调用的瞬时故障重试次数（限流、超时、5xx、空响应）；0 关闭重试'),
  ),
  retryBaseMs: live(
    z
      .number()
      .min(200)
      .max(10000)
      .step(100)
      .default(800)
      .description('重试退避基数（毫秒），按指数退避并叠加抖动'),
  ),
  jsonRepair: live(
    z
      .boolean()
      .default(true)
      .description('评审结果不是合法 JSON 时，追加一次最小修复调用；关闭则原样返回并标注'),
  ),
})
