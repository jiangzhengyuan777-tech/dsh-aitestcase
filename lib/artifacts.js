// Artifact persistence.
//
// Relative `outputDir` resolves against the Session working directory, which is
// read defensively from the opaque Session object (several accessors exist
// across harness versions, so each is probed by duck typing and the process cwd
// is the final fallback). Every generated result is written as its own markdown
// file so the output survives conversation compaction and can be edited by the
// normal file tools.

import { mkdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

/**
 * Best-effort Session working directory.
 * @param {object|undefined} exec tool run context
 * @returns {string} absolute directory candidated
 */
export function sessionCwd(exec) {
  const session = exec && exec.agent ? exec.agent.session : undefined
  const candidates = [
    session && session.cwd,
    session && session.meta && session.meta.cwd,
    session && session.header && session.header.cwd,
    session && session.creationMeta && session.creationMeta.cwd,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate
  }
  return process.cwd()
}

/**
 * Resolve the artifact directory for one call.
 * @param {object|undefined} exec
 * @param {string} configured configured outputDir (absolute or relative)
 * @returns {string} absolute directory
 */
export function resolveOutputDir(exec, configured) {
  const raw = typeof configured === 'string' && configured.trim() ? configured.trim() : '.aitestcase'
  return isAbsolute(raw) ? raw : resolve(sessionCwd(exec), raw)
}

/** Turn a generation type into a filesystem-safe slug. */
function slugOf(type) {
  return String(type ?? 'result')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'result'
}

/** Compact UTC timestamp suitable for a filename. */
function stamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')
}

/**
 * Write one artifact file.
 * @param {object|undefined} exec
 * @param {{ outputDir: string, type: string, content: string, now?: Date }} input
 * @returns {string|null} absolute path, or null when persisting failed
 */
export function saveArtifact(exec, { outputDir, type, content, now }) {
  try {
    const dir = resolveOutputDir(exec, outputDir)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${slugOf(type)}-${stamp(now ?? new Date())}.md`)
    writeFileSync(file, String(content ?? ''), 'utf8')
    return file
  } catch {
    return null
  }
}

/**
 * Render the report header shared by every tool result.
 * @param {{ label: string, model: string, entry?: { at: string }, usageLine?: string, artifactPath?: string|null, rounds?: number }} input
 * @returns {string}
 */
export function reportHeader({ label, model, entry, usageLine, artifactPath, rounds }) {
  const lines = [`【${label}】`, '', `模型: ${model}`]
  if (entry && entry.at) lines.push(`时间: ${entry.at}`)
  if (Number.isFinite(rounds) && rounds > 0) lines.push(`已参考本会话前 ${rounds} 轮结果`)
  if (usageLine) lines.push(`用量: ${usageLine}`)
  if (artifactPath) lines.push(`已保存: ${artifactPath}`)
  return lines.join('\n')
}
