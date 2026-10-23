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
      .description('采样温度；测试设计建议 0，保证同一输入产出稳定'),
  ),
  maxTokens: live(
    z
      .number()
      .min(500)
      .max(65536)
      .step(500)
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
      .step(1000)
      .default(60000)
      .description('单次输入的字符上限，超出会被截断并在结果中注明'),
  ),
})
