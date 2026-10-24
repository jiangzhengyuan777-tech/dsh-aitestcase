// Evaluation-output JSON handling.
//
// The evaluator prompt asks for strict JSON, but a model occasionally wraps it in
// a code fence, prefixes a sentence, or leaves a trailing comma. A test engineer
// consuming the report programmatically needs a parseable value, so the plugin
// normalizes the answer and, when normalization fails, spends exactly one extra
// small call asking the model to repair its own output.
//
// Everything here is pure: no I/O, no model access, so it is unit-tested directly.

/**
 * Extract the first JSON object from a model answer.
 * Handles: a bare object, a fenced ```json block, prose around the object, and a
 * leading BOM. Returns `null` when nothing parses.
 * @param {string} text
 * @returns {object|null}
 */
export function extractJson(text) {
  const raw = String(text ?? '').replace(/^\uFEFF/, '').trim()
  if (!raw) return null

  const parsed = tryParseObject(raw)
  if (parsed) return parsed

  // Fenced block: ```json ... ``` or ``` ... ```
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) {
    const fenced = tryParseObject(fence[1].trim())
    if (fenced) return fenced
  }

  // Widest object span, which tolerates prose before/after the JSON.
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start >= 0 && end > start) {
    const sliced = tryParseObject(raw.slice(start, end + 1))
    if (sliced) return sliced
  }

  return null
}

function tryParseObject(candidate) {
  try {
    const value = JSON.parse(candidate)
    if (value && typeof value === 'object' && !Array.isArray(value)) return value
    return null
  } catch {
    return null
  }
}

/**
 * Build the one repair request used when the first answer did not parse.
 * @param {string} raw the unparseable answer
 * @returns {{ system: string, user: string }}
 */
export function buildRepairRequest(raw) {
  return {
    system:
      '你是 JSON 修复器。把用户给出的评估内容整理成一个严格合法的 JSON 对象。' +
      '只输出 JSON 本身：不要解释、不要前后缀、不要 Markdown 代码块标记。' +
      '保留原有字段与数值；缺失的字段不要凭空编造，可以省略。',
    user: `把下面的评估内容整理为严格 JSON 对象：\n\n${String(raw ?? '').slice(0, 20000)}`,
  }
}

/**
 * Normalize an evaluation answer.
 * @param {string} text raw model answer
 * @returns {{ parsed: object|null, body: string, repaired: boolean, valid: boolean }}
 *   `body` is the model-facing/artifact text: a clean fenced JSON block when
 *   parsing succeeded, otherwise the original answer plus a warning line.
 */
export function normalizeEvaluation(text) {
  const raw = String(text ?? '').trim()
  const parsed = extractJson(raw)
  if (parsed) {
    return {
      parsed,
      body: '```json\n' + JSON.stringify(parsed, null, 2) + '\n```',
      repaired: false,
      valid: true,
    }
  }
  return { parsed: null, body: raw, repaired: false, valid: false }
}

/**
 * Render a normalized body together with the repair outcome.
 * @param {{ parsed: object|null, body: string, valid: boolean }} normalized
 * @param {{ repaired?: boolean }} [options]
 * @returns {string}
 */
export function renderEvaluation(normalized, options = {}) {
  if (normalized.valid) {
    const note = options.repaired ? '> 原始输出不是合法 JSON，已通过一次修复调用整理（数值与字段保持原样）。\n\n' : ''
    return note + normalized.body
  }
  return (
    '> ⚠ 模型未返回合法 JSON，无法自动规范化；以下为原始输出，请人工核对结构。\n\n' + normalized.body
  )
}
