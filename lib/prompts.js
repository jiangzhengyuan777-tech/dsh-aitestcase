// Prompt asset loading and the tagged-input assembly that mirrors
// AITestCase's /api/ask pipeline (agent-server/agent_app/graphs/ask_graph.py).
//
// The upstream pipeline is small: system prompt = template file contents, user
// message = bracket-tagged segments. This module reproduces exactly that shape
// so the generated results stay comparable with the original backend.

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PROMPT_DIR = join(PLUGIN_ROOT, 'assets', 'prompts')

/** Asset file per logical template key. */
const TEMPLATE_FILES = {
  testprd: 'ask_testprd.md',
  testpoint: 'ask_testpoint.md',
  testcase_xmind: 'ask_testcase.md',
  testcase_table: 'ask_testcase_table.md',
  testcase_yaml: 'ask_testcase_yaml.md',
  critic: 'critic.md',
  evaluator: 'evaluator.md',
}

const cache = new Map()

/**
 * Load one prompt asset, cached for the life of the plugin fiber.
 * @param {string} key logical template key
 * @returns {string} template contents
 */
export function loadPrompt(key) {
  const cached = cache.get(key)
  if (cached !== undefined) return cached
  const file = TEMPLATE_FILES[key]
  if (!file) throw new Error(`未知的 prompt 资源: ${key}`)
  const text = readFileSync(join(PROMPT_DIR, file), 'utf8').trim()
  cache.set(key, text)
  return text
}

/** Drop the cache (HMR friendliness and tests). */
export function clearPromptCache() {
  cache.clear()
}

/** Resolve the template key for a testcase output format. */
export function testcaseTemplateKey(format) {
  switch (format) {
    case 'table':
      return 'testcase_table'
    case 'yaml':
      return 'testcase_yaml'
    case 'xmind':
    default:
      return 'testcase_xmind'
  }
}

function tagged(tag, body) {
  const text = String(body ?? '').trim()
  if (!text) return ''
  return `[${tag}]\n${text}\n[/${tag}]`
}

/**
 * Build the bracket-tagged user input for one generation request.
 * Mirrors ask_graph.py: main document tag + optional test points + instruction.
 * @param {{ type: string, requirement: string, testpoints?: string, instruction?: string }} input
 * @returns {string} user message text
 */
export function buildTaggedInput({ type, requirement, testpoints, instruction }) {
  const parts = []
  if (type === 'testprd') {
    parts.push(tagged('主PRD', requirement))
  } else {
    parts.push(tagged('优化后PRD', requirement))
    if (type === 'testcase') parts.push(tagged('测试点', testpoints))
  }
  parts.push(tagged('补充说明', instruction))
  const combined = parts.filter(Boolean).join('\n\n').trim()
  if (!combined) throw new Error('需求内容为空，无法生成')
  return combined
}

/**
 * Build the evaluator user prompt.
 * Mirrors agent_app/evaluator.py `_build_user_prompt`.
 * @param {{ prd?: string, testcases: string, reference?: string }} input
 * @returns {string} user message text
 */
export function buildEvaluatorInput({ prd, testcases, reference }) {
  const cases = String(testcases ?? '').trim()
  if (!cases) throw new Error('待评估的测试用例为空')
  const parts = []
  const prdText = String(prd ?? '').trim()
  if (prdText) parts.push(`## 【原始 PRD】\n\n${prdText}`)
  parts.push(`## 【待评审测试用例】\n\n${cases}`)
  const referenceText = String(reference ?? '').trim()
  if (referenceText) parts.push(`## 【参考规范和历史用例】\n\n${referenceText}`)
  parts.push('---')
  parts.push(
    '请对上述测试用例进行全面评估，找出所有漏测点、逻辑缺陷和质量问题。\n' +
      '输出严格的 JSON 格式评估报告（不要包含任何额外文本或 Markdown 代码块标记）。',
  )
  return parts.join('\n\n')
}

