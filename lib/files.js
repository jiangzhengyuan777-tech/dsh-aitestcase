// Practical file inputs for test engineers: PRDs and case exports usually live
// on disk, so the generation tools accept a path as an alternative to pasting
// the text into the conversation.

import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

const MAX_BYTES = 4 * 1024 * 1024

/**
 * Read a UTF-8 text file for a tool argument.
 * @param {string} path absolute path, or relative to the session working directory
 * @param {{ cwd?: string, label?: string }} options
 * @returns {{ text: string, path: string, bytes: number }}
 */
export function readTextFile(path, { cwd, label = '文件' } = {}) {
  const raw = String(path ?? '').trim()
  if (!raw) throw new Error(`${label}路径为空`)
  const absolute = isAbsolute(raw) ? raw : resolve(cwd || process.cwd(), raw)
  let stat
  try {
    stat = statSync(absolute)
  } catch {
    throw new Error(`${label}不存在或无法访问: ${absolute}`)
  }
  if (!stat.isFile()) throw new Error(`${label}不是一个文件: ${absolute}`)
  if (stat.size > MAX_BYTES) {
    throw new Error(`${label}过大（${Math.round(stat.size / 1024)} KB），上限 4 MB: ${absolute}`)
  }
  let text
  try {
    text = readFileSync(absolute, 'utf8')
  } catch (error) {
    throw new Error(`读取${label}失败: ${absolute} — ${error.message}`)
  }
  const trimmed = text.trim()
  if (!trimmed) throw new Error(`${label}内容为空: ${absolute}`)
  return { text: trimmed, path: absolute, bytes: stat.size }
}