/**
 * Find the newest history entry whose type contains `keyword`.
 * @param {Array<{ type: string }>} entries
 * @param {string} keyword
 * @returns {{ entry: object, index: number }|null}
 */
export function latestOfType(entries, keyword) {
  if (!Array.isArray(entries)) return null
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (String(entry && entry.type ? entry.type : '').includes(keyword)) return { entry, index }
  }
  return null
}

/**
 * Build the continuity block appended to the system prompt. AITestCase keeps a
 * per-session message history; this plugin keeps the same continuity by folding
 * the prior generations of the session into the system prompt instead of
 * fabricating durable Session messages.
 *
 * The framing is deliberately explicit: without it the model tends to continue
 * the historic document (e.g. answering a test-case request with the previous
 * test-point document) instead of producing the newly requested artifact.
 *
 * When `maxChars` is given the block is fitted into it: whole entries are kept
 * newest-first while they fit, the newest entry is truncated when it alone is
 * oversized, and older entries are dropped. Dropped entries are simply omitted;
 * the caller reports the loss from its own accounting.
 *
 * @param {Array<{ type: string, at: string, text: string }>} entries
 * @param {number} rounds
 * @param {number} [maxChars] character cap for the whole returned block
 * @returns {string} appended block, or '' when there is nothing to add
 */
export function buildHistoryBlock(entries, rounds, maxChars) {
  if (!Array.isArray(entries) || entries.length === 0) return ''
  // <= 0 means "continuity disabled", not "use the default".
  if (!Number.isFinite(rounds) || rounds <= 0) return ''
  const limit = Math.floor(rounds)
  const recent = entries.slice(-limit)
  if (recent.length === 0) return ''

  const heading =
    '\n\n---\n\n## 本会话历史输出（仅供延续上下文，禁止原样复述）\n\n' +
    '> 以下是本会话此前的生成结果，只用于理解上下文、延续术语与编号。\n' +
    '> 本次必须严格按上面的系统提示词所要求的任务类型与输出格式，产出**新的完整结果**；' +
    '不要直接复述、续写或改写历史文档。\n\n'

  const budget = Number.isFinite(maxChars) ? Math.floor(maxChars) : Infinity
  if (budget <= 0) return ''

  const entryText = (entry) => `### 第 ${entry.index} 轮 · ${entry.type} · ${entry.at}\n\n${entry.text}`
  const prepared = recent.map((entry, offset) => ({
    index: offset + 1,
    type: entry.type,
    at: entry.at,
    text: String(entry.text ?? '').trim(),
  }))

  if (budget === Infinity) {
    return heading + prepared.map(entryText).join('\n\n')
  }

  // Fit newest-first; the first entry that does not fit is truncated only when
  // nothing newer has been kept yet (a single oversized newest entry), otherwise
  // it and everything older are dropped.
  const remainingForEntries = budget - heading.length
  if (remainingForEntries <= 0) return ''

  const kept = []
  let used = 0
  for (let index = prepared.length - 1; index >= 0; index -= 1) {
    const entry = prepared[index]
    const block = entryText(entry)
    const separator = kept.length > 0 ? 2 : 0
    if (used + separator + block.length <= remainingForEntries) {
      kept.unshift(block)
      used += separator + block.length
      continue
    }
    if (kept.length === 0) {
      const marker = '\n\n...（历史内容已截断）...'
      const room = remainingForEntries - separator - marker.length
      // Keep the entry's label even when almost nothing else fits.
      const labelOnly = entryText({ ...entry, text: '' }).length
      if (room > labelOnly + 40) {
        const textRoom = room - (block.length - entry.text.length)
        kept.unshift(entryText({ ...entry, text: entry.text.slice(0, Math.max(0, textRoom)) + marker }))
        used += separator + kept[0].length
      }
    }
    break
  }

  if (kept.length === 0) return ''
  return heading + kept.join('\n\n')
}

/** Export the asset directory for diagnostics. */
export function promptDir() {
  return PROMPT_DIR
}

/** Export the template file map for diagnostics. */
export function templateFiles() {
  return { ...TEMPLATE_FILES }
}
